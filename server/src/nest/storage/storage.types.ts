import type { Readable } from 'node:stream';

/**
 * The storage abstraction's contract surface (spec:
 * docs/superpowers/specs/2026-07-20-storage-backend-abstraction-design.md).
 *
 * S3 constraints are baked into the driver contract, not the implementation:
 * keys are opaque POSIX-style strings, no rename/append/partial writes, no
 * directory semantics. Adding a backend later means one driver file that
 * passes the contract suite (tests/unit/nest/storage/storage-driver.contract.ts)
 * — zero changes to controllers or services.
 */

export const STORAGE_CATEGORIES = [
  'files',
  'journey',
  'covers',
  'avatars',
  'places',
  'photos',
  'photos-google',
  'photos-trek',
  'backups',
] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export interface ObjectStat {
  key: string;
  size: number;
  mtimeMs: number;
}

/** Inclusive byte range, `fs.createReadStream` semantics; `end` omitted = to EOF. */
export interface ByteRange {
  start: number;
  end?: number;
}

/** Ignored by local drivers; a future S3 driver needs it for the PUT. */
export interface PutOptions {
  contentType?: string;
}

/**
 * A temp file whose OWNERSHIP transfers to `put()`: the driver moves or
 * consumes it (rename into place locally; upload-then-delete remotely).
 * Callers must not touch the path afterwards.
 */
export interface LocalTempFile {
  tmpPath: string;
}

export function isLocalTempFile(source: Readable | LocalTempFile): source is LocalTempFile {
  return typeof (source as LocalTempFile).tmpPath === 'string';
}

export interface StorageDriver {
  /** Backend instance name, e.g. 'uploads-local'. */
  readonly id: string;
  /** Atomic: spool + single rename locally; single/multipart PUT remotely. */
  put(key: string, source: Readable | LocalTempFile, opts?: PutOptions): Promise<void>;
  getStream(key: string, range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }>;
  stat(key: string): Promise<ObjectStat | null>;
  /** Idempotent; resolving on a missing key is success. */
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<ObjectStat>;
  /** Fast-path for local drivers; `null`/absent is exactly the remote-driver branch every caller must handle. */
  getLocalPath?(key: string): string | null;
  /** Same-filesystem spool dir (LocalDriver: `<root>/.tmp`), or null for drivers with no local filesystem. */
  getSpoolDir?(): string | null;
}

/**
 * Typed error set so route handlers map storage failures to their existing
 * bespoke envelopes without string-matching driver internals.
 */
export class StorageBackendError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageBackendError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`storage object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/** Serving slices map this to a miss (404/next()), never a 500. */
export class StorageInvalidKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid storage key: ${key}`);
    this.name = 'StorageInvalidKeyError';
  }
}
