import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return { testDb: db, dbMock: { db, closeDb: () => {}, reinitialize: () => {} } };
});
vi.mock('../../../../src/db/database', () => dbMock);
vi.mock('../../../../src/config', () => ({ ENCRYPTION_KEY: 'storage-admin-test-key' }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASKED_SETTING_VALUE, type StorageConfig } from '@trek/shared';
import { createTables } from '../../../../src/db/schema';
import { runMigrations } from '../../../../src/db/migrations';
import { DatabaseService } from '../../../../src/nest/database/database.service';
import type { RuntimeEnvService } from '../../../../src/nest/app-config/runtime-env.service';
import { encrypt_api_key } from '../../../../src/nest/common/crypto/apiKeyCrypto';
import { StorageAdminService } from '../../../../src/nest/storage/storage-admin.service';
import { StorageRegistryService, BACKENDS_KEY, CATEGORIES_KEY } from '../../../../src/nest/storage/storage-registry.service';
import { StorageService } from '../../../../src/nest/storage/storage.service';

const db = new DatabaseService(testDb);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-storage-admin-'));
  tmpDirs.push(dir);
  return dir;
}
function setSetting(key: string, value: string): void {
  testDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}
function readRow(key: string): string | undefined {
  const row = testDb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

const S3_OPTIONS = {
  endpoint: 'http://127.0.0.1:9000',
  bucket: 'trek',
  accessKeyId: 'ak',
  secretAccessKey: 'sk-plain',
  region: 'us-east-1',
  keyPrefix: '',
  retries: 1,
  timeoutMs: 30000,
};

/** Real registry + real service over the in-memory DB; env stub toggles the key. */
function makeService(opts: { encryptionKeySet?: boolean; uploadsRoot?: string } = {}) {
  const uploadsRoot = opts.uploadsRoot ?? makeTmpDir();
  setSetting(BACKENDS_KEY, JSON.stringify([{ name: 'uploads-local', type: 'local', options: { root: uploadsRoot } }]));
  const env = {
    env: () => ({ paths: {}, security: { encryptionKeySet: opts.encryptionKeySet ?? true } }),
  } as unknown as RuntimeEnvService;
  const registry = new StorageRegistryService(db, env);
  registry.onModuleInit();
  const service = new StorageAdminService(db, registry, new StorageService(registry), env);
  return { service, registry, uploadsRoot };
}

/** The settings-owned document the service persists (uploads override + extras). */
function configWith(uploadsRoot: string, extra: Partial<StorageConfig> = {}): StorageConfig {
  return {
    backends: [
      { name: 'uploads-local', type: 'local', options: { root: uploadsRoot } },
      ...(extra.backends ?? []),
    ],
    categories: extra.categories ?? {},
  };
}

beforeEach(() => {
  testDb.prepare("DELETE FROM app_settings WHERE key LIKE 'storage.%'").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('StorageAdminService.state', () => {
  it('STORADM-001 renders the effective world: sources, categories-per-backend, flags', () => {
    const { service, uploadsRoot } = makeService();
    const state = service.state();
    const uploads = state.backends.find((b) => b.name === 'uploads-local')!;
    expect(uploads).toMatchObject({ type: 'local', source: 'settings', options: { root: uploadsRoot } });
    expect(uploads.categories).toContain('files');
    expect(uploads.categories).not.toContain('backups');
    expect(state.backends.find((b) => b.name === 'backups-local')).toMatchObject({ source: 'built-in' });
    expect(state.categories.backups).toEqual({ backend: 'backups-local', source: 'default' });
    expect(state.encryptionReady).toBe(true);
    expect(state.seedFilePresent).toBe(false);
    expect(state.health).toEqual({ replicaFailures: [] });
  });

  it('STORADM-002 masks exactly the secret fields (accessKeyId stays visible)', () => {
    const { service, uploadsRoot } = makeService();
    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'off-box', type: 's3', options: S3_OPTIONS }],
      categories: { backups: 'off-box' },
    }));
    const offBox = service.state().backends.find((b) => b.name === 'off-box')!;
    expect(offBox.options.secretAccessKey).toBe(MASKED_SETTING_VALUE);
    expect(offBox.options.accessKeyId).toBe('ak');
  });

  it('STORADM-003 surfaces replica failures through StorageService.health()', () => {
    const { service, registry } = makeService();
    registry.recordReplicaFailure({ backend: 'nas', key: 'backup-1.zip', op: 'put', error: 'disk full', at: 123 });
    expect(service.state().health.replicaFailures).toEqual([
      { backend: 'nas', key: 'backup-1.zip', op: 'put', error: 'disk full', at: 123 },
    ]);
  });
});

describe('StorageAdminService.applyConfig', () => {
  it('STORADM-010 happy path: persists both rows, reloads, new config is live', () => {
    const { service, registry, uploadsRoot } = makeService();
    const nasRoot = makeTmpDir();
    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'nas-backups', type: 'local', options: { root: nasRoot } }],
      categories: { backups: 'nas-backups' },
    }));
    expect(registry.resolve('backups').backendName).toBe('nas-backups'); // reload() ran
    expect(JSON.parse(readRow(CATEGORIES_KEY)!)).toEqual({ backups: 'nas-backups' });
  });

  it('STORADM-011 encrypts plaintext secrets at rest', () => {
    const { service, uploadsRoot } = makeService();
    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'off-box', type: 's3', options: S3_OPTIONS }],
      categories: { backups: 'off-box' },
    }));
    const stored = JSON.parse(readRow(BACKENDS_KEY)!) as Array<{ name: string; options: Record<string, unknown> }>;
    const secret = String(stored.find((b) => b.name === 'off-box')!.options.secretAccessKey);
    expect(secret.startsWith('enc:v1:')).toBe(true);
  });

  it('STORADM-012 mask echo preserves the stored ciphertext byte-for-byte', () => {
    const { service, uploadsRoot } = makeService();
    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'off-box', type: 's3', options: S3_OPTIONS }],
      categories: { backups: 'off-box' },
    }));
    const before = JSON.parse(readRow(BACKENDS_KEY)!) as Array<{ name: string; options: Record<string, unknown> }>;
    const cipherBefore = before.find((b) => b.name === 'off-box')!.options.secretAccessKey;

    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'off-box', type: 's3', options: { ...S3_OPTIONS, secretAccessKey: MASKED_SETTING_VALUE } }],
      categories: { backups: 'off-box' },
    }));
    const after = JSON.parse(readRow(BACKENDS_KEY)!) as Array<{ name: string; options: Record<string, unknown> }>;
    expect(after.find((b) => b.name === 'off-box')!.options.secretAccessKey).toBe(cipherBefore);
  });

  it('STORADM-013 a mask on a renamed/new backend throws the re-enter error, persists nothing', () => {
    const { service, uploadsRoot } = makeService();
    const before = readRow(BACKENDS_KEY);
    expect(() =>
      service.applyConfig(configWith(uploadsRoot, {
        backends: [{ name: 'brand-new', type: 's3', options: { ...S3_OPTIONS, secretAccessKey: MASKED_SETTING_VALUE } }],
        categories: {},
      })),
    ).toThrow("re-enter the secret 'secretAccessKey' for 'brand-new'");
    expect(readRow(BACKENDS_KEY)).toBe(before);
  });

  it('STORADM-014 plaintext secret without ENCRYPTION_KEY → error naming the variable, nothing persisted', () => {
    const { service, uploadsRoot } = makeService({ encryptionKeySet: false });
    const before = readRow(BACKENDS_KEY);
    expect(() =>
      service.applyConfig(configWith(uploadsRoot, {
        backends: [{ name: 'off-box', type: 's3', options: S3_OPTIONS }],
        categories: {},
      })),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(readRow(BACKENDS_KEY)).toBe(before);
  });

  it('STORADM-015 an encrypted (mask-echoed or enc:v1:) secret saves fine WITHOUT ENCRYPTION_KEY set', () => {
    // The gate is about NEW plaintext material only — resaving stored ciphertext must not lock admins out.
    const { service, uploadsRoot } = makeService({ encryptionKeySet: false });
    service.applyConfig(configWith(uploadsRoot, {
      backends: [{ name: 'off-box', type: 's3', options: { ...S3_OPTIONS, secretAccessKey: encrypt_api_key('sk') } }],
      categories: { backups: 'off-box' },
    }));
    expect(readRow(BACKENDS_KEY)).toBeDefined();
  });

  it('STORADM-016 preview() refusals surface verbatim and persist nothing', () => {
    const { service, uploadsRoot, registry } = makeService();
    const before = readRow(CATEGORIES_KEY);
    expect(() =>
      service.applyConfig(configWith(uploadsRoot, { categories: { backups: 'nope' } })),
    ).toThrow("category 'backups' maps to unknown backend 'nope'");
    expect(readRow(CATEGORIES_KEY)).toBe(before);
    expect(registry.resolve('backups').backendName).toBe('backups-local'); // live state untouched
  });

  it('STORADM-017 persists both rows in ONE transaction and reloads once', () => {
    const { service, registry, uploadsRoot } = makeService();
    const txSpy = vi.spyOn(db, 'transaction');
    const reloadSpy = vi.spyOn(registry, 'reload');
    service.applyConfig(configWith(uploadsRoot));
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
