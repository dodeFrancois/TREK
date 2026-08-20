import fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { StorageAdminState, StorageConfig } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { RuntimeEnvService } from '../app-config/runtime-env.service';
import {
  BACKENDS_KEY,
  CATEGORIES_KEY,
  StorageRegistryService,
} from './storage-registry.service';
import { StorageService } from './storage.service';
import { SEED_CONFIG_PATH } from './storage-paths';
import {
  encryptionGateError,
  encryptStorageSecrets,
  listPlaintextSecrets,
  maskBackendOptions,
  unmaskStorageConfig,
} from './storage-secrets';
import { StorageBackendError } from './storage.types';

/**
 * Owner of the api/admin/storage read/write pipelines (spec:
 * docs/superpowers/specs/2026-08-19-storage-admin-config-design.md, Server).
 * Reads render from the registry's live snapshot; writes run
 * unmask → encryption gate → preview → encrypt → persist → reload, so an
 * admin save either fully applies or changes nothing — never the boot-time
 * silent fallback.
 */
@Injectable()
export class StorageAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: StorageRegistryService,
    private readonly storage: StorageService,
    private readonly env: RuntimeEnvService,
  ) {}

  /** The effective world — secrets masked, categories cross-referenced per backend. */
  state(): StorageAdminState {
    const snapshot = this.registry.snapshot();
    const assignments = Object.entries(snapshot.categories) as Array<
      [keyof typeof snapshot.categories, { backend: string; source: 'default' | 'settings' }]
    >;
    return {
      backends: snapshot.backends.map((backend) => ({
        name: backend.name,
        type: backend.type,
        source: backend.source,
        options: maskBackendOptions(backend.type, backend.options),
        categories: assignments.filter(([, a]) => a.backend === backend.name).map(([category]) => category),
      })),
      categories: snapshot.categories,
      health: { replicaFailures: this.storage.health().replicaFailures.map((f) => ({ ...f })) },
      encryptionReady: this.env.env().security.encryptionKeySet,
      seedFilePresent: fs.existsSync(SEED_CONFIG_PATH),
    };
  }

  /** Full-document replace of the two settings rows. Throws StorageBackendError on any refusal. */
  applyConfig(config: StorageConfig): void {
    const unmasked = unmaskStorageConfig(config, this.storedBackendsRow());
    const plaintext = listPlaintextSecrets(unmasked);
    if (plaintext.length > 0 && !this.env.env().security.encryptionKeySet) {
      throw new StorageBackendError(encryptionGateError(plaintext[0]!));
    }
    this.registry.preview({ backends: unmasked.backends, categories: unmasked.categories });
    const encrypted = encryptStorageSecrets(unmasked);
    this.db.transaction(() => {
      const upsert = this.db.prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      upsert.run(BACKENDS_KEY, JSON.stringify(encrypted.backends));
      upsert.run(CATEGORIES_KEY, JSON.stringify(encrypted.categories));
    });
    this.registry.reload();
  }

  /** The raw stored backends row — the unmask source (tolerates absent/garbage rows). */
  private storedBackendsRow(): unknown {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', BACKENDS_KEY);
    if (!row?.value) return [];
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return [];
    }
  }
}
