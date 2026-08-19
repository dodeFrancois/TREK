import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';

// ── DB setup (the permissions.service.test.ts pattern: real in-memory SQLite
// so the app_settings SQL is exercised faithfully) ────────────────────────────

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return { testDb: db, dbMock: { db, closeDb: () => {}, reinitialize: () => {} } };
});

vi.mock('../../../../src/db/database', () => dbMock);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTables } from '../../../../src/db/schema';
import { runMigrations } from '../../../../src/db/migrations';
import { DatabaseService } from '../../../../src/nest/database/database.service';
import type { RuntimeEnvService } from '../../../../src/nest/app-config/runtime-env.service';
import type { deriveS3 } from '../../../../src/app-config/derive';
import { StorageRegistryService } from '../../../../src/nest/storage/storage-registry.service';
import { LocalDriver } from '../../../../src/nest/storage/drivers/local.driver';
import { MirrorDriver, type ReplicaFailure } from '../../../../src/nest/storage/drivers/mirror.driver';
import { S3Driver } from '../../../../src/nest/storage/drivers/s3.driver';
import { GLOBAL_TEMP_DIR, DEFAULT_BACKUPS_ROOT } from '../../../../src/nest/storage/storage-paths';
import { STORAGE_CATEGORIES } from '../../../../src/nest/storage/storage.types';

const db = new DatabaseService(testDb);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-registry-'));
  tmpDirs.push(dir);
  return dir;
}

interface EnvPaths {
  uploadsDir?: string;
  placePhotoDir?: string;
}

type EnvS3 = ReturnType<typeof deriveS3>;
const S3_OFF: EnvS3 = {
  configured: false,
  endpoint: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  region: 'us-east-1',
  keyPrefix: '',
  retries: 1,
  timeoutMs: 30000,
};
const S3_ON: EnvS3 = {
  ...S3_OFF,
  configured: true,
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'trek',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
};

function makeEnvStub(
  initial: EnvPaths,
  s3: EnvS3 = S3_OFF,
): { env: RuntimeEnvService; setPaths: (p: EnvPaths) => void } {
  let paths = initial;
  return {
    env: { env: () => ({ paths, s3 }) } as unknown as RuntimeEnvService,
    setPaths: (p) => {
      paths = p;
    },
  };
}

function setSetting(key: string, value: string): void {
  testDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

/** Registry rooted in a fresh temp uploads dir; boots unless told not to. */
function makeRegistry(paths?: EnvPaths, opts: { boot?: boolean; s3?: EnvS3 } = {}) {
  const uploadsRoot = paths?.uploadsDir ?? makeTmpDir();
  const stub = makeEnvStub({ uploadsDir: uploadsRoot, placePhotoDir: paths?.placePhotoDir }, opts.s3);
  const registry = new StorageRegistryService(db, stub.env);
  if (opts.boot !== false) registry.onModuleInit();
  return { registry, uploadsRoot, setPaths: stub.setPaths };
}

beforeEach(() => {
  testDb.prepare("DELETE FROM app_settings WHERE key LIKE 'storage.%'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ── defaults ──────────────────────────────────────────────────────────────────

describe('StorageRegistryService defaults', () => {
  it('resolves every category with the built-in defaults and no settings rows', () => {
    const { registry, uploadsRoot } = makeRegistry();

    for (const category of STORAGE_CATEGORIES) {
      expect(registry.resolve(category)).toBeDefined();
    }

    const files = registry.resolve('files');
    expect(files.backendName).toBe('uploads-local');
    expect(files.keyPrefix).toBe('files/');
    expect(files.driver).toBeInstanceOf(LocalDriver);
    expect(files.driver.getLocalPath!('files/x.pdf')).toBe(path.join(fs.realpathSync(uploadsRoot), 'files/x.pdf'));

    // backups: bare keys, root IS the backups dir (spec rev 3.1)
    const backups = registry.resolve('backups');
    expect(backups.backendName).toBe('backups-local');
    expect(backups.keyPrefix).toBe('');
    expect(backups.driver.getLocalPath!('backup-1.zip')).toBe(path.join(fs.realpathSync(DEFAULT_BACKUPS_ROOT), 'backup-1.zip'));

    // photos-google without TREK_PLACE_PHOTO_DIR: today's layout under uploads
    const googlePhotos = registry.resolve('photos-google');
    expect(googlePhotos.backendName).toBe('uploads-local');
    expect(googlePhotos.keyPrefix).toBe('photos/google/');
  });

  it('honors TREK_PLACE_PHOTO_DIR via the conditional third backend (mode B: bare keys)', () => {
    const photoDir = makeTmpDir();
    const { registry } = makeRegistry({ placePhotoDir: photoDir });

    const googlePhotos = registry.resolve('photos-google');
    expect(googlePhotos.backendName).toBe('place-photos-local');
    expect(googlePhotos.keyPrefix).toBe('');
    expect(googlePhotos.driver.getLocalPath!('abc.jpg')).toBe(path.join(fs.realpathSync(photoDir), 'abc.jpg'));

    // Everything else stays on uploads-local, unchanged.
    expect(registry.resolve('photos-trek').backendName).toBe('uploads-local');
    expect(registry.resolve('photos-trek').keyPrefix).toBe('photos/trek/');
  });

  it('creates roots, spools, category prefix dirs, and the global temp dir on load', () => {
    const { uploadsRoot } = makeRegistry();

    for (const sub of ['.tmp', 'files', 'journey', 'covers', 'avatars', 'places', 'photos', 'photos/trek', 'photos/google']) {
      expect(fs.statSync(path.join(uploadsRoot, sub)).isDirectory()).toBe(true);
    }
    expect(fs.statSync(GLOBAL_TEMP_DIR).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(DEFAULT_BACKUPS_ROOT, '.tmp')).isDirectory()).toBe(true);
  });
});

// ── settings merge + validation ───────────────────────────────────────────────

describe('StorageRegistryService settings', () => {
  it('merges app_settings backends/categories over the defaults (backup mirror)', () => {
    const nasRoot = makeTmpDir();
    setSetting(
      'storage.backends',
      JSON.stringify([
        { name: 'nas-backups', type: 'local', options: { root: nasRoot } },
        { name: 'backup-mirror', type: 'mirror', options: { primary: 'backups-local', replicas: ['nas-backups'] } },
      ]),
    );
    setSetting('storage.categories', JSON.stringify({ backups: 'backup-mirror' }));

    const { registry } = makeRegistry();
    const backups = registry.resolve('backups');
    expect(backups.backendName).toBe('backup-mirror');
    expect(backups.keyPrefix).toBe('');
    expect(backups.driver).toBeInstanceOf(MirrorDriver);
    // untouched categories keep their defaults
    expect(registry.resolve('files').backendName).toBe('uploads-local');
  });

  it.each([
    ['unknown backend name in categories', undefined, JSON.stringify({ files: 'nope' })],
    [
      'mirror assigned to a non-backups category',
      JSON.stringify([
        { name: 'extra-local', type: 'local', options: { root: '/tmp/x' } },
        { name: 'm', type: 'mirror', options: { primary: 'uploads-local', replicas: ['extra-local'] } },
      ]),
      JSON.stringify({ files: 'm' }),
    ],
    [
      'nested mirror',
      JSON.stringify([
        { name: 'extra-local', type: 'local', options: { root: '/tmp/x' } },
        { name: 'm1', type: 'mirror', options: { primary: 'backups-local', replicas: ['extra-local'] } },
        { name: 'm2', type: 'mirror', options: { primary: 'm1', replicas: [] } },
      ]),
      JSON.stringify({ backups: 'm2' }),
    ],
    [
      'settings-declared s3 backend (env-only in v1)',
      JSON.stringify([{ name: 'x', type: 's3', options: {} }]),
      undefined,
    ],
    ['unknown category name', undefined, JSON.stringify({ 'not-a-category': 'uploads-local' })],
    ['malformed JSON', 'not json at all', undefined],
  ])('falls back to built-in defaults at boot on invalid settings: %s', (_label, backendsRow, categoriesRow) => {
    if (backendsRow !== undefined) setSetting('storage.backends', backendsRow);
    if (categoriesRow !== undefined) setSetting('storage.categories', categoriesRow);

    const { registry } = makeRegistry();
    expect(registry.resolve('files').backendName).toBe('uploads-local');
    expect(registry.resolve('backups').backendName).toBe('backups-local');
  });

  it('keeps the last-good config (not defaults) when a reload() sees invalid settings', () => {
    const nasRoot = makeTmpDir();
    setSetting(
      'storage.backends',
      JSON.stringify([
        { name: 'nas-backups', type: 'local', options: { root: nasRoot } },
        { name: 'backup-mirror', type: 'mirror', options: { primary: 'backups-local', replicas: ['nas-backups'] } },
      ]),
    );
    setSetting('storage.categories', JSON.stringify({ backups: 'backup-mirror' }));
    const { registry } = makeRegistry();
    expect(registry.resolve('backups').backendName).toBe('backup-mirror');

    setSetting('storage.categories', 'garbage {');
    registry.reload();

    // last-good, i.e. the mirror config — NOT the built-in defaults
    expect(registry.resolve('backups').backendName).toBe('backup-mirror');
  });
});

// ── reload semantics ──────────────────────────────────────────────────────────

describe('StorageRegistryService reload', () => {
  it('swaps the map atomically: new resolves see the new instance, held refs stay usable', async () => {
    const { registry, setPaths } = makeRegistry();
    const before = registry.resolve('files');
    await before.driver.put('files/pre-reload.bin', Readable.from('old root'));

    setPaths({ uploadsDir: makeTmpDir() });
    registry.reload();

    const after = registry.resolve('files');
    expect(after.driver).not.toBe(before.driver);
    expect(await after.driver.stat('files/pre-reload.bin')).toBeNull(); // new root is empty

    // in-flight semantics: the held old driver still serves reads
    const { stream } = await before.driver.getStream('files/pre-reload.bin');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('old root');
  });

  it('cleans spool leftovers at boot only, never on reload()', () => {
    const uploadsRoot = makeTmpDir();
    const stray = path.join(uploadsRoot, '.tmp', 'in-flight.part');

    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, 'crash leftover');
    // Aged past the reap gate: the boot sweep spares fresh entries (another
    // process may be spooling into the same tree — see LocalDriver.init).
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stray, old, old);
    const { registry } = makeRegistry({ uploadsDir: uploadsRoot });
    expect(fs.existsSync(stray)).toBe(false); // boot reclaimed it

    fs.writeFileSync(stray, 'in-flight upload');
    registry.reload();
    expect(fs.existsSync(stray)).toBe(true); // reload must not touch it
  });
});

// ── replica-failure health ────────────────────────────────────────────────────

describe('StorageRegistryService replica health', () => {
  it('keeps a bounded ring of replica failures (last 50)', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 60; i++) {
      registry.recordReplicaFailure({
        backend: 'nas-backups',
        key: `backup-${i}.zip`,
        op: 'put',
        error: 'disk full',
        at: i,
      } satisfies ReplicaFailure);
    }
    const failures = registry.replicaFailures();
    expect(failures).toHaveLength(50);
    expect(failures[0].key).toBe('backup-10.zip'); // oldest 10 dropped
    expect(failures[49].key).toBe('backup-59.zip');
  });
});

// ── s3-main (env-declared) ────────────────────────────────────────────────────

describe('s3-main (env-declared)', () => {
  it('appears only when TREK_S3_* is configured, with no category mapped to it', () => {
    const { registry } = makeRegistry({}, { s3: S3_ON });
    expect(() => registry.resolve('backups')).not.toThrow();
    for (const category of STORAGE_CATEGORIES) {
      expect(registry.resolve(category).backendName).not.toBe('s3-main');
    }
  });

  it('is absent when the env is unset (zero behavior change)', () => {
    setSetting('storage.categories', JSON.stringify({ backups: 's3-main' }));
    const { registry } = makeRegistry(); // S3_OFF
    // invalid mapping → last-good/defaults kept, per the standing mechanism
    expect(registry.resolve('backups').backendName).toBe('backups-local');
  });

  it('is assignable to any category via settings (S3Driver instance)', () => {
    setSetting('storage.categories', JSON.stringify({ covers: 's3-main' }));
    const { registry } = makeRegistry({}, { s3: S3_ON });
    const resolved = registry.resolve('covers');
    expect(resolved.backendName).toBe('s3-main');
    expect(resolved.driver).toBeInstanceOf(S3Driver);
    expect(resolved.keyPrefix).toBe('covers/');
  });

  it('serves as a mirror replica (local primary + s3 replica on backups)', () => {
    setSetting(
      'storage.backends',
      JSON.stringify([{ name: 'backup-mirror', type: 'mirror', options: { primary: 'backups-local', replicas: ['s3-main'] } }]),
    );
    setSetting('storage.categories', JSON.stringify({ backups: 'backup-mirror' }));
    const { registry } = makeRegistry({}, { s3: S3_ON });
    expect(registry.resolve('backups').backendName).toBe('backup-mirror');
  });

  it('rejects a settings-declared s3 backend with the intentional message', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    setSetting('storage.backends', JSON.stringify([{ name: 'rogue', type: 's3', options: {} }]));
    const { registry } = makeRegistry({}, { s3: S3_ON });
    expect(registry.resolve('backups').backendName).toBe('backups-local'); // defaults kept

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain("s3 backend 'rogue' cannot be declared in 'storage.backends'");
    expect(logged).toContain('env-declared only in v1');
    expect(logged).toContain('credentials never live in the database');
  });
});
