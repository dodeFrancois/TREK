import { describe, expect, it } from 'vitest';
import { MASKED_SETTING_VALUE, type StorageAdminState, type StorageConfig } from '@trek/shared';
import {
  categoriesPointingAt,
  hasPlaintextSecret,
  mirrorsReferencing,
  removeBackend,
  settingsDocumentOf,
  upsertBackend,
} from './storageModel';

const STATE: StorageAdminState = {
  backends: [
    { name: 'uploads-local', type: 'local', source: 'built-in', options: { root: '/data/uploads' }, categories: ['files'] },
    { name: 'place-photos-local', type: 'local', source: 'env', options: { root: '/photos' }, categories: ['places'] },
    {
      name: 'off-box',
      type: 's3',
      source: 'settings',
      options: {
        endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak',
        secretAccessKey: MASKED_SETTING_VALUE, region: 'us-east-1', keyPrefix: '', retries: 1, timeoutMs: 30000,
      },
      categories: ['covers'],
    },
  ],
  categories: {
    files: { backend: 'uploads-local', source: 'default' },
    journey: { backend: 'uploads-local', source: 'default' },
    covers: { backend: 'off-box', source: 'settings' },
    avatars: { backend: 'uploads-local', source: 'default' },
    places: { backend: 'place-photos-local', source: 'default' },
    photos: { backend: 'uploads-local', source: 'default' },
    'photos-google': { backend: 'place-photos-local', source: 'default' },
    'photos-trek': { backend: 'uploads-local', source: 'default' },
    backups: { backend: 'backups-local', source: 'default' },
  },
  health: { replicaFailures: [] },
  encryptionReady: true,
  seedFilePresent: false,
};

describe('settingsDocumentOf', () => {
  it('FE-ADMIN-STORM-001: carries ONLY settings-sourced backends and categories (the PUT contract)', () => {
    const doc = settingsDocumentOf(STATE);
    expect(doc.backends.map((b) => b.name)).toEqual(['off-box']);
    expect(doc.categories).toEqual({ covers: 'off-box' });
  });
});

describe('remove pre-check helpers', () => {
  const draft: StorageConfig = {
    backends: [
      { name: 'nas', type: 'local', options: { root: '/mnt/nas' } },
      { name: 'mir', type: 'mirror', options: { primary: 'backups-local', replicas: ['nas'] } },
    ],
    categories: { covers: 'nas', backups: 'mir' },
  };

  it('FE-ADMIN-STORM-002: lists categories pointing at a backend', () => {
    expect(categoriesPointingAt(draft, 'nas')).toEqual(['covers']);
    expect(categoriesPointingAt(draft, 'unused')).toEqual([]);
  });

  it('FE-ADMIN-STORM-003: lists mirrors referencing a backend (primary or replica)', () => {
    expect(mirrorsReferencing(draft, 'nas')).toEqual(['mir']);
    expect(mirrorsReferencing(draft, 'backups-local')).toEqual(['mir']);
    expect(mirrorsReferencing(draft, 'unused')).toEqual([]);
  });
});

describe('hasPlaintextSecret', () => {
  const s3 = (secretAccessKey: string) => ({
    type: 's3' as const,
    options: { endpoint: 'http://x', bucket: 'b', accessKeyId: 'ak', secretAccessKey },
  });

  it('FE-ADMIN-STORM-004: mask and empty are not plaintext; anything else is; local never is', () => {
    expect(hasPlaintextSecret(s3(MASKED_SETTING_VALUE))).toBe(false);
    expect(hasPlaintextSecret(s3(''))).toBe(false);
    expect(hasPlaintextSecret(s3('sk-plain'))).toBe(true);
    expect(hasPlaintextSecret({ type: 'local', options: { root: '/x' } })).toBe(false);
  });
});

describe('draft edits', () => {
  const draft: StorageConfig = {
    backends: [{ name: 'nas', type: 'local', options: { root: '/mnt/nas' } }],
    categories: {},
  };

  it('FE-ADMIN-STORM-005: upsert replaces by name in place, appends new ones, never mutates', () => {
    const edited = upsertBackend(draft, { name: 'nas', type: 'local', options: { root: '/mnt/nas2' } });
    expect(edited.backends).toEqual([{ name: 'nas', type: 'local', options: { root: '/mnt/nas2' } }]);
    const added = upsertBackend(draft, { name: 'other', type: 'local', options: { root: '/o' } });
    expect(added.backends.map((b) => b.name)).toEqual(['nas', 'other']);
    expect(draft.backends).toHaveLength(1); // untouched
  });

  it('FE-ADMIN-STORM-006: removeBackend filters by name', () => {
    expect(removeBackend(draft, 'nas').backends).toEqual([]);
    expect(removeBackend(draft, 'ghost').backends).toHaveLength(1);
  });
});
