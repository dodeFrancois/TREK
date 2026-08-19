import awsLite from '@aws-lite/client';
import type { Readable } from 'node:stream';
import { assertValidKey, assertValidPrefix } from '../storage-keys';
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
  // AwsLiteClient's ambient .S3 augmentation (@aws-lite/s3-types) isn't picked
  // up by tsc without an explicit reference, so this is the one sanctioned
  // `as unknown as` boundary — no other cast in this file.
  const client = (await awsLite({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    endpoint: opts.endpoint,
    retries: opts.retries,
    keepAlive: opts.keepAlive,
    plugins: [await import('@aws-lite/s3')],
  })) as unknown as { S3: S3Api };
  return client.S3;
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

  async getStream(_key: string, _range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }> {
    throw new StorageBackendError('not implemented');
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

  list(_prefix: string): AsyncIterable<ObjectStat> {
    throw new StorageBackendError('not implemented');
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
