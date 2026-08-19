/// <reference types="@aws-lite/s3-types" />
import awsLite from '@aws-lite/client';
import type { Readable } from 'node:stream';
import { assertValidKey, assertValidPrefix, isValidKey } from '../storage-keys';
import {
  StorageBackendError,
  StorageNotFoundError,
  type ByteRange,
  type LocalTempFile,
  type ObjectStat,
  type PutOptions,
  type StorageDriver,
} from '../storage.types';

/**
 * S3-compatible driver over @aws-lite/client + @aws-lite/s3 (spec:
 * docs/superpowers/specs/2026-08-17-s3-storage-driver-design.md). The client
 * is a driver-internal detail — nothing outside this file imports aws-lite.
 * aws-lite exposes no request timeout or abort signal, so the driver owns the
 * deadline: per client call for single-request operations, inactivity-based
 * for multipart Upload (destroying the interposed PassThrough drives Upload's
 * own error path — in-flight parts drain, then AbortMultipartUpload fires).
 */

/** One multipart chunk (aws-lite Upload default) — also the peek threshold. */
export const MULTIPART_THRESHOLD = 10 * 1024 * 1024;

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  retries: number;
  keepAlive: boolean;
}

/** The S3 surface the driver consumes — structural, so tests inject a plain object. */
export interface S3Api {
  PutObject(input: Record<string, unknown>): Promise<unknown>;
  Upload(input: Record<string, unknown>): Promise<unknown>;
  GetObject(input: Record<string, unknown>): Promise<{
    Body?: Readable;
    ContentLength?: number;
    ContentRange?: string;
    LastModified?: Date;
  }>;
  HeadObject(input: Record<string, unknown>): Promise<{ ContentLength?: number; LastModified?: Date }>;
  DeleteObject(input: Record<string, unknown>): Promise<unknown>;
  ListObjectsV2(input: Record<string, unknown>): Promise<
    AsyncIterable<{ Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }> }>
  >;
}

// `Omit<S3ClientOptions, 'keepAlive'>` rather than a bare `S3ClientOptions &`:
// intersecting with the required `keepAlive: boolean` would make the
// `keepAlive?: boolean` below a no-op (TS keeps the property required when
// either side of an `&` requires it).
export type S3DriverOptions = Omit<S3ClientOptions, 'keepAlive'> & {
  id: string;
  bucket: string;
  keyPrefix: string;
  timeoutMs: number;
  keepAlive?: boolean;
  clientFactory?: (opts: S3ClientOptions) => Promise<S3Api>;
};

/** Bare GetObject content-sniffs; streamResponsePayload is mandatory (spec, Client). */
export async function defaultClientFactory(opts: S3ClientOptions): Promise<S3Api> {
  const client = await awsLite({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    endpoint: opts.endpoint,
    retries: opts.retries,
    keepAlive: opts.keepAlive,
    plugins: [await import('@aws-lite/s3')],
  });
  // The `/// <reference types="@aws-lite/s3-types" />` above pulls in the
  // declaration-merged `AwsLiteClient.S3` (https://aws-lite.org/using-typescript),
  // so `client.S3` itself needs no cast. This one narrow cast remains because
  // of a genuine structural mismatch: the real PutObject/Upload signatures
  // require `Bucket`/`Key` (plus other required fields), which S3Api's
  // deliberately permissive `Record<string, unknown>` input can't guarantee —
  // method-syntax parameter bivariance still rejects that narrowing. This is
  // the one sanctioned `as unknown as` boundary; no other cast in this file.
  return client.S3 as unknown as S3Api;
}

function statusCode(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
/** aws-lite 404s: statusCode 404, code 'NoSuchKey' (GetObject) or 'NotFound' (HeadObject, bodiless). */
function isNotFound(err: unknown): boolean {
  const code = errorCode(err);
  return statusCode(err) === 404 || code === 'NoSuchKey' || code === 'NotFound';
}

export class S3Driver implements StorageDriver {
  readonly id: string;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly timeoutMs: number;
  private readonly clientOptions: S3ClientOptions;
  private readonly clientFactory: (opts: S3ClientOptions) => Promise<S3Api>;
  private clientPromise: Promise<S3Api> | null = null;

  constructor(opts: S3DriverOptions) {
    this.id = opts.id;
    this.bucket = opts.bucket;
    this.keyPrefix = normalizeKeyPrefix(opts.keyPrefix);
    this.timeoutMs = opts.timeoutMs;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.clientOptions = {
      endpoint: opts.endpoint,
      region: opts.region,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      retries: opts.retries,
      keepAlive: opts.keepAlive ?? true,
    };
  }

  /** No local filesystem — callers fall back to storage.tempDir(). */
  getSpoolDir(): null {
    return null;
  }

  async put(_key: string, _source: Readable | LocalTempFile, _opts?: PutOptions): Promise<void> {
    throw new StorageBackendError('not implemented');
  }

  async getStream(key: string, range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }> {
    assertValidKey(key);
    const s3 = await this.client();
    const params: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: this.keyPrefix + key,
      // Mandatory: a bare GetObject content-sniffs and parses JSON/XML bodies.
      streamResponsePayload: true,
    };
    if (range) params.Range = `bytes=${range.start}-${range.end ?? ''}`;
    let res;
    try {
      // Deadline covers time-to-headers; body streaming is never deadlined.
      res = await this.deadlined(s3.GetObject(params), `get '${key}'`);
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw this.wrap(err, `get failed for '${key}'`);
    }
    if (!res.Body) throw new StorageBackendError(`get returned no body for '${key}' on '${this.id}'`);
    // LocalDriver parity: on a ranged read the stat is the FULL object's —
    // total from the 206 Content-Range, never the ranged ContentLength.
    const size = range ? totalFromContentRange(res.ContentRange, key, this.id) : (res.ContentLength ?? 0);
    return { stream: res.Body, stat: { key, size, mtimeMs: res.LastModified?.getTime() ?? 0 } };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    const s3 = await this.client();
    try {
      const res = await this.deadlined(s3.HeadObject({ Bucket: this.bucket, Key: this.keyPrefix + key }), `stat '${key}'`);
      return { key, size: res.ContentLength ?? 0, mtimeMs: res.LastModified?.getTime() ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw this.wrap(err, `stat failed for '${key}'`);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const s3 = await this.client();
    try {
      await this.deadlined(s3.DeleteObject({ Bucket: this.bucket, Key: this.keyPrefix + key }), `delete '${key}'`);
    } catch (err) {
      if (isNotFound(err)) return; // idempotent — S3 204s on missing keys; some compatibles 404
      throw this.wrap(err, `delete failed for '${key}'`);
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    assertValidPrefix(prefix);
    const s3 = await this.client();
    let pages: AsyncIterable<{ Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }> }>;
    try {
      pages = await this.deadlined(
        s3.ListObjectsV2({ Bucket: this.bucket, Prefix: this.keyPrefix + prefix, paginate: 'iterator' }),
        `list '${prefix}'`,
      );
    } catch (err) {
      throw this.wrap(err, `list failed under '${prefix}'`);
    }
    const it = pages[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<{ Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }> }>;
      try {
        // Per-page deadline (each iteration is one ListObjectsV2 request).
        next = await this.deadlined(it.next(), `list '${prefix}'`);
      } catch (err) {
        throw this.wrap(err, `list failed under '${prefix}'`);
      }
      if (next.done) return;
      for (const obj of next.value.Contents ?? []) {
        const objectKey = obj.Key ?? '';
        if (!objectKey.startsWith(this.keyPrefix)) continue; // out-of-band write outside our namespace
        const key = objectKey.slice(this.keyPrefix.length);
        // Defensive parity with LocalDriver's dotfile skip: such keys can only
        // exist from out-of-band writes; serving/sweeps must never see them.
        if (!isValidKey(key)) continue;
        yield { key, size: obj.Size ?? 0, mtimeMs: obj.LastModified?.getTime() ?? 0 };
      }
    }
  }

  private client(): Promise<S3Api> {
    // Cached across calls; a failed init clears the cache so the next call retries.
    this.clientPromise ??= this.clientFactory(this.clientOptions).catch((err) => {
      this.clientPromise = null;
      throw new StorageBackendError(`s3 client init failed on '${this.id}'`, err);
    });
    return this.clientPromise;
  }

  private deadlined<T>(op: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        // Cannot abort the socket (aws-lite has no signal) — the call is
        // rejected and a hung request lingers until the socket dies.
        () => reject(new StorageBackendError(`${what} timed out after ${this.timeoutMs}ms on '${this.id}'`)),
        this.timeoutMs,
      );
      timer.unref?.();
    });
    return Promise.race([op, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  private wrap(err: unknown, message: string): Error {
    if (err instanceof StorageBackendError || err instanceof StorageNotFoundError) return err;
    return new StorageBackendError(`${message} on '${this.id}'`, err);
  }
}

/**
 * '' stays ''; anything else becomes one or more slash-joined segments with a
 * trailing slash, or throws StorageInvalidKeyError. app-config/env.ts's
 * s3Preconditions validates the same slash-stripped shape at boot — keep the
 * two strip-regexes identical (`/^\/+|\/+$/g`).
 */
function normalizeKeyPrefix(raw: string): string {
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  assertValidPrefix(`${trimmed}/`);
  return `${trimmed}/`;
}

/** 'bytes 2-5/10' → 10. A 206 without a parseable total is a backend defect. */
function totalFromContentRange(contentRange: string | undefined, key: string, id: string): number {
  const total = contentRange?.match(/\/(\d+)$/)?.[1];
  if (total === undefined) {
    throw new StorageBackendError(`ranged get for '${key}' on '${id}' returned no Content-Range total`);
  }
  return Number(total);
}
