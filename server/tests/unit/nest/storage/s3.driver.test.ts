import { describe, it, expect, vi } from 'vitest';
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
