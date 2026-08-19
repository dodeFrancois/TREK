import { deriveAll, type AppEnv, type RawEnv } from './derive';
import { envSchema } from './env.schema';
// storage-keys is the single source of truth for key/prefix shape — deliberately
// imported here rather than re-implementing the rule for TREK_S3_KEY_PREFIX. It
// is a plain module with no imports back into app-config, so this does not
// create a cycle.
import { isValidPrefix } from '../nest/storage/storage-keys';

export type { AppEnv, RawEnv };

/**
 * Live typed view of the environment. Re-derives from the CURRENT process.env
 * on every call — never cache the result across requests: the test suite (and
 * the admin demo tooling) mutates process.env at runtime and depends on the
 * next read observing the change. Derivation is a handful of string coercions,
 * not a Zod parse; validation happens once at boot via validateEnvAtBoot().
 */
export function readEnv(): AppEnv {
  return deriveAll(process.env as RawEnv);
}

/**
 * Fail-fast startup validation: a variable that is PRESENT but malformed aborts
 * boot with an aggregated report; unset/blank variables always pass (their
 * documented defaults apply). Called once from the production entrypoint (see
 * boot-validate.ts, imported by index.ts right after dotenv) — deliberately NOT
 * wired into buildApp() or ConfigModule, so tests booting apps with a minimal
 * env are unaffected.
 */
export function validateEnvAtBoot(raw: RawEnv = process.env as RawEnv): void {
  const result = envSchema.safeParse(raw);
  const lines = result.success
    ? []
    : result.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        return `  - ${key}=${JSON.stringify(raw[key])}: ${issue.message}`;
      });
  lines.push(...managedPreconditions(raw), ...s3Preconditions(raw));
  if (lines.length === 0) return;
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  throw new Error(
    `Invalid environment configuration (${lines.length} problem${lines.length === 1 ? '' : 's'}). ` +
      'Fix the variables listed above, or unset them to use their defaults.',
  );
}

/**
 * Cross-field rules that only apply to a centrally administered install.
 *
 * These are not schema problems — every value here is individually valid, and
 * blank always means "use the default" everywhere else in this file. They are
 * combinations that would boot happily and be wrong, which is the case the
 * schema cannot express and the one worth refusing (fail closed, see
 * server/CLAUDE.md).
 *
 * Deliberately unreachable for a self-hoster: without TREK_MANAGED the list is
 * empty and nothing changes.
 */
function managedPreconditions(raw: RawEnv): string[] {
  if (deriveAll(raw).managed.enabled !== true) return [];
  const problems: string[] = [];

  // Without it the key is a file in the data volume, and backupService bundles
  // that file into every archive it builds. The archive is downloadable by any
  // instance admin, so the at-rest encryption would come with its own key in the
  // same zip. Provisioning sets this; forgetting it is silent otherwise.
  if (!raw.ENCRYPTION_KEY) {
    problems.push(
      '  - ENCRYPTION_KEY is unset: required with TREK_MANAGED, because otherwise the ' +
        'at-rest key lives in the data volume and is bundled into every backup download.',
    );
  }

  return problems;
}

const S3_VARS = [
  'TREK_S3_ENDPOINT',
  'TREK_S3_BUCKET',
  'TREK_S3_ACCESS_KEY_ID',
  'TREK_S3_SECRET_ACCESS_KEY',
  'TREK_S3_REGION',
  'TREK_S3_KEY_PREFIX',
  'TREK_S3_RETRIES',
  'TREK_S3_TIMEOUT_MS',
] as const;
// Explicit, not `S3_VARS.slice(0, 4)` — the required set must not silently
// shift if S3_VARS is ever reordered.
const S3_REQUIRED: (typeof S3_VARS)[number][] = [
  'TREK_S3_ENDPOINT',
  'TREK_S3_BUCKET',
  'TREK_S3_ACCESS_KEY_ID',
  'TREK_S3_SECRET_ACCESS_KEY',
];

/**
 * All-or-nothing: any TREK_S3_* set means the operator wants off-box storage;
 * booting with a partial set would silently run without it (fail closed).
 * Prefix shape delegates to storage-keys — the single source of key rules.
 */
function s3Preconditions(raw: RawEnv): string[] {
  const present = (key: (typeof S3_VARS)[number]): boolean => Boolean(raw[key]?.trim());
  if (!S3_VARS.some(present)) return [];
  const problems: string[] = [];
  for (const key of S3_REQUIRED) {
    if (!present(key)) {
      problems.push(
        `  - ${key} is unset: required when any TREK_S3_* variable is set, because a ` +
          'half-configured s3 backend would boot without the off-box storage the operator asked for.',
      );
    }
  }
  const prefix = raw.TREK_S3_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, '');
  if (prefix && !isValidPrefix(`${prefix}/`)) {
    problems.push(
      `  - TREK_S3_KEY_PREFIX=${JSON.stringify(raw.TREK_S3_KEY_PREFIX)}: must be plain key segments ` +
        '(no dot-segments, backslashes, or control characters).',
    );
  }
  return problems;
}
