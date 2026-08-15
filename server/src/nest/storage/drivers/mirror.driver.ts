import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { assertValidKey, assertValidPrefix } from '../storage-keys';
import {
  isLocalTempFile,
  StorageInvalidKeyError,
  StorageNotFoundError,
  type ByteRange,
  type LocalTempFile,
  type ObjectStat,
  type PutOptions,
  type StorageDriver,
} from '../storage.types';

export interface ReplicaFailure {
  backend: string;
  key: string;
  op: 'put' | 'delete';
  error: string;
  at: number;
}

/**
 * Composite backend: one primary (source of truth) plus best-effort replicas.
 * Runs entirely over the driver interface — the second in-tree consumer of
 * the contract suite. Only the `backups` category may be assigned a mirror
 * (registry validation enforces it).
 *
 * Writes hit the primary first and must succeed; replica failures are
 * reported through `onReplicaFailure` (surfaced as health status), never
 * thrown. Reads fall back to replicas only when the primary ERRORS — a plain
 * miss stays a miss, replicas are copies, not a search path.
 */
export class MirrorDriver implements StorageDriver {
  readonly id: string;
  private readonly primary: StorageDriver;
  private readonly replicas: readonly StorageDriver[];
  private readonly tempDir: () => string;
  private readonly onReplicaFailure?: (failure: ReplicaFailure) => void;

  constructor(opts: {
    id: string;
    primary: StorageDriver;
    replicas: StorageDriver[];
    /** Global scratch dir (data/tmp) — mirrors have no same-volume spool of their own. */
    tempDir: () => string;
    onReplicaFailure?: (failure: ReplicaFailure) => void;
  }) {
    this.id = opts.id;
    this.primary = opts.primary;
    this.replicas = [...opts.replicas];
    this.tempDir = opts.tempDir;
    this.onReplicaFailure = opts.onReplicaFailure;
  }

  getSpoolDir(): null {
    return null; // callers fall back to storage.tempDir()
  }

  getLocalPath(key: string): string | null {
    assertValidKey(key);
    return this.primary.getLocalPath?.(key) ?? null;
  }

  async put(key: string, source: Readable | LocalTempFile, opts?: PutOptions): Promise<void> {
    assertValidKey(key);
    // A Readable can only be consumed once, so materialize the source as a
    // local file (stream → spool under tempDir(); temp-file sources as-is),
    // then feed each target its own stream: the bytes survive the primary
    // write for the replicas, and every child put stays atomic.
    let file: string;
    if (isLocalTempFile(source)) {
      file = source.tmpPath;
    } else {
      file = path.join(this.tempDir(), randomUUID());
      try {
        await pipeline(source, fs.createWriteStream(file));
      } catch (err) {
        await fs.promises.rm(file, { force: true });
        throw err;
      }
    }
    try {
      await this.primary.put(key, fs.createReadStream(file), opts);
      for (const replica of this.replicas) {
        try {
          await replica.put(key, fs.createReadStream(file), opts);
        } catch (err) {
          this.reportReplicaFailure(replica.id, key, 'put', err);
        }
      }
    } finally {
      // Ownership of LocalTempFile sources transferred to us — consume it.
      await fs.promises.rm(file, { force: true });
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }> {
    assertValidKey(key);
    try {
      return await this.primary.getStream(key, range);
    } catch (err) {
      if (!shouldFallback(err)) throw err;
      return this.fromReplicas((replica) => replica.getStream(key, range), err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    try {
      return await this.primary.stat(key);
    } catch (err) {
      if (!shouldFallback(err)) throw err;
      return this.fromReplicas((replica) => replica.stat(key), err);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.primary.delete(key); // hard primary failures propagate
    for (const replica of this.replicas) {
      try {
        await replica.delete(key);
      } catch (err) {
        this.reportReplicaFailure(replica.id, key, 'delete', err);
      }
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    assertValidPrefix(prefix);
    let yieldedAny = false;
    try {
      for await (const stat of this.primary.list(prefix)) {
        yieldedAny = true;
        yield stat;
      }
      return;
    } catch (err) {
      // Once items have been handed out, switching sources mid-stream would
      // duplicate or drop keys — only an up-front primary failure falls back.
      if (yieldedAny || !shouldFallback(err)) throw err;
      for (const replica of this.replicas) {
        try {
          for await (const stat of replica.list(prefix)) yield stat;
          return;
        } catch {
          /* try next replica */
        }
      }
      throw err;
    }
  }

  private async fromReplicas<T>(fn: (replica: StorageDriver) => Promise<T>, primaryErr: unknown): Promise<T> {
    for (const replica of this.replicas) {
      try {
        return await fn(replica);
      } catch {
        /* try next replica */
      }
    }
    throw primaryErr;
  }

  private reportReplicaFailure(backend: string, key: string, op: 'put' | 'delete', err: unknown): void {
    this.onReplicaFailure?.({
      backend,
      key,
      op,
      error: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    });
  }
}

/** Fall back only on real errors — never on a miss (or a bad key, which is deterministic). */
function shouldFallback(err: unknown): boolean {
  return !(err instanceof StorageNotFoundError || err instanceof StorageInvalidKeyError);
}
