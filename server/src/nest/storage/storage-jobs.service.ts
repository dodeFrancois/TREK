import { Injectable, Logger } from '@nestjs/common';
import { STORAGE_CATEGORIES, type StorageBackfillStatus } from '@trek/shared';
import { MirrorDriver } from './drivers/mirror.driver';
import { StorageRegistryService } from './storage-registry.service';

export class BackfillTargetError extends Error {}
export class BackfillBusyError extends Error {}

interface ActiveJob {
  status: StorageBackfillStatus;
  cancelled: boolean;
}

/**
 * One-at-a-time backfill registry (the ImportJobsService idiom, minus WS).
 * Finished statuses linger for ttlMs so a remounted panel can show the
 * outcome; the client polls the admin state while anything is running.
 */
@Injectable()
export class StorageJobsService {
  private readonly logger = new Logger(StorageJobsService.name);
  private readonly jobs = new Map<string, ActiveJob>();
  private ttlMs = 10 * 60_000;

  constructor(private readonly registry: StorageRegistryService) {}

  /** Test-only factory for a short TTL, since a second constructor param would confuse Nest DI. */
  static withTtl(registry: StorageRegistryService, ttlMs: number): StorageJobsService {
    const svc = new StorageJobsService(registry);
    svc.ttlMs = ttlMs;
    return svc;
  }

  startBackfill(mirrorName: string): void {
    // Resolve/validate the target first so an unknown/non-mirror name 404s
    // even while a sync is running — the busy check only applies once we
    // know there's a real mirror to be busy about.
    const snapshot = this.registry.snapshot();
    const categories = STORAGE_CATEGORIES.filter(
      (category) => snapshot.categories[category]?.backend === mirrorName,
    );
    if (categories.length === 0) {
      throw new BackfillTargetError(`'${mirrorName}' is not a mirror routed by any category`);
    }
    const resolved = categories.map((category) => this.registry.resolve(category));
    const driver = resolved[0]!.driver;
    if (!(driver instanceof MirrorDriver)) {
      throw new BackfillTargetError(`'${mirrorName}' is not a mirror backend`);
    }
    if ([...this.jobs.values()].some((job) => job.status.status === 'running')) {
      throw new BackfillBusyError('a sync is already running — one backfill at a time');
    }
    const prefixes = resolved.map((r) => r.keyPrefix);

    const job: ActiveJob = {
      cancelled: false,
      status: {
        backend: mirrorName,
        status: 'running',
        done: 0,
        total: 0,
        copied: 0,
        skipped: 0,
        failed: 0,
        startedAt: Date.now(),
      },
    };
    this.jobs.set(mirrorName, job);

    // Detached: the driver instances are resolved above, so a registry
    // reload() mid-run keeps this job on them (the in-flight guarantee).
    void driver
      .backfill(prefixes, {
        onProgress: (progress) => {
          job.status = { ...job.status, ...progress };
        },
        isCancelled: () => job.cancelled,
      })
      .then((result) => {
        job.status = {
          ...job.status,
          ...result,
          status: result.cancelled ? 'cancelled' : 'done',
          finishedAt: Date.now(),
        };
      })
      .catch((err: unknown) => {
        job.status = {
          ...job.status,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        };
        this.logger.error(`backfill '${mirrorName}' aborted: ${job.status.error}`);
      })
      .finally(() => {
        setTimeout(() => {
          if (this.jobs.get(mirrorName) === job && job.status.status !== 'running') this.jobs.delete(mirrorName);
        }, this.ttlMs).unref?.();
      });
  }

  cancelBackfill(mirrorName: string): boolean {
    const job = this.jobs.get(mirrorName);
    if (!job || job.status.status !== 'running') return false;
    job.cancelled = true;
    return true;
  }

  statuses(): StorageBackfillStatus[] {
    return [...this.jobs.values()].map((job) => ({ ...job.status }));
  }
}
