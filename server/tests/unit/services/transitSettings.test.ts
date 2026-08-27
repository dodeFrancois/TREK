import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      navitime_rapidapi_key TEXT
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { testDb: db, dbMock: { db } };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: vi.fn((value: string | null | undefined) => value || null),
}));

async function loadSettings(): Promise<Record<string, (...args: any[]) => any>> {
  return import('../../../src/services/transit/settings').catch(() => ({}));
}

beforeEach(() => {
  testDb.exec('DELETE FROM app_settings; DELETE FROM users;');
});

describe('NAVITIME credential resolution', () => {
  it('uses the current user key before an administrator fallback key', async () => {
    testDb.prepare('INSERT INTO users (id, role, navitime_rapidapi_key) VALUES (?, ?, ?)').run(1, 'user', 'user-key');
    testDb.prepare('INSERT INTO users (id, role, navitime_rapidapi_key) VALUES (?, ?, ?)').run(2, 'admin', 'admin-key');
    const settings = await loadSettings();

    expect(settings.getNavitimeKey?.(1)).toBe('user-key');
  });

  it('falls back to an administrator key when the current user has none', async () => {
    testDb.prepare('INSERT INTO users (id, role, navitime_rapidapi_key) VALUES (?, ?, ?)').run(1, 'user', null);
    testDb.prepare('INSERT INTO users (id, role, navitime_rapidapi_key) VALUES (?, ?, ?)').run(2, 'admin', 'admin-key');
    const settings = await loadSettings();

    expect(settings.getNavitimeKey?.(1)).toBe('admin-key');
  });

  it('returns null when neither the user nor an administrator has a key', async () => {
    testDb.prepare('INSERT INTO users (id, role, navitime_rapidapi_key) VALUES (?, ?, ?)').run(1, 'user', null);
    const settings = await loadSettings();

    expect(settings.getNavitimeKey?.(1)).toBeNull();
  });
});

describe('transit provider selection', () => {
  it('defaults to Transitous and reads NAVITIME from app_settings', async () => {
    const settings = await loadSettings();
    expect(settings.getTransitProvider?.()).toBe('transitous');

    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'navitime')").run();
    expect(settings.getTransitProvider?.()).toBe('navitime');
  });
});
