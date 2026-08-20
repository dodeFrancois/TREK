/**
 * Storage admin e2e — exercises the migrated /api/admin/storage surface
 * (StorageAdminController) through the real JwtAuthGuard + AdminGuard +
 * ManagedGuard against a temp SQLite db. DI-native: no service mock, so the
 * registry's real boot/seed/reload pipeline and StorageAdminService run for
 * real. Covers auth (401), the admin gate (403), managed-mode refusal (403,
 * the first e2e to assert it — ManagedGuard is otherwise only wired in
 * AppModule), the GET/PUT/test happy paths, the 400 envelope for both a
 * semantic registry refusal and a Zod pipe rejection, secret masking/
 * encryption/redaction, and the encryption-gate 400 naming ENCRYPTION_KEY.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'http';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { StorageModule } from '../../src/nest/storage/storage.module';
import { ManagedGuard } from '../../src/nest/common/managed.guard';
import { Test } from '@nestjs/testing';
import { seedUser, sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  // `users` carries the columns listUsers/createUser/updateUser select, plus the
  // is_guest flag the #1362 COALESCE guards read (admin.e2e.test.ts DDL).
  tmp.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT, avatar TEXT, is_guest INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME);`);
  tmp.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);');
  // Slim audit_log mirror (no FKs), same shape as admin.e2e.test.ts.
  tmp.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER, action TEXT NOT NULL, resource TEXT, details TEXT, ip TEXT);`);
  return { db: tmp };
});

vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));
// The audit domain is DI-native: writeAudit runs for real against the temp db's
// audit_log table; only the file logger is silenced.
vi.mock('../../src/nest/audit/audit-log.logger', () => ({ LOG_LEVEL: 'error', logInfo: vi.fn(), logDebug: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }));
// apiKeyCrypto imports ENCRYPTION_KEY from here for the cipher; deriveSecurity
// (encryptionReady / the encryption gate) reads the RAW process.env var live,
// so beforeAll/afterAll manage that separately below. JWT_SECRET must also be
// supplied — jwt-verify.ts (JwtAuthGuard) and the harness's signSession both
// import it from this same module, so mocking the module wholesale requires
// keeping both consistent.
vi.mock('../../src/config', () => ({ ENCRYPTION_KEY: 'e2e-storage-key', JWT_SECRET: 'e2e-storage-jwt-secret' }));

import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';
import { ZodValidationPipe } from '../../src/nest/common/zod-validation.pipe';

describe('Storage admin e2e (real auth + admin guard + managed guard + temp SQLite)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;
  let adminCookie: string;
  let userCookie: string;

  async function build() {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, StorageModule],
      providers: [{ provide: APP_GUARD, useClass: ManagedGuard }],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalPipes(new ZodValidationPipe());
    nest.useGlobalFilters(new TrekExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'e2e-storage-key';
    seedUser(db as never, { id: 1 });
    seedUser(db as never, { id: 2, role: 'admin', email: 'e2e-storage-admin@example.test' });
    userCookie = sessionCookie(1);
    adminCookie = sessionCookie(2);
    app = await build();
    server = app.getHttpServer();
  });

  beforeEach(() => {
    db.exec("DELETE FROM app_settings WHERE key LIKE 'storage.%'");
    db.exec('DELETE FROM audit_log');
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ENCRYPTION_KEY;
  });

  it('STORE2E-001 401 without a session', async () => {
    expect((await request(server).get('/api/admin/storage')).status).toBe(401);
  });

  it('STORE2E-002 403 for a non-admin', async () => {
    const res = await request(server).get('/api/admin/storage').set('Cookie', userCookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  it('STORE2E-003 GET renders the effective defaults world', async () => {
    const res = await request(server).get('/api/admin/storage').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const names = (res.body.backends as Array<{ name: string; source: string }>).map((b) => [b.name, b.source]);
    expect(names).toEqual(expect.arrayContaining([['uploads-local', 'built-in'], ['backups-local', 'built-in']]));
    expect(Object.keys(res.body.categories)).toHaveLength(9);
    expect(res.body.encryptionReady).toBe(true);
    expect(res.body.seedFilePresent).toBe(false);
    expect(res.body.health).toEqual({ replicaFailures: [] });
  });

  it('STORE2E-004 PUT persists, answers the fresh world, audits with redacted secrets', async () => {
    const nasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-e2e-nas-'));
    const body = {
      backends: [
        { name: 'nas-backups', type: 'local', options: { root: nasRoot } },
        {
          name: 'off-box',
          type: 's3',
          options: { endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak', secretAccessKey: 'sk-e2e' },
        },
      ],
      categories: { backups: 'nas-backups' },
    };
    const res = await request(server).put('/api/admin/storage').set('Cookie', adminCookie).send(body);
    expect(res.status).toBe(200);
    const offBox = (res.body.backends as Array<{ name: string; source: string; options: Record<string, unknown> }>).find(
      (b) => b.name === 'off-box',
    )!;
    expect(offBox.source).toBe('settings');
    expect(offBox.options.secretAccessKey).toBe('••••••••'); // masked, never echoed
    expect(res.body.categories.backups).toEqual({ backend: 'nas-backups', source: 'settings' });

    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'storage.backends'").get() as { value: string };
    expect(row.value).toContain('enc:v1:');
    expect(row.value).not.toContain('sk-e2e');

    const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'admin.storage_update'").get() as { details: string };
    expect(audit.details).toContain('***');
    expect(audit.details).not.toContain('sk-e2e');
  });

  it('STORE2E-005 PUT with a semantic violation → 400 with the registry message verbatim', async () => {
    const res = await request(server)
      .put('/api/admin/storage')
      .set('Cookie', adminCookie)
      .send({ backends: [], categories: { backups: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "category 'backups' maps to unknown backend 'nope'" });
  });

  it('STORE2E-006 PUT with an unknown top-level key → 400 from the Zod pipe (reserved readOnly door)', async () => {
    const res = await request(server)
      .put('/api/admin/storage')
      .set('Cookie', adminCookie)
      .send({ backends: [], categories: {}, readOnly: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('STORE2E-007 PUT with a plaintext secret and no ENCRYPTION_KEY → 400 naming the variable', async () => {
    delete process.env.ENCRYPTION_KEY;
    try {
      const res = await request(server)
        .put('/api/admin/storage')
        .set('Cookie', adminCookie)
        .send({
          backends: [
            {
              name: 'off-box',
              type: 's3',
              options: { endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak', secretAccessKey: 'sk' },
            },
          ],
          categories: {},
        });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('ENCRYPTION_KEY');
    } finally {
      process.env.ENCRYPTION_KEY = 'e2e-storage-key';
    }
  });

  it('STORE2E-008 managed mode refuses the whole surface with the standard body', async () => {
    process.env.TREK_MANAGED = 'true';
    try {
      const res = await request(server).get('/api/admin/storage').set('Cookie', adminCookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'This is configured by the operator of this instance.',
        code: 'MANAGED_FORBIDDEN',
      });
    } finally {
      delete process.env.TREK_MANAGED;
    }
  });

  it('STORE2E-009 POST /test probes a local candidate and answers 200 with per-target results', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-e2e-probe-'));
    const res = await request(server)
      .post('/api/admin/storage/test')
      .set('Cookie', adminCookie)
      .send({ backend: { name: 'cand', type: 'local', options: { root } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, targets: [{ name: 'cand', ok: true }] });
    const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'admin.storage_test'").get() as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ backend: 'cand', type: 'local', ok: true });
  });
});
