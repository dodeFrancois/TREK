import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  S3Driver,
  MULTIPART_THRESHOLD,
  defaultClientFactory,
  type S3Api,
  type S3DriverOptions,
} from '../../../../src/nest/storage/drivers/s3.driver';
import {
  StorageBackendError,
  StorageInvalidKeyError,
  StorageNotFoundError,
} from '../../../../src/nest/storage/storage.types';

/** Mock client: every method rejects unless a test overrides it. */
function makeMockApi(overrides: Partial<S3Api> = {}): S3Api {
  const unexpected = (name: string) => vi.fn().mockRejectedValue(new Error(`unexpected ${name}`));
  return {
    PutObject: unexpected('PutObject'),
    Upload: unexpected('Upload'),
    GetObject: unexpected('GetObject'),
    HeadObject: unexpected('HeadObject'),
    DeleteObject: unexpected('DeleteObject'),
    ListObjectsV2: unexpected('ListObjectsV2'),
    ...overrides,
  } as S3Api;
}

function makeDriver(api: S3Api, opts: Partial<S3DriverOptions> = {}): S3Driver {
  return new S3Driver({
    id: 's3-test',
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    bucket: 'trek',
    keyPrefix: '',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    retries: 1,
    timeoutMs: 200,
    clientFactory: async () => api,
    ...opts,
  });
}

/** aws-lite error shape: real Error + statusCode/code metadata. */
function awsError(statusCode: number | undefined, code?: string): Error {
  const err = new Error(`@aws-lite/client: S3: ${code ?? 'boom'}`) as Error & {
    statusCode?: number;
    code?: string;
  };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

describe('S3Driver construction', () => {
  it('normalizes the key prefix to "" or "segments/" form', async () => {
    const api = makeMockApi({ HeadObject: vi.fn().mockResolvedValue({ ContentLength: 1, LastModified: new Date(1000) }) });
    await makeDriver(api, { keyPrefix: '/trek/prod/' }).stat('a/x.bin');
    expect(api.HeadObject).toHaveBeenCalledWith(expect.objectContaining({ Key: 'trek/prod/a/x.bin' }));
  });
  it('rejects an invalid key prefix at construction', () => {
    expect(() => makeDriver(makeMockApi(), { keyPrefix: '../evil' })).toThrow(StorageInvalidKeyError);
  });
  it('makes no client call at construction (boot must not touch the network)', () => {
    const factory = vi.fn();
    void new S3Driver({
      id: 's3-test', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'trek',
      keyPrefix: '', accessKeyId: 'ak', secretAccessKey: 'sk', retries: 1, timeoutMs: 200,
      clientFactory: factory,
    });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('S3Driver stat/delete', () => {
  it('maps HeadObject to ObjectStat', async () => {
    const api = makeMockApi({ HeadObject: vi.fn().mockResolvedValue({ ContentLength: 42, LastModified: new Date(5000) }) });
    expect(await makeDriver(api).stat('a/x.bin')).toEqual({ key: 'a/x.bin', size: 42, mtimeMs: 5000 });
  });
  it('stats a 404/NotFound as null', async () => {
    const api = makeMockApi({ HeadObject: vi.fn().mockRejectedValue(awsError(404, 'NotFound')) });
    expect(await makeDriver(api).stat('a/x.bin')).toBeNull();
  });
  it('wraps network errors (no statusCode) in StorageBackendError with cause', async () => {
    const cause = awsError(undefined);
    const api = makeMockApi({ HeadObject: vi.fn().mockRejectedValue(cause) });
    await expect(makeDriver(api).stat('a/x.bin')).rejects.toMatchObject({
      name: 'StorageBackendError',
      cause,
    });
  });
  it('deletes idempotently — a 404 resolves', async () => {
    const api = makeMockApi({ DeleteObject: vi.fn().mockRejectedValue(awsError(404, 'NoSuchKey')) });
    await expect(makeDriver(api).delete('a/x.bin')).resolves.toBeUndefined();
  });
  it('validates keys before any client call', async () => {
    const api = makeMockApi();
    const driver = makeDriver(api);
    for (const bad of ['../x', '/abs', 'a\\b', '.tmp/x']) {
      await expect(driver.stat(bad)).rejects.toBeInstanceOf(StorageInvalidKeyError);
      await expect(driver.delete(bad)).rejects.toBeInstanceOf(StorageInvalidKeyError);
    }
    expect(api.HeadObject).not.toHaveBeenCalled();
    expect(api.DeleteObject).not.toHaveBeenCalled();
  });
  it('expires a hung call after timeoutMs with StorageBackendError', async () => {
    const api = makeMockApi({ HeadObject: vi.fn().mockReturnValue(new Promise(() => {})) });
    await expect(makeDriver(api, { timeoutMs: 50 }).stat('a/x.bin')).rejects.toBeInstanceOf(StorageBackendError);
  });
  it('caches the client across calls and retries a failed factory', async () => {
    const api = makeMockApi({ HeadObject: vi.fn().mockResolvedValue({ ContentLength: 1, LastModified: new Date(0) }) });
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('init boom'))
      .mockResolvedValue(api);
    const driver = makeDriver(api, { clientFactory: factory });
    await expect(driver.stat('a/x.bin')).rejects.toBeInstanceOf(StorageBackendError);
    await driver.stat('a/x.bin'); // second call retries the factory
    await driver.stat('a/x.bin');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('S3Driver getStream', () => {
  it('streams the body with streamResponsePayload and returns the stat', async () => {
    const api = makeMockApi({
      GetObject: vi.fn().mockResolvedValue({
        Body: Readable.from('hello'),
        ContentLength: 5,
        LastModified: new Date(7000),
      }),
    });
    const { stream, stat } = await makeDriver(api).getStream('a/x.bin');
    expect((await drain(stream)).toString()).toBe('hello');
    expect(stat).toEqual({ key: 'a/x.bin', size: 5, mtimeMs: 7000 });
    expect(api.GetObject).toHaveBeenCalledWith(
      expect.objectContaining({ Key: 'a/x.bin', streamResponsePayload: true }),
    );
    expect((api.GetObject as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('Range');
  });
  it('formats closed and open-ended ranges and returns the FULL-object stat from Content-Range', async () => {
    const api = makeMockApi({
      GetObject: vi.fn().mockResolvedValue({
        Body: Readable.from('2345'),
        ContentLength: 4, // the RANGE length — must not become stat.size
        ContentRange: 'bytes 2-5/10',
        LastModified: new Date(7000),
      }),
    });
    const { stat } = await makeDriver(api).getStream('a/x.bin', { start: 2, end: 5 });
    expect(stat.size).toBe(10);
    expect(api.GetObject).toHaveBeenCalledWith(expect.objectContaining({ Range: 'bytes=2-5' }));

    await makeDriver(api).getStream('a/x.bin', { start: 7 });
    expect(api.GetObject).toHaveBeenLastCalledWith(expect.objectContaining({ Range: 'bytes=7-' }));
  });
  it('maps 404/NoSuchKey to StorageNotFoundError', async () => {
    const api = makeMockApi({ GetObject: vi.fn().mockRejectedValue(awsError(404, 'NoSuchKey')) });
    await expect(makeDriver(api).getStream('a/x.bin')).rejects.toBeInstanceOf(StorageNotFoundError);
  });
  it('rejects a missing Body as StorageBackendError (never a bare undefined stream)', async () => {
    const api = makeMockApi({ GetObject: vi.fn().mockResolvedValue({ ContentLength: 5 }) });
    await expect(makeDriver(api).getStream('a/x.bin')).rejects.toBeInstanceOf(StorageBackendError);
  });
});

describe('S3Driver list', () => {
  function pages(...pageContents: Array<Array<{ Key: string; Size: number; LastModified: Date }>>) {
    return vi.fn().mockResolvedValue(
      (async function* () {
        for (const Contents of pageContents) yield { Contents };
      })(),
    );
  }
  it('paginates with the iterator, strips the keyPrefix, and requests the combined prefix', async () => {
    const api = makeMockApi({
      ListObjectsV2: pages(
        [{ Key: 'trek/prod/a/one.bin', Size: 2, LastModified: new Date(1000) }],
        [{ Key: 'trek/prod/a/sub/two.bin', Size: 3, LastModified: new Date(2000) }],
      ),
    });
    const out = [];
    for await (const stat of makeDriver(api, { keyPrefix: 'trek/prod' }).list('a/')) out.push(stat);
    expect(out).toEqual([
      { key: 'a/one.bin', size: 2, mtimeMs: 1000 },
      { key: 'a/sub/two.bin', size: 3, mtimeMs: 2000 },
    ]);
    expect(api.ListObjectsV2).toHaveBeenCalledWith(
      expect.objectContaining({ Prefix: 'trek/prod/a/', paginate: 'iterator' }),
    );
  });
  it('skips keys with dot-segments and keys outside the keyPrefix (out-of-band writes)', async () => {
    const api = makeMockApi({
      ListObjectsV2: pages([
        { Key: 'trek/prod/a/ok.bin', Size: 1, LastModified: new Date(0) },
        { Key: 'trek/prod/.tmp/junk', Size: 1, LastModified: new Date(0) },
        { Key: 'trek/prod/a/.hidden', Size: 1, LastModified: new Date(0) },
        { Key: 'elsewhere/x.bin', Size: 1, LastModified: new Date(0) },
      ]),
    });
    const out = [];
    for await (const stat of makeDriver(api, { keyPrefix: 'trek/prod' }).list('')) out.push(stat);
    expect(out.map((s) => s.key)).toEqual(['a/ok.bin']);
  });
  it('yields nothing for an empty result and validates the prefix first', async () => {
    const api = makeMockApi({ ListObjectsV2: pages([]) });
    const driver = makeDriver(api);
    const out = [];
    for await (const stat of driver.list('a/')) out.push(stat);
    expect(out).toEqual([]);
    await expect(async () => {
      for await (const s of driver.list('../x')) void s;
    }).rejects.toBeInstanceOf(StorageInvalidKeyError);
  });
});

describe('defaultClientFactory', () => {
  it('builds a real aws-lite client exposing the S3 surface (no network at init)', async () => {
    const s3 = await defaultClientFactory({
      endpoint: 'http://127.0.0.1:1', region: 'us-east-1',
      accessKeyId: 'ak', secretAccessKey: 'sk', retries: 0, keepAlive: false,
    });
    for (const method of ['PutObject', 'Upload', 'GetObject', 'HeadObject', 'DeleteObject', 'ListObjectsV2'] as const) {
      expect(typeof s3[method]).toBe('function');
    }
  });
});
