import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalDriver } from '../../../../src/nest/storage/drivers/local.driver';
import { MirrorDriver, type ReplicaFailure } from '../../../../src/nest/storage/drivers/mirror.driver';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-backfill-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeLocal(id: string): { driver: LocalDriver; root: string } {
  const root = makeTmpDir();
  const driver = new LocalDriver({ id, root });
  driver.init({ ensurePrefixes: [], cleanSpool: false });
  return { driver, root };
}

async function put(driver: LocalDriver, key: string, body: string): Promise<void> {
  await driver.put(key, Readable.from(body));
}

function makeMirror(primary: LocalDriver, replicas: LocalDriver[], onReplicaFailure?: (f: ReplicaFailure) => void): MirrorDriver {
  return new MirrorDriver({ id: 'm', primary, replicas, tempDir: () => makeTmpDir(), onReplicaFailure });
}

const HOOKS = { onProgress: () => undefined, isCancelled: () => false };

describe('MirrorDriver.backfill', () => {
  it('BKFL-001 copies missing objects to every replica, scoped to the given prefixes', async () => {
    const { driver: primary } = makeLocal('p');
    const { driver: replica, root: replicaRoot } = makeLocal('r');
    await put(primary, 'backups/a.zip', 'aaa');
    await put(primary, 'covers/skip.jpg', 'not in scope');
    const result = await makeMirror(primary, [replica]).backfill(['backups/'], HOOKS);
    expect(result).toMatchObject({ done: 1, total: 1, copied: 1, skipped: 0, failed: 0, cancelled: false });
    expect(fs.readFileSync(path.join(replicaRoot, 'backups/a.zip'), 'utf8')).toBe('aaa');
    expect(fs.existsSync(path.join(replicaRoot, 'covers/skip.jpg'))).toBe(false); // scope rule
  });

  it('BKFL-002 skips size-matched objects and re-copies size mismatches', async () => {
    const { driver: primary } = makeLocal('p');
    const { driver: replica, root: replicaRoot } = makeLocal('r');
    await put(primary, 'backups/same.zip', 'equal');
    await put(replica, 'backups/same.zip', 'eq2al'); // same size → skipped
    await put(primary, 'backups/diff.zip', 'longer-content');
    await put(replica, 'backups/diff.zip', 'short'); // size mismatch → re-copied
    const result = await makeMirror(primary, [replica]).backfill(['backups/'], HOOKS);
    expect(result).toMatchObject({ done: 2, copied: 1, skipped: 1, failed: 0 });
    expect(fs.readFileSync(path.join(replicaRoot, 'backups/diff.zip'), 'utf8')).toBe('longer-content');
    expect(fs.readFileSync(path.join(replicaRoot, 'backups/same.zip'), 'utf8')).toBe('eq2al'); // untouched
  });

  it('BKFL-003 a failing replica reports through the failure hook, counts failed, and the run continues', async () => {
    const { driver: primary } = makeLocal('p');
    const { driver: good, root: goodRoot } = makeLocal('good');
    const bad = {
      id: 'bad',
      stat: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error('replica on fire')),
    } as unknown as LocalDriver;
    const failures: ReplicaFailure[] = [];
    await put(primary, 'backups/a.zip', 'aaa');
    await put(primary, 'backups/b.zip', 'bbb');
    const result = await makeMirror(primary, [bad, good], (f) => failures.push(f)).backfill(['backups/'], HOOKS);
    expect(result).toMatchObject({ done: 2, copied: 2, failed: 2, cancelled: false }); // good got both; bad failed both
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ backend: 'bad', op: 'put' });
    expect(failures[0]!.error).toContain('replica on fire');
    expect(fs.existsSync(path.join(goodRoot, 'backups/b.zip'))).toBe(true);
  });

  it('BKFL-004 cancel stops after the in-flight key', async () => {
    const { driver: primary } = makeLocal('p');
    const { driver: replica } = makeLocal('r');
    for (let i = 0; i < 5; i++) await put(primary, `backups/${i}.zip`, `content-${i}`);
    let examined = 0;
    const hooks = {
      onProgress: (p: { done: number }) => {
        examined = p.done;
      },
      isCancelled: () => examined >= 2,
    };
    const result = await makeMirror(primary, [replica]).backfill(['backups/'], hooks);
    expect(result.cancelled).toBe(true);
    expect(result.done).toBeLessThan(5);
  });

  it('BKFL-005 a primary error aborts (propagates) instead of being swallowed', async () => {
    const { driver: replica } = makeLocal('r');
    const explodingPrimary = {
      id: 'p',
      list: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error('primary listing failed')),
          };
        },
      }),
    } as unknown as LocalDriver;
    await expect(makeMirror(explodingPrimary, [replica]).backfill(['backups/'], HOOKS)).rejects.toThrow(
      'primary listing failed',
    );
  });
});
