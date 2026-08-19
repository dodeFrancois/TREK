import fs from 'node:fs';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { STORAGE_BACKEND_TYPES } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { RuntimeEnvService } from '../app-config/runtime-env.service';
import { decrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { LocalDriver } from './drivers/local.driver';
import { MirrorDriver, type ReplicaFailure } from './drivers/mirror.driver';
import { S3Driver } from './drivers/s3.driver';
import { DEFAULT_BACKUPS_ROOT, DEFAULT_UPLOADS_ROOT, GLOBAL_TEMP_DIR } from './storage-paths';
import {
  STORAGE_CATEGORIES,
  StorageBackendError,
  type StorageCategory,
  type StorageDriver,
} from './storage.types';

export interface ResolvedCategory {
  driver: StorageDriver;
  keyPrefix: string;
  backendName: string;
}

interface LocalBackendConfig {
  name: string;
  type: 'local';
  options: { root: string };
}
interface MirrorBackendConfig {
  name: string;
  type: 'mirror';
  options: { primary: string; replicas: string[] };
}
interface S3BackendConfig {
  name: string;
  type: 's3';
  options: {
    endpoint: string;
    region: string;
    bucket: string;
    keyPrefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    retries: number;
    timeoutMs: number;
  };
}
type BackendConfig = LocalBackendConfig | MirrorBackendConfig | S3BackendConfig;

interface RegistryState {
  drivers: Map<string, StorageDriver>;
  categories: Map<StorageCategory, { backendName: string; keyPrefix: string }>;
}

const BACKENDS_KEY = 'storage.backends';
const CATEGORIES_KEY = 'storage.categories';
const REPLICA_FAILURE_RING_SIZE = 50;

/**
 * Category prefixes mirror the current uploads layout 1:1 so local keys map
 * to existing paths and no data migration is required. `backups` is bare-key
 * (the backend root IS the backups dir — spec rev 3.1), and `photos-google`
 * flips to bare keys when it resolves to `place-photos-local` (the relocated
 * TREK_PLACE_PHOTO_DIR layout, place-photo-cache.service.ts).
 *
 * Exported for tests/unit/uploads-dirs.test.ts, which pins the Dockerfile's
 * `mkdir -p /app/uploads/...` list to these prefixes.
 */
export const CATEGORY_PREFIXES: Record<StorageCategory, string> = {
  files: 'files/',
  journey: 'journey/',
  covers: 'covers/',
  avatars: 'avatars/',
  places: 'places/',
  photos: 'photos/',
  'photos-google': 'photos/google/',
  'photos-trek': 'photos/trek/',
  backups: '',
};

/**
 * Named backend instances + the category→backend map, config-driven and
 * swappable — v1 groundwork for the future admin UI (which becomes a settings
 * editor plus a reload() call).
 *
 * Unlike the codebase default of uncached per-request reads
 * (allowed-file-types.service.ts documents that convention), the registry
 * holds its validated config in memory and swaps it on reload() — the
 * permissions-cache precedent. Rationale: this sits on every byte-serving hot
 * path and its config changes only via admin action. Nothing outside this
 * class may cache a driver reference; resolution happens per call.
 */
@Injectable()
export class StorageRegistryService implements OnModuleInit {
  private readonly logger = new Logger(StorageRegistryService.name);
  private state: RegistryState | null = null;
  private failures: ReplicaFailure[] = [];

  constructor(
    private readonly db: DatabaseService,
    private readonly env: RuntimeEnvService,
  ) {}

  onModuleInit(): void {
    this.load(true);
  }

  /** Re-read settings, validate, atomically swap. In-flight ops keep their resolved instances. */
  reload(): void {
    this.load(false);
  }

  /**
   * Validate a candidate config by running the real build() — merge over
   * built-ins → parse → validateConfig → driver construction (network-free) —
   * and discard the result. Throws exactly what a failing load would log;
   * never touches this.state (admin writes must not take the silent boot-time
   * fallback). Shares one side effect with any successful save: local roots
   * and prefix dirs are created — an uncreatable root is exactly the error to
   * surface before persisting. cleanSpool stays boot-only (boot=false here).
   */
  preview(candidate: { backends: unknown; categories: unknown }): void {
    void this.build(candidate, false);
  }

  resolve(category: StorageCategory): ResolvedCategory {
    if (!this.state) throw new StorageBackendError('storage registry not initialized');
    const assignment = this.state.categories.get(category);
    if (!assignment) throw new StorageBackendError(`unknown storage category: ${category}`);
    const driver = this.state.drivers.get(assignment.backendName);
    if (!driver) {
      throw new StorageBackendError(`storage backend '${assignment.backendName}' missing for category '${category}'`);
    }
    return { driver, keyPrefix: assignment.keyPrefix, backendName: assignment.backendName };
  }

  /** Driver-agnostic global scratch space (data/tmp). */
  tempDir(): string {
    return GLOBAL_TEMP_DIR;
  }

  recordReplicaFailure(failure: ReplicaFailure): void {
    this.failures.push(failure);
    if (this.failures.length > REPLICA_FAILURE_RING_SIZE) {
      this.failures = this.failures.slice(-REPLICA_FAILURE_RING_SIZE);
    }
  }

  replicaFailures(): readonly ReplicaFailure[] {
    return this.failures;
  }

  /**
   * Invalid settings never take the server down: on any failure the previous
   * state is kept (at boot, when there is no previous state, the built-in
   * defaults — which cannot be misconfigured — are loaded instead).
   */
  private load(boot: boolean): void {
    try {
      this.state = this.build(this.readSettings(), boot);
    } catch (err) {
      const keeping = this.state ? 'last-good config' : 'built-in defaults';
      this.logger.error(`invalid storage settings — keeping ${keeping}: ${err instanceof Error ? err.message : err}`);
      if (!this.state) {
        this.state = this.build({ backends: [], categories: {} }, boot);
      }
    }
  }

  private readSettings(): { backends: unknown; categories: unknown } {
    const read = (key: string): unknown => {
      const row = this.db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
      return row?.value ? (JSON.parse(row.value) as unknown) : undefined;
    };
    return { backends: read(BACKENDS_KEY), categories: read(CATEGORIES_KEY) };
  }

  private build(settings: { backends: unknown; categories: unknown }, boot: boolean): RegistryState {
    // 1. Env is read fresh on every load (never snapshotted — RuntimeEnvService rule).
    const placePhotoDir = this.env.env().paths.placePhotoDir;

    // 2. Built-in defaults; settings entries with the same name/category override.
    //    uploads-local's root is the computed default since TREK_UPLOADS_DIR was
    //    removed — relocation is a settings override row with the built-in's name.
    const backends = new Map<string, BackendConfig>();
    backends.set('uploads-local', { name: 'uploads-local', type: 'local', options: { root: DEFAULT_UPLOADS_ROOT } });
    backends.set('backups-local', { name: 'backups-local', type: 'local', options: { root: DEFAULT_BACKUPS_ROOT } });
    if (placePhotoDir) {
      backends.set('place-photos-local', { name: 'place-photos-local', type: 'local', options: { root: placePhotoDir } });
    }
    for (const config of parseBackendList(settings.backends)) backends.set(config.name, config);

    const categoryBackends = new Map<StorageCategory, string>();
    for (const category of STORAGE_CATEGORIES) categoryBackends.set(category, 'uploads-local');
    categoryBackends.set('backups', 'backups-local');
    if (placePhotoDir) categoryBackends.set('photos-google', 'place-photos-local');
    for (const [category, backendName] of parseCategoryMap(settings.categories)) {
      categoryBackends.set(category, backendName);
    }

    // 3. Validate the merged config as a whole.
    validateConfig(backends, categoryBackends);

    // 4. Category prefixes (photos-google mode decided from the final map).
    const categories = new Map<StorageCategory, { backendName: string; keyPrefix: string }>();
    for (const [category, backendName] of categoryBackends) {
      const keyPrefix =
        category === 'photos-google' && backendName === 'place-photos-local' ? '' : CATEGORY_PREFIXES[category];
      categories.set(category, { backendName, keyPrefix });
    }

    // 5. Instantiate drivers: locals first (each ensures its own dirs; spool
    // cleanup at boot only — a reload() could delete an in-flight upload's
    // spool file), then mirrors over the local instances.
    const drivers = new Map<string, StorageDriver>();
    for (const config of backends.values()) {
      if (config.type !== 'local') continue;
      const driver = new LocalDriver({ id: config.name, root: config.options.root });
      const ensurePrefixes = [...categories.entries()]
        .filter(([, assignment]) => assignment.backendName === config.name)
        .map(([, assignment]) => assignment.keyPrefix)
        .filter((prefix) => prefix !== '');
      driver.init({ ensurePrefixes, cleanSpool: boot });
      drivers.set(config.name, driver);
    }
    for (const config of backends.values()) {
      if (config.type !== 's3') continue;
      drivers.set(
        config.name,
        new S3Driver({ id: config.name, ...config.options, secretAccessKey: decryptedSecret(config) }),
      );
    }
    for (const config of backends.values()) {
      if (config.type !== 'mirror') continue;
      drivers.set(
        config.name,
        new MirrorDriver({
          id: config.name,
          primary: drivers.get(config.options.primary)!,
          replicas: config.options.replicas.map((name) => drivers.get(name)!),
          tempDir: () => this.tempDir(),
          onReplicaFailure: (failure) => this.recordReplicaFailure(failure),
        }),
      );
    }
    fs.mkdirSync(GLOBAL_TEMP_DIR, { recursive: true });

    // 6. Single-assignment swap — callers mid-operation keep their instances.
    return { drivers, categories };
  }
}

// ── settings parsing / validation (pure helpers) ──────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackendList(raw: unknown): BackendConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new StorageBackendError(`'${BACKENDS_KEY}' must be a JSON array`);
  return raw.map((entry): BackendConfig => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) {
      throw new StorageBackendError(`'${BACKENDS_KEY}' entries need a non-empty string 'name'`);
    }
    const options = isRecord(entry.options) ? entry.options : {};
    if (entry.type === 'local') {
      if (typeof options.root !== 'string' || !options.root) {
        throw new StorageBackendError(`local backend '${entry.name}' needs a non-empty 'options.root'`);
      }
      return { name: entry.name, type: 'local', options: { root: options.root } };
    }
    if (entry.type === 'mirror') {
      const replicas = Array.isArray(options.replicas) ? options.replicas : null;
      if (typeof options.primary !== 'string' || !replicas || replicas.some((r) => typeof r !== 'string')) {
        throw new StorageBackendError(`mirror backend '${entry.name}' needs 'options.primary' and 'options.replicas'`);
      }
      return { name: entry.name, type: 'mirror', options: { primary: options.primary, replicas: replicas as string[] } };
    }
    if (entry.type === 's3') {
      const parsed = STORAGE_BACKEND_TYPES.s3.optionsSchema.safeParse(options);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new StorageBackendError(
          `s3 backend '${entry.name}' has invalid options` +
            (first ? ` — ${first.path.join('.') || '(options)'}: ${first.message}` : ''),
        );
      }
      // secretAccessKey stays as stored (usually enc:v1:) — decrypted only at
      // driver construction, so config maps and snapshots never hold plaintext.
      return { name: entry.name, type: 's3', options: parsed.data };
    }
    throw new StorageBackendError(`backend '${entry.name}' has unknown type '${String(entry.type)}'`);
  });
}

function parseCategoryMap(raw: unknown): Array<[StorageCategory, string]> {
  if (raw === undefined) return [];
  if (!isRecord(raw)) throw new StorageBackendError(`'${CATEGORIES_KEY}' must be a JSON object`);
  return Object.entries(raw).map(([category, backendName]) => {
    if (!(STORAGE_CATEGORIES as readonly string[]).includes(category)) {
      throw new StorageBackendError(`'${CATEGORIES_KEY}' names unknown category '${category}'`);
    }
    if (typeof backendName !== 'string' || !backendName) {
      throw new StorageBackendError(`category '${category}' must map to a backend name`);
    }
    return [category as StorageCategory, backendName];
  });
}

/**
 * Secrets live encrypted inside the storage.backends JSON (admin-config spec);
 * plaintext passthrough is tolerated as belt-and-braces (decrypt_api_key's
 * legacy-plaintext rule), though seed and PUT always store encrypted.
 */
function decryptedSecret(config: S3BackendConfig): string {
  const plain = decrypt_api_key(config.options.secretAccessKey);
  if (plain === null) {
    throw new StorageBackendError(
      `s3 backend '${config.name}': could not decrypt 'secretAccessKey' — was ENCRYPTION_KEY changed or the row edited by hand?`,
    );
  }
  return plain;
}

function validateConfig(backends: Map<string, BackendConfig>, categories: Map<StorageCategory, string>): void {
  for (const config of backends.values()) {
    if (config.type !== 'mirror') continue;
    for (const target of [config.options.primary, ...config.options.replicas]) {
      const resolved = backends.get(target);
      if (!resolved) {
        throw new StorageBackendError(`mirror '${config.name}' references unknown backend '${target}'`);
      }
      if (resolved.type === 'mirror') {
        throw new StorageBackendError(`mirror '${config.name}' nests mirror '${target}' — nesting is rejected`);
      }
    }
  }
  for (const [category, backendName] of categories) {
    const backend = backends.get(backendName);
    if (!backend) {
      throw new StorageBackendError(`category '${category}' maps to unknown backend '${backendName}'`);
    }
    if (backend.type === 'mirror' && category !== 'backups') {
      throw new StorageBackendError(`category '${category}' may not use a mirror backend (backups only)`);
    }
  }
}
