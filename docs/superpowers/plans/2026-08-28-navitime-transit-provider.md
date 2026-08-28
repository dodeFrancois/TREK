# NAVITIME Transit Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NAVITIME as an admin-selectable alternative to Transitous for public-transit route planning, geometry included.

**Architecture:** `TransitService` keeps validation, the shared cache and `geocode` (always Transitous), and dispatches `plan()` to one of two `@Injectable` planners behind a `TransitPlanner` interface. The NAVITIME planner is a thin shell around pure functions — request builder, section→leg mapper, geometry assembler — so every algorithm runs directly against two committed real API captures.

**Tech Stack:** NestJS 11 (Express adapter), TypeScript strict, vitest, better-sqlite3, Zod (in `@trek/shared`), React 19 + Vite client.

**Spec:** `docs/superpowers/specs/2026-08-28-navitime-transit-provider-design.md` — read it before Task 1. Every design decision below is argued there.

## Global Constraints

- **Tests come AFTER the implementation in each task.** This overrides the default TDD ordering: implement, verify against real data, then write tests, then run them. This is an explicit project-owner instruction.
- **Code comments in English.** `server/src/nest/transit/` is commented entirely in English today; keep the module homogeneous.
- **No new `any`, no new `eslint-disable`, no lowered gate.** Strict TS stays strict (`CLAUDE.md`: "Fail closed, gates stay on").
- **Never look at the `feat/navitime-transit` branch.** It is a non-rebasable reference implementation deliberately excluded from this port.
- **Conventional commits**, French or English subject, scope `transit` / `admin` / `i18n`. **No `Co-Authored-By` or tool-attribution trailers** (`CONTRIBUTING.md`).
- **Branch:** `feat/navitime-provider`, already created from `main` (v4.0.0).
- **Every i18n key must be added to all 23 locales** under `shared/src/i18n/<locale>/`. `npm run i18n:parity:strict --workspace=shared` is the CI gate.
- **`shared/` must be rebuilt** (`npm run build --workspace=shared`) before server/client typecheck when i18n or schemas change.
- Fixture captures are committed **untouched**. Do not hand-edit them: the reference implementation's fixtures reproduced one of its own bugs for its entire development.

## File Structure

| File | Responsibility |
|---|---|
| `server/src/nest/transit/transit.http.ts` | **new** — the single upstream contract: 8 s timeout, 5 MB ceiling, 429/502/400/503 error shaping |
| `server/src/nest/transit/transit.helpers.ts` | **modified** — gains `safeColor`, `POLYLINE_PRECISION` |
| `server/src/nest/transit/transit.settings.ts` | **new** — `readTransitProvider(db)`, `readNavitimeApiKey(db)` |
| `server/src/nest/transit/providers/transit-planner.ts` | **new** — `TransitProvider`, `TransitPlanResult`, `TransitPlanner` |
| `server/src/nest/transit/providers/transitous.planner.ts` | **new** — the MOTIS request + mapping, moved out of the service |
| `server/src/nest/transit/providers/navitime/navitime.modes.ts` | **new** — `MOVE_MODES`, `ALWAYS_USED`, `navitimeMode()`, `unuseFor()` |
| `server/src/nest/transit/providers/navitime/navitime.request.ts` | **new** — pure query-string builder (local naked time, `unuse`) |
| `server/src/nest/transit/providers/navitime/navitime.mapper.ts` | **new** — pure `sections` → `TransitLeg[]` + transfer indexes + `isTimetable` |
| `server/src/nest/transit/providers/navitime/navitime.geometry.ts` | **new** — pure `shapes` → per-leg polyline, all-or-nothing; polyline encoder |
| `server/src/nest/transit/providers/navitime/navitime.planner.ts` | **new** — `@Injectable`: key, fetch, glue, fallback logging. No algorithm. |
| `server/src/nest/transit/transit.service.ts` | **modified** — validation, cache, `geocode`, dispatch |
| `server/src/nest/transit/transit.module.ts` | **modified** — registers both planners |
| `server/src/nest/transit/transit-itinerary.helpers.ts` | **modified** — `provider` parameter instead of a hardcoded string |
| `server/src/nest/transit/transit.mcp.ts` | **modified** — passes the configured provider; provider-neutral tool copy |
| `server/src/nest/settings/instance-api-keys.ts` | **modified** — `InstanceApiKeyName` widened, `USER_ROW_SQL` partial |
| `server/src/nest/auth/auth.helpers.ts` | **modified** — `ADMIN_SETTINGS_KEYS` gains two keys |
| `server/src/nest/auth/auth.service.ts` | **modified** — encrypt/mask/audit branches for `navitime_api_key` |
| `server/tests/fixtures/navitime/route_transit.calling-at.json` | **new** — one untouched real capture |
| `client/src/components/Planner/TransitSearchPanel.tsx` | **modified** — estimated-times banner |
| `client/src/pages/admin/AdminSettingsTab.tsx`, `useAdmin.ts` | **modified** — provider + key card |
| `shared/src/i18n/<23 locales>/trip.ts`, `admin.ts` | **modified** — 6 new keys |

---

### Task 1: Upstream contract and shared helpers

Pure refactor, zero behaviour change. The gate is that the existing transit tests pass **untouched**.

**Files:**
- Create: `server/src/nest/transit/transit.http.ts`
- Modify: `server/src/nest/transit/transit.helpers.ts`
- Modify: `server/src/nest/transit/transit.service.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchJson(url: string, headers: Record<string, string>): Promise<unknown>`, `badRequest(message: string): Error & { status: number }`, `notConfigured(message: string): Error & { status: number }`, `upstreamFailure(message: string, httpStatus: number): Error & { status: number }` from `transit.http.ts`; `safeColor(v: unknown): string | null` and `POLYLINE_PRECISION: 6` from `transit.helpers.ts`.

- [ ] **Step 1: Create `transit.http.ts`**

```ts
/**
 * The single upstream contract both transit providers honour: one timeout, one
 * response-size ceiling, and the `status` values transit.controller.ts relays
 * verbatim (it does `err.status || 502`).
 *
 * Kept as plain functions rather than a provider: there is no state here, and
 * the pure NAVITIME mappers must stay callable without a DI container.
 */

// A plan response with eight geometry-carrying itineraries stays well under a
// megabyte; anything bigger is a misbehaving provider, not data we want to map.
const MAX_RESPONSE_BYTES = 5_000_000;
const UPSTREAM_TIMEOUT_MS = 8000;

function statusError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** 400 — the caller sent something unusable. */
export function badRequest(message: string): Error & { status: number } {
  return statusError(message, 400);
}

/** 503 — the configured provider has no usable credentials. Refuse, never degrade. */
export function notConfigured(message: string): Error & { status: number } {
  return statusError(message, 503);
}

/** 429 upstream stays 429 so the client can back off; everything else is a 502. */
export function upstreamFailure(message: string, httpStatus: number): Error & { status: number } {
  return statusError(message, httpStatus === 429 ? 429 : 502);
}

export async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw upstreamFailure(`Transit provider error (HTTP ${res.status})`, res.status);
  const length = Number(res.headers?.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) {
    throw statusError('Transit provider error (response too large)', 502);
  }
  return res.json();
}
```

- [ ] **Step 2: Append to `transit.helpers.ts`**

```ts
/**
 * Precision of the encoded polylines TREK writes (~11 cm). MOTIS sends its own
 * precision beside the geometry and this is only the fallback; NAVITIME sends
 * raw GeoJSON, so this is what the encoder actually uses.
 */
export const POLYLINE_PRECISION = 6;

/**
 * Normalise a provider line colour to a #-prefixed value the client can drop
 * straight into CSS, or null. GTFS colours arrive as bare hex ("FF0000"), with
 * a hash, or empty; NAVITIME already sends "#80C241" — one normaliser covers both.
 */
export function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex) ? `#${hex}` : null;
}
```

- [ ] **Step 3: Rewire `transit.service.ts`**

Delete the local `MAX_RESPONSE_BYTES`, `upstream()` and `safeColor()` definitions. Import instead:

```ts
import { fetchJson, badRequest, upstreamFailure } from './transit.http';
import { safeColor, /* …existing imports… */ } from './transit.helpers';
```

Replace the body of the local `upstream` helper with a call that keeps the Transitous base URL and User-Agent where they are:

```ts
async function upstream(path: string, params: URLSearchParams): Promise<unknown> {
  return fetchJson(`${TRANSIT_API_BASE}${path}?${params}`, { 'User-Agent': getUserAgent() });
}
```

Replace each inline `const e = new Error(...) as Error & { status: number }; e.status = 400; throw e;` with `throw badRequest(...)`. `upstreamFailure` is unused here after this step — do **not** import it in this file; it is consumed by `navitime.planner.ts` in Task 7.

- [ ] **Step 4: Verify nothing moved behaviourally**

Run from `server/`:
```bash
npx vitest run tests/unit/nest/transit.service.test.ts tests/unit/nest/transit-itinerary.helpers.test.ts
npm run typecheck --workspace=server
```
Expected: PASS, with the test files **unmodified**. If a test fails, the refactor changed behaviour — fix the source, not the test.

- [ ] **Step 5: Commit**

```bash
git add server/src/nest/transit/transit.http.ts server/src/nest/transit/transit.helpers.ts server/src/nest/transit/transit.service.ts
git commit -m "refactor(transit): extract the upstream contract and safeColor into shared helpers"
```

---

### Task 2: `TransitPlanner` interface and `TransitousPlanner`

Still zero behaviour change except one additive response field. Same gate: existing tests pass.

**Files:**
- Create: `server/src/nest/transit/providers/transit-planner.ts`
- Create: `server/src/nest/transit/providers/transitous.planner.ts`
- Modify: `server/src/nest/transit/transit.service.ts`
- Modify: `server/src/nest/transit/transit.module.ts`
- Modify: `server/tests/e2e/transit.e2e.test.ts` (only if it asserts the whole response body)

**Interfaces:**
- Consumes: `fetchJson`, `badRequest` (Task 1); `safeColor` (Task 1).
- Produces: `type TransitProvider = 'transitous' | 'navitime'`; `interface TransitPlanResult { itineraries: TransitItinerary[]; isTimetable: boolean }`; `interface TransitPlanner { readonly id: TransitProvider; isConfigured(): boolean; plan(query: PlanQuery): Promise<TransitPlanResult> }`; `class TransitousPlanner implements TransitPlanner`.

- [ ] **Step 1: Create `providers/transit-planner.ts`**

```ts
import type { PlanQuery, TransitItinerary } from '../transit.helpers';

/** The value stored in app_settings.transit_provider. */
export type TransitProvider = 'transitous' | 'navitime';

export interface TransitPlanResult {
  itineraries: TransitItinerary[];
  /**
   * False as soon as one itinerary is not confirmed to run to a published
   * timetable — the client turns this into the estimated-times banner. Reported
   * per response rather than per itinerary on purpose: transitItinerarySchema is
   * the contract create_transit_journey validates on the way IN, and it must not
   * grow a field for a display concern.
   */
  isTimetable: boolean;
}

/**
 * A route-planning provider. Only planning is interchangeable: `geocode` stays
 * Transitous in all cases, because the NAVITIME subscription exposes no
 * geocoding endpoint at all.
 */
export interface TransitPlanner {
  /** The value stored in app_settings.transit_provider. */
  readonly id: TransitProvider;
  /** Refuse rather than degrade: TransitService 503s when this is false. */
  isConfigured(): boolean;
  plan(query: PlanQuery): Promise<TransitPlanResult>;
}
```

- [ ] **Step 2: Create `providers/transitous.planner.ts`**

Move the MOTIS half of `TransitService.plan` here verbatim — the `URLSearchParams` construction, the `ALLOWED_MODES` check, `directModes=WALK`, the `MotisPlaceRaw` interface, `mapStop`, and the `raw.itineraries` mapping. Keep `TRANSIT_API_BASE`, `getUserAgent()` and the `/api/v6/plan` path with it. The class shell:

```ts
@Injectable()
export class TransitousPlanner implements TransitPlanner {
  readonly id = 'transitous' as const;

  /** Transitous needs no credential — a public MOTIS instance, no API key. */
  isConfigured(): boolean {
    return true;
  }

  async plan(query: PlanQuery): Promise<TransitPlanResult> {
    // …the moved MOTIS code…
    // GTFS feeds ARE published timetables, so a MOTIS itinerary is always scheduled.
    return { itineraries, isTimetable: true };
  }
}
```

`geocode`, the cache and `isCoord`/`COORD_RE` stay in `transit.service.ts`.

`TRANSIT_API_BASE` and `getUserAgent()` are needed by both halves (`geocode` stays on Transitous). Define them **once**, at module scope in `transitous.planner.ts`, export both, and import them into `transit.service.ts`. The base URL keeps its single frozen-at-import definition and there is no second copy to drift.

- [ ] **Step 3: Reduce `TransitService.plan` to validation + cache + delegation**

```ts
async plan(q: PlanQuery): Promise<TransitPlanResult> {
  if (!q.from || !isCoord(q.from)) throw badRequest('from must be "lat,lng"');
  if (!q.to || !isCoord(q.to)) throw badRequest('to must be "lat,lng"');
  if (q.time && Number.isNaN(new Date(q.time).getTime())) {
    throw badRequest('time must be an ISO date-time');
  }
  if (q.modes) {
    const modes = q.modes.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
    if (modes.some((m) => !ALLOWED_MODES.has(m))) throw badRequest('unsupported transit mode');
  }
  if (q.maxTransfers !== undefined && q.maxTransfers !== null) {
    const n = Number(q.maxTransfers);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw badRequest('maxTransfers must be 0-10');
  }

  const planner = this.planners.transitous;
  // The cache key is built from the TREK query plus the provider id, not from
  // the provider's own parameters: without the id, flipping providers would
  // serve the previous one's itineraries for a full TTL.
  const key = `plan:${planner.id}:${q.from}|${q.to}|${q.time ?? ''}|${q.arriveBy ? '1' : '0'}|${q.modes ?? ''}|${q.maxTransfers ?? ''}`;
  const cached = cacheGet(key);
  if (cached) return cached as TransitPlanResult;

  const data = await planner.plan(q);
  cacheSet(key, data);
  return data;
}
```

Add a constructor — only Transitous for now, so this task stays a refactor. Declare the field before the constructor so the assignment reads in order:

```ts
private readonly planners: { transitous: TransitPlanner };

constructor(transitous: TransitousPlanner) {
  this.planners = { transitous };
}
```

(Task 7 widens this to `Record<TransitProvider, TransitPlanner>` and adds the `DatabaseService`.)

- [ ] **Step 4: Register the planner in `transit.module.ts`**

```ts
providers: [TransitService, TransitMcp, TransitousPlanner],
```

- [ ] **Step 5: Run the suite and adjust the e2e body assertion if needed**

Run from `server/`:
```bash
npx vitest run tests/unit/nest/transit.service.test.ts
npm run test:e2e
npm run typecheck --workspace=server
```
Two edits are expected, and only these two:

1. `server/tests/unit/nest/transit.service.test.ts:26` builds the service with `const svc = new TransitService();`. It now needs the planner: `const svc = new TransitService(new TransitousPlanner());`, plus the import. Nothing else in that file changes — the module-scoped cache and the `fetchMock` / `okJson` helpers keep working, because `TransitousPlanner` calls the same global `fetch`.
2. `GET /api/transit/plan` now returns `{ itineraries, isTimetable: true }`. If `tests/e2e/transit.e2e.test.ts` asserts the body with `toEqual` on the whole object, add `isTimetable: true`. If it asserts fields individually it passes untouched.

If any **assertion** in `transit.service.test.ts` has to change, the refactor changed behaviour — fix the source, not the test.

- [ ] **Step 6: Commit**

```bash
git add server/src/nest/transit server/tests/e2e/transit.e2e.test.ts
git commit -m "refactor(transit): introduce TransitPlanner and move the MOTIS planner behind it"
```

---

### Task 3: Provider setting and NAVITIME key storage

**Files:**
- Create: `server/src/nest/transit/transit.settings.ts`
- Modify: `server/src/nest/settings/instance-api-keys.ts`
- Modify: `server/src/nest/auth/auth.helpers.ts:32-39`
- Modify: `server/src/nest/auth/auth.service.ts` (`getAppSettings`, `updateAppSettings`)
- Test: `server/tests/unit/nest/transit.settings.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `readTransitProvider(db: DatabaseService): TransitProvider`, `readNavitimeApiKey(db: DatabaseService): string | null`.

- [ ] **Step 1: Widen `instance-api-keys.ts`**

```ts
export type InstanceApiKeyName = 'maps_api_key' | 'unsplash_api_key' | 'navitime_api_key';

/**
 * Instance names whose per-user column is still honoured as a last resort.
 *
 * navitime_api_key is deliberately NOT here: it has no users column and no
 * legacy of personal keys, so there is no per-user tier to fall back to. It is
 * written by the admin app-settings route and read with readInstanceApiKey.
 */
export const INSTANCE_API_KEY_NAMES: readonly InstanceApiKeyName[] = ['maps_api_key', 'unsplash_api_key'];

// Partial: a name with no entry has no per-user tier, and resolveApiKey stops
// at the instance value for it.
const USER_ROW_SQL: Partial<Record<InstanceApiKeyName, string>> = {
  maps_api_key: 'SELECT maps_api_key FROM users WHERE id = ?',
  unsplash_api_key: 'SELECT unsplash_api_key FROM users WHERE id = ?',
};
```

In `resolveApiKey`, right before the user-row read:

```ts
  const sql = USER_ROW_SQL[name];
  if (!sql) return { key: null, source: null };

  const row = db.get<Record<string, string | null>>(sql, userId);
```

- [ ] **Step 2: Add both keys to `ADMIN_SETTINGS_KEYS`** (`server/src/nest/auth/auth.helpers.ts:38`)

```ts
  'passkey_login', 'webauthn_rp_id', 'webauthn_origins',
  // Transit provider selection and the NAVITIME credential. The key lands in an
  // encrypted app_settings row, the same storage the maps/unsplash instance keys
  // use, and is read back with readInstanceApiKey.
  'transit_provider', 'navitime_api_key',
];
```

- [ ] **Step 3: Mask the key on read** (`auth.service.ts`, in `getAppSettings`)

```ts
      if (row) result[key] = (key === 'smtp_pass' || key === 'admin_webhook_url' || key === 'admin_ntfy_token' || key === 'navitime_api_key') ? MASKED_SETTING_VALUE : row.value;
```

`getAppSettings` uses the bare `'••••••••'` literal today, not the `MASKED_SETTING_VALUE` import `settings.service.ts` uses. Keep the literal: matching the line you are editing beats adding an import the rest of the method ignores.

- [ ] **Step 4: Encrypt on write and keep the key out of the audit** (`auth.service.ts`, in `updateAppSettings`)

Beside the existing `admin_ntfy_token` pair:

```ts
        if (key === 'navitime_api_key' && val === '••••••••') continue;
        if (key === 'navitime_api_key' && val) val = maybe_encrypt_api_key(val) ?? val;
```

And in the debug-details loop — **this is the leak to avoid**, the loop currently excepts only `smtp_pass`:

```ts
    for (const k of changedKeys) {
      debugDetails[k] = (k === 'smtp_pass' || k === 'navitime_api_key') ? '***' : body[k];
    }
```

Add one audit-summary line beside the existing ones:

```ts
    if (changedKeys.includes('navitime_api_key')) summary.navitime_api_key_updated = true;
    if (changedKeys.includes('transit_provider')) summary.transit_provider = body.transit_provider;
```

- [ ] **Step 5: Create `transit.settings.ts`**

```ts
import { DatabaseService } from '../database/database.service';
import { readInstanceApiKey } from '../settings/instance-api-keys';
import type { TransitProvider } from './providers/transit-planner';

/**
 * Instance-wide transit configuration, read on every request.
 *
 * Free functions taking the connection, the instance-api-keys.ts precedent:
 * both values live in app_settings rows the admin writes through
 * PUT /auth/app-settings, and nothing here holds state worth a provider.
 *
 * No environment variable for either one, deliberately: an env override would
 * be a second source for a value the admin edits in the UI, and the UI could
 * then show a key the server does not use.
 */

/**
 * Defensive by design: only an exact 'navitime' switches provider. An unknown
 * value, a missing row or an install predating the setting all read as the
 * default — a misconfiguration must not pick a provider nobody chose.
 */
export function readTransitProvider(db: DatabaseService): TransitProvider {
  const row = db.get<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', 'transit_provider');
  return row?.value === 'navitime' ? 'navitime' : 'transitous';
}

/** Admin-set only. Null means "not configured", which makes the planner refuse. */
export function readNavitimeApiKey(db: DatabaseService): string | null {
  return readInstanceApiKey(db, 'navitime_api_key');
}
```

- [ ] **Step 6: Write the tests**

`server/tests/unit/nest/transit.settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readTransitProvider } from '../../../src/nest/transit/transit.settings';

function fakeDb(value: string | null | undefined) {
  return { get: () => (value === undefined ? undefined : { value }) } as never;
}

describe('readTransitProvider', () => {
  it('returns navitime on an exact match', () => {
    expect(readTransitProvider(fakeDb('navitime'))).toBe('navitime');
  });

  it('falls back to transitous when the row is missing', () => {
    expect(readTransitProvider(fakeDb(undefined))).toBe('transitous');
  });

  it.each([['NAVITIME'], [' navitime'], ['motis'], ['']])(
    'falls back to transitous for the unusable value %j',
    (stored) => {
      expect(readTransitProvider(fakeDb(stored))).toBe('transitous');
    },
  );

  it('falls back to transitous on a null value', () => {
    expect(readTransitProvider(fakeDb(null))).toBe('transitous');
  });
});
```

Add to the existing auth app-settings test file (find it with `rg -l "app-settings|updateAppSettings" server/tests`) three cases: `navitime_api_key` is stored encrypted (the stored row is not the plaintext); re-sending `'••••••••'` leaves the stored row untouched; the audit `debugDetails` for a `navitime_api_key` change is `'***'` and never the plaintext.

- [ ] **Step 7: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/transit.settings.test.ts
npx vitest run tests/unit/nest/ -t "app settings"
npm run typecheck --workspace=server
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/nest/transit/transit.settings.ts server/src/nest/settings/instance-api-keys.ts server/src/nest/auth server/tests/unit/nest
git commit -m "feat(transit): admin-settable transit provider and NAVITIME key storage"
```

---

### Task 4: NAVITIME mode tables and request builder

**Files:**
- Create: `server/src/nest/transit/providers/navitime/navitime.modes.ts`
- Create: `server/src/nest/transit/providers/navitime/navitime.request.ts`
- Test: `server/tests/unit/nest/navitime.request.test.ts`

**Interfaces:**
- Consumes: `badRequest` (Task 1); `PlanQuery` from `transit.helpers`.
- Produces: `MOVE_MODES`, `ALWAYS_USED`, `navitimeMode(move: string | undefined): string`, `unuseFor(modes: string | undefined): string[]` from `navitime.modes.ts`; `buildNavitimeQuery(query: PlanQuery): URLSearchParams` and `NAVITIME_HOST: string`, `NAVITIME_PATH: string` from `navitime.request.ts`.

- [ ] **Step 1: Create `navitime.modes.ts`**

```ts
/**
 * NAVITIME's `move` vocabulary mapped to TREK's leg modes.
 *
 * Read left to right by the mapper (label a leg) and right to left by the
 * request builder (build `unuse`). The keys are also, ALWAYS_USED aside, exactly
 * the values `unuse` accepts.
 *
 * The ordinary trains map onto REGIONAL_RAIL / LONG_DISTANCE rather than RAIL on
 * purpose: the client's "rail" chip is
 * 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN'
 * (TransitSearchPanel.tsx:44) and never emits RAIL, which in the MOTIS taxonomy
 * swallows SUBWAY. With RAIL as the target, unchecking any single chip would put
 * every train into `unuse` — unchecking "ferry" in Tokyo would drop the Yamanote
 * line. The displayed mode is unaffected: the client only tests `=== 'WALK'` and
 * uses the mode as the fallback label when `line` is null, and NAVITIME always
 * sends line_name on a transit move.
 *
 * Known limit, documented rather than worked around: the client's `subway`,
 * `tram` and `cable` chips have no NAVITIME key at all. Unchecking "subway"
 * does not remove the Tokyo Metro (it arrives as local_train), and selecting
 * only "tram" returns nothing. That is the granularity of the data, not a bug;
 * hiding those chips would mean exposing the provider to the client.
 */
export const MOVE_MODES: Record<string, string> = {
  walk: 'WALK',
  car: 'OTHER',
  bicycle: 'OTHER',
  unknown: 'OTHER',
  domestic_flight: 'AIRPLANE',
  ferry: 'FERRY',
  superexpress_train: 'HIGHSPEED_RAIL',
  sleeper_ultraexpress: 'NIGHT_RAIL',
  local_train: 'REGIONAL_RAIL',
  rapid_train: 'REGIONAL_RAIL',
  semiexpress_train: 'REGIONAL_RAIL',
  express_train: 'REGIONAL_RAIL',
  ultraexpress_train: 'LONG_DISTANCE',
  local_bus: 'BUS',
  shuttle_bus: 'COACH',
  highway_bus: 'COACH',
};

/** Never sent in `unuse`: walking is how a journey reaches its first stop. */
export const ALWAYS_USED: readonly string[] = ['walk', 'car', 'bicycle', 'unknown'];

/** A leg's TREK mode. Unknown keys become OTHER — the schema wants ^[A-Z_]+$, never empty. */
export function navitimeMode(move: string | undefined): string {
  if (!move) return 'OTHER';
  return MOVE_MODES[move] ?? 'OTHER';
}

/**
 * The `unuse` keys for a TREK include-list. `modes` undefined means "no filter",
 * which is what the client sends when every chip is checked.
 */
export function unuseFor(modes: string | undefined): string[] {
  if (!modes) return [];
  const wanted = new Set(modes.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  return Object.keys(MOVE_MODES).filter(
    (key) => !ALWAYS_USED.includes(key) && !wanted.has(MOVE_MODES[key]),
  );
}
```

- [ ] **Step 2: Create `navitime.request.ts`**

```ts
import { localParts, resolveTimeZone } from '../../../common/timezoneService';
import { badRequest } from '../../transit.http';
import type { PlanQuery } from '../../transit.helpers';
import { unuseFor } from './navitime.modes';

/**
 * The /route_transit query string. Pure so it can be asserted without a network
 * stub — the local-time conversion and the `unuse` separator are the two things
 * most likely to regress silently.
 */

export const NAVITIME_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
export const NAVITIME_PATH = '/route_transit';

// Matches numItineraries=8 on the MOTIS side so the picker offers the same depth.
const ITINERARY_LIMIT = '8';

/**
 * NAVITIME wants a bare local date-time at the timezone of the point the time
 * anchors to: the origin for depart-by, the destination for arrive-by. localParts
 * yields HH:MM, hence the appended seconds.
 */
function nakedLocalTime(iso: string, coord: string): string {
  const [lat, lng] = coord.split(',').map(Number);
  const timezone = resolveTimeZone(lat, lng);
  if (!timezone) throw badRequest(`Unable to resolve timezone for ${coord}`);
  const parts = localParts(iso, timezone);
  if (!parts.date || !parts.time) throw badRequest('time must be an ISO date-time');
  return `${parts.date}T${parts.time}:00`;
}

export function buildNavitimeQuery(query: PlanQuery): URLSearchParams {
  const params = new URLSearchParams({
    start: query.from,
    goal: query.to,
    limit: ITINERARY_LIMIT,
    shape: 'true',
    shape_color: 'railway_line',
    // The geometry assembly counts one transport feature per inter-stop hop, so
    // it needs calling_at. Without this option nothing is drawn at all.
    options: 'railway_calling_at',
  });

  if (query.time) {
    const anchor = query.arriveBy ? query.to : query.from;
    params.set(query.arriveBy ? 'goal_time' : 'start_time', nakedLocalTime(query.time, anchor));
  }

  const unuse = unuseFor(query.modes);
  // Period-separated ("ピリオド区切り"), not comma-separated. A comma here is
  // silently ignored upstream and every mode comes back.
  if (unuse.length > 0) params.set('unuse', unuse.join('.'));

  return params;
}
```

- [ ] **Step 3: Write the tests**

`server/tests/unit/nest/navitime.request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNavitimeQuery } from '../../../src/nest/transit/providers/navitime/navitime.request';
import { navitimeMode, unuseFor } from '../../../src/nest/transit/providers/navitime/navitime.modes';

const TOKYO = { from: '35.69803,139.703839', to: '35.676398,139.699326' };

describe('buildNavitimeQuery', () => {
  it('always asks for shapes and calling_at', () => {
    const p = buildNavitimeQuery({ ...TOKYO });
    expect(p.get('shape')).toBe('true');
    expect(p.get('shape_color')).toBe('railway_line');
    expect(p.get('options')).toBe('railway_calling_at');
    expect(p.get('limit')).toBe('8');
    expect(p.get('start')).toBe(TOKYO.from);
    expect(p.get('goal')).toBe(TOKYO.to);
  });

  it('omits both time parameters when no time is given', () => {
    const p = buildNavitimeQuery({ ...TOKYO });
    expect(p.get('start_time')).toBeNull();
    expect(p.get('goal_time')).toBeNull();
  });

  it('anchors depart-by at the origin timezone as a bare local time', () => {
    // 2026-09-03T00:00:00Z is 09:00 in Tokyo.
    const p = buildNavitimeQuery({ ...TOKYO, time: '2026-09-03T00:00:00Z' });
    expect(p.get('start_time')).toBe('2026-09-03T09:00:00');
    expect(p.get('goal_time')).toBeNull();
  });

  it('anchors arrive-by at the destination timezone', () => {
    const p = buildNavitimeQuery({ ...TOKYO, time: '2026-09-03T00:00:00Z', arriveBy: true });
    expect(p.get('goal_time')).toBe('2026-09-03T09:00:00');
    expect(p.get('start_time')).toBeNull();
  });

  it('separates unuse with periods, never commas', () => {
    const p = buildNavitimeQuery({ ...TOKYO, modes: 'FERRY' });
    const unuse = p.get('unuse')!;
    expect(unuse).not.toContain(',');
    expect(unuse.split('.')).toContain('local_train');
    expect(unuse.split('.')).not.toContain('ferry');
  });

  it('sends no unuse at all when no mode filter is requested', () => {
    expect(buildNavitimeQuery({ ...TOKYO }).get('unuse')).toBeNull();
  });
});

describe('unuseFor', () => {
  it('keeps every train when the rail chip is selected', () => {
    const unuse = unuseFor('HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN');
    for (const key of ['local_train', 'rapid_train', 'semiexpress_train', 'express_train', 'ultraexpress_train', 'superexpress_train', 'sleeper_ultraexpress']) {
      expect(unuse).not.toContain(key);
    }
  });

  it('never unuses walking, even when no mode maps to WALK', () => {
    expect(unuseFor('FERRY')).not.toContain('walk');
    expect(unuseFor('TRAM')).not.toContain('walk');
  });

  it('unuses everything expressible when only unmappable chips are selected', () => {
    // Neither TRAM nor SUBWAY nor the cable modes exist in NAVITIME's vocabulary:
    // an empty result is the honest answer, not a silently ignored filter.
    expect(unuseFor('TRAM,SUBWAY').length).toBeGreaterThan(0);
  });
});

describe('navitimeMode', () => {
  it('labels the modern vocabulary', () => {
    expect(navitimeMode('local_train')).toBe('REGIONAL_RAIL');
    expect(navitimeMode('superexpress_train')).toBe('HIGHSPEED_RAIL');
    expect(navitimeMode('walk')).toBe('WALK');
    expect(navitimeMode('highway_bus')).toBe('COACH');
  });

  it('falls back to OTHER for anything unknown', () => {
    expect(navitimeMode('teleporter')).toBe('OTHER');
    expect(navitimeMode(undefined)).toBe('OTHER');
  });
});
```

- [ ] **Step 4: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/navitime.request.test.ts
npm run typecheck --workspace=server
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/nest/transit/providers/navitime server/tests/unit/nest/navitime.request.test.ts
git commit -m "feat(transit): NAVITIME mode tables and request builder"
```

---

### Task 5: Fixtures and the section→leg mapper

**Files:**
- Create: `server/tests/fixtures/navitime/route_transit.calling-at.json`
- Create: `server/src/nest/transit/providers/navitime/navitime.mapper.ts`
- Test: `server/tests/unit/nest/navitime.mapper.test.ts`

**Interfaces:**
- Consumes: `navitimeMode` (Task 4); `safeColor`, `deriveTransitStats`, `TransitItinerary`, `TransitLeg`, `TransitLegStop` (Task 1 / existing helpers).
- Produces: `interface NavitimeMapped { itinerary: TransitItinerary; transferLegs: Set<number>; isTimetable: boolean }`; `mapNavitimeItinerary(item: unknown): NavitimeMapped | null`; `interface NavitimeShapeFeature`; `navitimeShapes(item: unknown): NavitimeShapeFeature[]`.

- [ ] **Step 1: Copy the two captures in untouched**

```bash
mkdir -p server/tests/fixtures/navitime
cp /home/fdode/.config/JetBrains/IntelliJIdea2026.1/scratches/scratch_55.json server/tests/fixtures/navitime/route_transit.calling-at.json
```

A real `/route_transit` response (Tokyo, 新宿 → 代々木, 5 itineraries). It contains no key, token or auth header — verified. **Do not edit it.**

One capture, not two: `options=railway_calling_at` is always sent, so a capture taken without it describes no reachable state. The fallback path it would exercise is the same single `giveUp` the six mutations already cover.

- [ ] **Step 2: Create `navitime.mapper.ts`**

```ts
import { deriveTransitStats, safeColor, type TransitItinerary, type TransitLeg, type TransitLegStop } from '../../transit.helpers';
import { navitimeMode } from './navitime.modes';

/**
 * NAVITIME /route_transit response -> TREK itineraries. Pure, so it runs
 * straight against the committed captures rather than a hand-written fixture.
 *
 * `sections` alternates point, move, point, …: every `move` is a leg bounded by
 * its two neighbours.
 */

interface RawCoord { lat?: number; lon?: number }
interface RawPoint {
  type?: string;
  name?: string;
  coord?: RawCoord;
  node_id?: string;
  track?: string;
}
interface RawLink { is_timetable?: boolean | string; destination?: { name?: string } }
interface RawTransport {
  name?: string;
  color?: string;
  company?: { name?: string };
  calling_at?: unknown[];
  links?: RawLink[];
}
interface RawMove {
  type?: string;
  move?: string;
  from_time?: string;
  to_time?: string;
  distance?: number;
  line_name?: string;
  next_transit?: boolean;
  transport?: RawTransport;
}
type RawSection = RawPoint & RawMove;

export interface NavitimeShapeFeature {
  properties?: { ways?: string };
  geometry?: { coordinates?: [number, number][] };
}

export interface NavitimeMapped {
  /** Legs carry geometry: null at this stage — attachNavitimeGeometry fills them. */
  itinerary: TransitItinerary;
  /**
   * Indexes of the legs that are a transfer connection. The only thing the
   * geometry step needs that TransitLeg cannot express: the mode gives
   * walk-vs-transit, intermediateStops gives the count, from/to give the
   * connector's endpoints.
   */
  transferLegs: Set<number>;
  /** True only when every transit link confirms a published timetable. */
  isTimetable: boolean;
}

/** NAVITIME names the request endpoints; MOTIS calls them START/END and both sides already clean that. */
function stopName(point: RawPoint | undefined): string {
  const name = point?.name ?? '';
  if (name === 'start') return 'START';
  if (name === 'goal') return 'END';
  return name;
}

function stop(point: RawPoint | undefined, time: string | undefined): TransitLegStop {
  return {
    name: stopName(point),
    lat: typeof point?.coord?.lat === 'number' ? point.coord.lat : 0,
    lng: typeof point?.coord?.lon === 'number' ? point.coord.lon : 0,
    time: time ?? null,
    // NAVITIME has no separate scheduled time; effectiveTransitStopTime falls
    // back to `time`, so null here is correct rather than a duplicate.
    scheduledTime: null,
    track: point?.track ?? null,
  };
}

/** A link confirms a timetable only when it says so. Absent, mixed or unparsable reads as estimated. */
function linkIsTimetable(link: RawLink): boolean {
  return link.is_timetable === true || link.is_timetable === 'true';
}

export function navitimeShapes(item: unknown): NavitimeShapeFeature[] {
  const features = (item as { shapes?: { features?: unknown } })?.shapes?.features;
  return Array.isArray(features) ? (features as NavitimeShapeFeature[]) : [];
}

export function mapNavitimeItinerary(item: unknown): NavitimeMapped | null {
  const raw = item as { sections?: RawSection[]; summary?: { move?: { from_time?: string; to_time?: string; transit_count?: number } } };
  const sections = Array.isArray(raw?.sections) ? raw.sections : [];
  const startTime = raw?.summary?.move?.from_time;
  const endTime = raw?.summary?.move?.to_time;
  if (!startTime || !endTime) return null;

  const moveIndexes = sections.reduce<number[]>((acc, section, index) => {
    if (section.type === 'move') acc.push(index);
    return acc;
  }, []);
  if (moveIndexes.length === 0) return null;

  const transferLegs = new Set<number>();
  let timetabled = true;
  let sawTransitLink = false;
  const legs: TransitLeg[] = [];

  for (const [legIndex, sectionIndex] of moveIndexes.entries()) {
    const move = sections[sectionIndex];
    const from = sections[sectionIndex - 1];
    const to = sections[sectionIndex + 1];
    if (!move.from_time || !move.to_time || !from || !to) return null;

    const mode = navitimeMode(move.move);
    const transport = move.transport;

    // A transfer is the walk that follows a transit run flagged next_transit.
    // That flag is the API saying so; the alternative test (both bounding points
    // carry a node_id) also matches an ordinary station-to-station walk, which
    // does have its own shape.
    if (mode === 'WALK' && legIndex > 0 && sections[moveIndexes[legIndex - 1]].next_transit === true) {
      transferLegs.add(legIndex);
    }

    for (const link of transport?.links ?? []) {
      sawTransitLink = true;
      if (!linkIsTimetable(link)) timetabled = false;
    }

    const durationMs = new Date(move.to_time).getTime() - new Date(move.from_time).getTime();

    legs.push({
      mode,
      from: stop(from, move.from_time),
      to: stop(to, move.to_time),
      // Derived from the timestamps, not from `move.time`, which is expressed in
      // the response's `unit.time` (minutes on every capture so far).
      duration: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1000)) : 0,
      distance: typeof move.distance === 'number' ? Math.round(move.distance) : null,
      headsign: transport?.links?.[0]?.destination?.name ?? null,
      // NAVITIME puts 徒歩 in line_name on a walk; TREK expects null there.
      line: mode === 'WALK' ? null : move.line_name ?? null,
      lineColor: safeColor(transport?.color),
      lineTextColor: null,
      agency: transport?.company?.name ?? null,
      intermediateStops: Array.isArray(transport?.calling_at) ? transport.calling_at.length : 0,
      geometry: null,
      geometryPrecision: 0,
    });
  }

  const stats = deriveTransitStats(startTime, endTime, legs, raw.summary?.move?.transit_count);
  return {
    itinerary: { startTime, endTime, ...stats, legs },
    transferLegs,
    // No transit link at all means nothing confirmed a timetable.
    isTimetable: sawTransitLink && timetabled,
  };
}
```

- [ ] **Step 3: Verify against the real capture before writing tests**

```bash
cd server && npx tsx -e "
const { mapNavitimeItinerary } = require('./src/nest/transit/providers/navitime/navitime.mapper.ts');
const raw = require('../server/tests/fixtures/navitime/route_transit.calling-at.json');
for (const [i, item] of raw.items.entries()) {
  const m = mapNavitimeItinerary(item);
  console.log(i, m.itinerary.legs.length, 'legs, transfers', [...m.transferLegs], 'isTimetable', m.isTimetable);
  console.log('  ', m.itinerary.legs.map(l => \`\${l.mode}/\${l.intermediateStops}\`).join(' '));
}
"
```
If `tsx` is unavailable, write the check as a temporary vitest file instead and delete it after.
Expected: itineraries 0-3 have 3 legs with no transfers; itinerary 4 has 5 legs with `transfers [2]`; `isTimetable` is `false` everywhere (every link on this capture carries the string `'false'`); the transit legs report `intermediateStops` 2, 1, 1, 1, 0, 1 in itinerary order.

- [ ] **Step 4: Write the tests**

`server/tests/unit/nest/navitime.mapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapNavitimeItinerary } from '../../../src/nest/transit/providers/navitime/navitime.mapper';
import capture from '../../fixtures/navitime/route_transit.calling-at.json';

const items = (capture as { items: unknown[] }).items;

describe('mapNavitimeItinerary on the real capture', () => {
  it('maps every itinerary', () => {
    expect(items).toHaveLength(5);
    expect(items.map((i) => mapNavitimeItinerary(i)!.itinerary.legs.length)).toEqual([3, 3, 3, 3, 5]);
  });

  it('finds the transfer on the fifth itinerary and nowhere else', () => {
    const transfers = items.map((i) => [...mapNavitimeItinerary(i)!.transferLegs]);
    expect(transfers).toEqual([[], [], [], [], [2]]);
  });

  it('nulls `line` on walks and keeps line_name on transit', () => {
    const legs = mapNavitimeItinerary(items[4])!.itinerary.legs;
    expect(legs[0].line).toBeNull();
    expect(legs[2].line).toBeNull();
    expect(legs[1].line).toBe('都営大江戸線');
    expect(legs[3].line).toBe('ＪＲ山手線');
  });

  it('renames the request endpoints to the START/END convention', () => {
    const legs = mapNavitimeItinerary(items[0])!.itinerary.legs;
    expect(legs[0].from.name).toBe('START');
    expect(legs[legs.length - 1].to.name).toBe('END');
  });

  it('counts an absent calling_at as zero intermediate stops', () => {
    // 東新宿 -> 新宿西口 are adjacent on the Oedo line, so the transport object
    // carries no calling_at at all.
    expect(mapNavitimeItinerary(items[4])!.itinerary.legs[1].intermediateStops).toBe(0);
    expect(mapNavitimeItinerary(items[0])!.itinerary.legs[1].intermediateStops).toBe(2);
  });

  it('derives leg duration from the timestamps', () => {
    const transfer = mapNavitimeItinerary(items[4])!.itinerary.legs[2];
    // distance 0, but a real six-minute walk between two stations.
    expect(transfer.distance).toBe(0);
    expect(transfer.duration).toBe(360);
  });

  it('carries the agency and a CSS-ready colour', () => {
    const leg = mapNavitimeItinerary(items[0])!.itinerary.legs[1];
    expect(leg.agency).toBe('ＪＲ東日本');
    expect(leg.lineColor).toBe('#80C241');
    expect(leg.lineTextColor).toBeNull();
  });

  it('reports the transfer count the response gives', () => {
    expect(items.map((i) => mapNavitimeItinerary(i)!.itinerary.transfers)).toEqual([0, 0, 0, 0, 1]);
  });

  it('reads every link on this capture as estimated', () => {
    expect(items.map((i) => mapNavitimeItinerary(i)!.isTimetable)).toEqual([false, false, false, false, false]);
  });
});

describe('mapNavitimeItinerary is_timetable handling', () => {
  function withTimetable(value: unknown) {
    const item = structuredClone(items[0]) as { sections: { type?: string; transport?: { links?: { is_timetable?: unknown }[] } }[] };
    for (const section of item.sections) {
      for (const link of section.transport?.links ?? []) link.is_timetable = value;
    }
    return mapNavitimeItinerary(item)!.isTimetable;
  }

  it('accepts the boolean and the string forms', () => {
    expect(withTimetable(true)).toBe(true);
    expect(withTimetable('true')).toBe(true);
  });

  it('treats anything else as estimated', () => {
    expect(withTimetable(false)).toBe(false);
    expect(withTimetable('false')).toBe(false);
    expect(withTimetable(undefined)).toBe(false);
    expect(withTimetable('yes')).toBe(false);
  });
});

describe('mapNavitimeItinerary rejects unusable input', () => {
  it('returns null without summary times', () => {
    expect(mapNavitimeItinerary({ sections: [] })).toBeNull();
  });

  it('returns null with no moves', () => {
    expect(mapNavitimeItinerary({ summary: { move: { from_time: 'a', to_time: 'b' } }, sections: [] })).toBeNull();
  });
});
```

- [ ] **Step 5: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/navitime.mapper.test.ts
npm run typecheck --workspace=server
```
Expected: PASS. If `resolveJsonModule` is not enabled for the server tsconfig, load the fixture with `readFileSync` + `JSON.parse` instead of an import.

- [ ] **Step 6: Commit**

```bash
git add server/tests/fixtures/navitime server/src/nest/transit/providers/navitime/navitime.mapper.ts server/tests/unit/nest/navitime.mapper.test.ts
git commit -m "feat(transit): NAVITIME response mapper, with the two real captures as fixtures"
```

---

### Task 6: Geometry assembly

The heart of the port. The algorithm was prototyped and verified against both captures before this plan was written; the expected numbers below are measured, not guessed.

**Files:**
- Create: `server/src/nest/transit/providers/navitime/navitime.geometry.ts`
- Test: `server/tests/unit/nest/navitime.geometry.test.ts`

**Interfaces:**
- Consumes: `NavitimeMapped`, `NavitimeShapeFeature` (Task 5); `POLYLINE_PRECISION`, `TransitItinerary` (Task 1).
- Produces: `attachNavitimeGeometry(mapped: NavitimeMapped, features: NavitimeShapeFeature[]): { itinerary: TransitItinerary; fallback: string | null }`; `encodePolyline(coords: [number, number][], precision: number): string`.

- [ ] **Step 1: Create `navitime.geometry.ts`**

```ts
import { POLYLINE_PRECISION, type TransitItinerary } from '../../transit.helpers';
import type { NavitimeMapped, NavitimeShapeFeature } from './navitime.mapper';

/**
 * NAVITIME ships one FeatureCollection per ITINERARY, never one per leg, and
 * there is no join key: properties.section and properties.route_no are constant
 * across every feature of an itinerary. What does line up is the order — both
 * lists run along the journey — and one count:
 *
 *   NAVITIME emits exactly one transport feature per inter-stop hop, so a
 *   transit leg owns calling_at.length + 1 features.
 *
 * A transfer owns none: its path is not retrievable (the subscription has no
 * pedestrian endpoint), so it gets a two-point line between its stations. On the
 * reference capture that closes a 421 m hole.
 *
 * Nothing here measures a distance or reads a colour. Both were tried and
 * rejected: NAVITIME repeats the junction point with a different rounding (up to
 * 2.45 m apart), and properties.inline.color is styling, so two legs on
 * same-coloured lines would break the split.
 */

/** Google polyline, latitude first — the precision the client decodes with. */
export function encodePolyline(coords: [number, number][], precision: number): string {
  const factor = 10 ** precision;
  let out = '';
  let previousLat = 0;
  let previousLng = 0;
  for (const [lat, lng] of coords) {
    const scaledLat = Math.round(lat * factor);
    const scaledLng = Math.round(lng * factor);
    out += chunk(scaledLat - previousLat) + chunk(scaledLng - previousLng);
    previousLat = scaledLat;
    previousLng = scaledLng;
  }
  return out;
}

function chunk(delta: number): string {
  let value = delta < 0 ? ~(delta << 1) : delta << 1;
  let out = '';
  while (value >= 0x20) {
    out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return out + String.fromCharCode(value + 63);
}

function ways(feature: NavitimeShapeFeature | undefined): string | undefined {
  return feature?.properties?.ways;
}

/** GeoJSON is [lon, lat]; TREK polylines are latitude first. */
function toLatLng(feature: NavitimeShapeFeature): [number, number][] {
  return (feature.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]);
}

export function attachNavitimeGeometry(
  mapped: NavitimeMapped,
  features: NavitimeShapeFeature[],
): { itinerary: TransitItinerary; fallback: string | null } {
  const legs = mapped.itinerary.legs;
  const taken: (NavitimeShapeFeature[] | null)[] = legs.map(() => null);
  let cursor = 0;

  const giveUp = (reason: string) => ({
    // Every leg, not just the mismatched one: the map only draws its straight-line
    // fallback when NO leg has geometry (reservationsMapbox.ts:304,
    // ReservationOverlay.tsx:232), so partial geometry produces exactly the gap
    // this code exists to close.
    itinerary: { ...mapped.itinerary, legs: legs.map((leg) => ({ ...leg, geometry: null, geometryPrecision: 0 })) },
    fallback: reason,
  });

  for (const [index, leg] of legs.entries()) {
    if (mapped.transferLegs.has(index)) continue;

    if (leg.mode === 'WALK') {
      const start = cursor;
      while (cursor < features.length && ways(features[cursor]) === 'walk') cursor += 1;
      if (cursor === start) return giveUp(`leg ${index}: no walk feature at cursor ${cursor}`);
      taken[index] = features.slice(start, cursor);
      continue;
    }

    const need = leg.intermediateStops + 1;
    if (cursor + need > features.length) {
      return giveUp(`leg ${index}: ${need} features required, ${features.length - cursor} left`);
    }
    const slice = features.slice(cursor, cursor + need);
    if (slice.some((feature) => ways(feature) !== 'transport')) {
      return giveUp(`leg ${index}: a non-transport feature among the ${need} expected`);
    }
    taken[index] = slice;
    cursor += need;
  }

  if (cursor !== features.length) {
    return giveUp(`${features.length - cursor} feature(s) left unconsumed`);
  }

  // Only now: a connector laid before the checks would be the one drawn leg that
  // disables the fallback for all the others.
  const withGeometry = legs.map((leg, index) => {
    const coords: [number, number][] = mapped.transferLegs.has(index)
      ? [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]]
      // Concatenated raw: consecutive features share their junction point, at
      // times only to the rounding (139.701875 / 139.70188). A near-duplicate
      // point is invisible once drawn.
      : (taken[index] ?? []).flatMap(toLatLng);
    return coords.length >= 2
      ? { ...leg, geometry: encodePolyline(coords, POLYLINE_PRECISION), geometryPrecision: POLYLINE_PRECISION }
      : { ...leg, geometry: null, geometryPrecision: 0 };
  });

  return { itinerary: { ...mapped.itinerary, legs: withGeometry }, fallback: null };
}
```

- [ ] **Step 2: Write the tests**

`server/tests/unit/nest/navitime.geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapNavitimeItinerary, navitimeShapes } from '../../../src/nest/transit/providers/navitime/navitime.mapper';
import { attachNavitimeGeometry, encodePolyline } from '../../../src/nest/transit/providers/navitime/navitime.geometry';
import { decodePolylineForTest } from './helpers/decodePolyline';
import withCallingAt from '../../fixtures/navitime/route_transit.calling-at.json';

const items = (withCallingAt as { items: unknown[] }).items;

function attach(item: unknown) {
  const mapped = mapNavitimeItinerary(item)!;
  return attachNavitimeGeometry(mapped, navitimeShapes(item));
}

function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('attachNavitimeGeometry on the reference capture', () => {
  it('traces all 17 legs across the 5 itineraries', () => {
    const results = items.map(attach);
    expect(results.every((r) => r.fallback === null)).toBe(true);
    const legs = results.flatMap((r) => r.itinerary.legs);
    expect(legs).toHaveLength(17);
    expect(legs.every((leg) => typeof leg.geometry === 'string' && leg.geometry.length > 0)).toBe(true);
    expect(legs.every((leg) => leg.geometryPrecision === 6)).toBe(true);
  });

  it('closes the 421 m hole on the fifth itinerary', () => {
    const legs = attach(items[4]).itinerary.legs;
    const path = (i: number) => decodePolylineForTest(legs[i].geometry!, 6);

    // The Oedo line takes a single feature and ends at its station.
    expect(metres(path(1)[path(1).length - 1], [legs[1].to.lat, legs[1].to.lng])).toBeLessThan(5);
    // The fabricated connector links the two stations.
    expect(path(2)).toHaveLength(2);
    expect(metres(path(2)[0], [legs[1].to.lat, legs[1].to.lng])).toBeLessThan(1);
    expect(metres(path(2)[1], [legs[3].from.lat, legs[3].from.lng])).toBeLessThan(1);
    // The Yamanote resumes within 45 m of 新宿, not 421 m away.
    expect(metres(path(3)[0], [legs[3].from.lat, legs[3].from.lng])).toBeLessThan(45);
    // No gap between consecutive legs exceeds the known station<->shape offset.
    for (let i = 1; i < legs.length; i += 1) {
      const previous = decodePolylineForTest(legs[i - 1].geometry!, 6);
      expect(metres(previous[previous.length - 1], decodePolylineForTest(legs[i].geometry!, 6)[0])).toBeLessThan(240);
    }
  });

  it('gives every transit leg calling_at + 1 transport features', () => {
    // Measured on the capture: 3, 2, 2, 2, 1 and 2 features for the 6 transit legs.
    const counts = items.flatMap((item) => {
      const mapped = mapNavitimeItinerary(item)!;
      return mapped.itinerary.legs
        .filter((leg, index) => leg.mode !== 'WALK' && !mapped.transferLegs.has(index))
        .map((leg) => leg.intermediateStops + 1);
    });
    expect(counts).toEqual([3, 2, 2, 2, 1, 2]);
  });
});

describe('attachNavitimeGeometry falls back for the whole itinerary', () => {
  function mutate(index: number, change: (item: any) => void) {
    const item = structuredClone(items[index]) as any;
    change(item);
    return attach(item);
  }
  const moves = (item: any) => item.sections.filter((s: any) => s.type === 'move');

  it('when next_transit is gone', () => {
    const r = mutate(4, (item) => { delete moves(item)[1].next_transit; });
    expect(r.fallback).toBeTruthy();
    expect(r.itinerary.legs.every((leg) => leg.geometry === null)).toBe(true);
  });

  it('when shapes are absent', () => {
    const r = mutate(4, (item) => { delete item.shapes; });
    expect(r.fallback).toBeTruthy();
    expect(r.itinerary.legs.every((leg) => leg.geometry === null)).toBe(true);
  });

  it('when a calling_at entry is missing', () => {
    const r = mutate(4, (item) => { delete moves(item)[3].transport.calling_at; });
    expect(r.fallback).toBeTruthy();
  });

  it('when a calling_at entry is added', () => {
    const r = mutate(4, (item) => {
      const list = moves(item)[3].transport.calling_at;
      list.push(structuredClone(list[0]));
    });
    expect(r.fallback).toBeTruthy();
  });

  it('when a transport feature is appended', () => {
    const r = mutate(4, (item) => {
      item.shapes.features.push(structuredClone(item.shapes.features[3]));
    });
    expect(r.fallback).toBe('1 feature(s) left unconsumed');
  });

  it('when a transport feature is prepended', () => {
    const r = mutate(4, (item) => {
      item.shapes.features.unshift(structuredClone(item.shapes.features[3]));
    });
    expect(r.fallback).toBeTruthy();
  });

});

describe('encodePolyline', () => {
  it('round-trips at precision 6 within a centimetre', () => {
    const coords: [number, number][] = [[35.697933, 139.707528], [35.693277, 139.699157], [35.684601, 139.701875]];
    const back = decodePolylineForTest(encodePolyline(coords, 6), 6);
    expect(back).toHaveLength(3);
    for (const [i, coord] of coords.entries()) expect(metres(coord, back[i])).toBeLessThan(0.01);
  });
});
```

- [ ] **Step 3: Add the test-only decoder**

`server/tests/unit/nest/helpers/decodePolyline.ts` — copy the client decoder from `client/src/components/Map/transitGeometry.ts:17` so the test asserts against the algorithm that actually consumes the output:

```ts
/** Copy of the client decoder (client/src/components/Map/transitGeometry.ts) — the real consumer. */
export function decodePolylineForTest(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        if (index >= encoded.length) return coords;
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/navitime.geometry.test.ts
npm run typecheck --workspace=server
```
Expected: PASS, 17/17 traced and all 7 fallback cases total.

- [ ] **Step 5: Commit**

```bash
git add server/src/nest/transit/providers/navitime/navitime.geometry.ts server/tests/unit/nest/navitime.geometry.test.ts server/tests/unit/nest/helpers/decodePolyline.ts
git commit -m "feat(transit): NAVITIME geometry assembly, all-or-nothing per itinerary"
```

---

### Task 7: The NAVITIME planner and the dispatch

**Files:**
- Create: `server/src/nest/transit/providers/navitime/navitime.planner.ts`
- Modify: `server/src/nest/transit/transit.service.ts`
- Modify: `server/src/nest/transit/transit.module.ts`
- Test: `server/tests/unit/nest/transit.service.test.ts`

**Interfaces:**
- Consumes: `TransitPlanner`, `TransitProvider`, `TransitPlanResult` (Task 2); `readTransitProvider`, `readNavitimeApiKey` (Task 3); `buildNavitimeQuery`, `NAVITIME_HOST`, `NAVITIME_PATH` (Task 4); `mapNavitimeItinerary`, `navitimeShapes` (Task 5); `attachNavitimeGeometry` (Task 6); `fetchJson`, `notConfigured` (Task 1).
- Produces: `class NavitimePlanner implements TransitPlanner`; `TransitService.providerId(): TransitProvider`.

- [ ] **Step 1: Create `navitime.planner.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { fetchJson, notConfigured } from '../../transit.http';
import { readNavitimeApiKey } from '../../transit.settings';
import type { PlanQuery, TransitItinerary } from '../../transit.helpers';
import type { TransitPlanResult, TransitPlanner } from '../transit-planner';
import { buildNavitimeQuery, NAVITIME_HOST, NAVITIME_PATH } from './navitime.request';
import { mapNavitimeItinerary, navitimeShapes } from './navitime.mapper';
import { attachNavitimeGeometry } from './navitime.geometry';

/**
 * NAVITIME /route_transit, reached through RapidAPI. Deliberately thin: the
 * request builder, the mapper and the geometry assembly are pure functions in
 * sibling files so they run against the committed captures without a network.
 */
@Injectable()
export class NavitimePlanner implements TransitPlanner {
  readonly id = 'navitime' as const;
  private readonly logger = new Logger(NavitimePlanner.name);

  constructor(private readonly db: DatabaseService) {}

  isConfigured(): boolean {
    return readNavitimeApiKey(this.db) !== null;
  }

  async plan(query: PlanQuery): Promise<TransitPlanResult> {
    const apiKey = readNavitimeApiKey(this.db);
    if (!apiKey) throw notConfigured('The NAVITIME transit provider is not configured.');

    const params = buildNavitimeQuery(query);
    const raw = (await fetchJson(`https://${NAVITIME_HOST}${NAVITIME_PATH}?${params}`, {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': NAVITIME_HOST,
    })) as { items?: unknown[] };

    const itineraries: TransitItinerary[] = [];
    let isTimetable = true;

    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      const mapped = mapNavitimeItinerary(item);
      if (!mapped) continue;
      // maxTransfers has no /route_transit parameter, but summary.transit_count
      // carries the answer — filter rather than ignore the caller's request.
      if (query.maxTransfers !== undefined && query.maxTransfers !== null && mapped.itinerary.transfers > Number(query.maxTransfers)) {
        continue;
      }
      const { itinerary, fallback } = attachNavitimeGeometry(mapped, navitimeShapes(item));
      if (fallback) {
        // The one place a lost `options=railway_calling_at` shows up. Without this
        // line the regression is silent: everything quietly becomes straight lines.
        this.logger.warn(`NAVITIME itinerary returned without geometry — ${fallback}`);
      }
      if (!mapped.isTimetable) isTimetable = false;
      itineraries.push(itinerary);
    }

    // An empty result confirms nothing about timetables.
    return { itineraries, isTimetable: itineraries.length > 0 && isTimetable };
  }
}
```

- [ ] **Step 2: Complete the dispatch in `transit.service.ts`**

```ts
constructor(
  private readonly db: DatabaseService,
  transitous: TransitousPlanner,
  navitime: NavitimePlanner,
) {
  // Record over the union: forgetting a provider fails the typecheck, not a request.
  this.planners = { transitous, navitime };
}

private readonly planners: Record<TransitProvider, TransitPlanner>;

/** The configured provider's id — the value stored in transit reservation metadata. */
providerId(): TransitProvider {
  return readTransitProvider(this.db);
}
```

In `plan()`, replace `const planner = this.planners.transitous;` with:

```ts
  const planner = this.planners[readTransitProvider(this.db)];
  if (!planner.isConfigured()) {
    throw notConfigured(`The ${planner.id} transit provider is not configured.`);
  }
```

Keep the cache key exactly as written in Task 2 — it already interpolates `planner.id`.

- [ ] **Step 3: Register in `transit.module.ts`**

```ts
providers: [TransitService, TransitMcp, TransitousPlanner, NavitimePlanner],
```

- [ ] **Step 4: Write the tests**

The file builds the service at module scope and stubs the global `fetch` with `fetchMock` / `okJson`. Extend the header (the `const svc = ...` line from Task 2) to hand both planners a fake connection:

```ts
import { TransitousPlanner } from '../../../src/nest/transit/providers/transitous.planner';
import { NavitimePlanner } from '../../../src/nest/transit/providers/navitime/navitime.planner';

// One app_settings stub for both readers — the only source either of them has.
// A plaintext value reads back through decrypt_api_key untouched
// (instance-api-keys.ts keeps that legacy path), so no encryption is needed here.
const settings = new Map<string, string>();
const fakeDb = {
  get: (_sql: string, key: string) => {
    const value = settings.get(key);
    return value === undefined ? undefined : { value };
  },
} as never;

const svc = new TransitService(fakeDb, new TransitousPlanner(), new NavitimePlanner(fakeDb));
```

Then append this block. Note the docstring at the top of the file: the response cache is module-scoped and persists across cases, so **every test below uses its own coordinates**.

```ts
describe('provider dispatch', () => {
  beforeEach(() => settings.clear());

  it('TRANSIT-SVC-012: plans through Transitous when no provider is configured', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ itineraries: [] }));
    const r = await svc.plan({ from: '52.50,13.30', to: '52.51,13.31' });
    expect(r.isTimetable).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v6/plan?');
  });

  it('TRANSIT-SVC-013: plans through NAVITIME once the admin selects it', async () => {
    settings.set('transit_provider', 'navitime');
    settings.set('navitime_api_key', 'rapid-key');
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await svc.plan({ from: '35.60,139.70', to: '35.61,139.71' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('navitime-route-totalnavi.p.rapidapi.com/route_transit?');
    expect(String(url)).toContain('options=railway_calling_at');
    expect(init.headers['x-rapidapi-key']).toBe('rapid-key');
  });

  it('TRANSIT-SVC-014: 503s when NAVITIME is selected with no key anywhere', async () => {
    settings.set('transit_provider', 'navitime');
    await expect(svc.plan({ from: '35.62,139.72', to: '35.63,139.73' }))
      .rejects.toMatchObject({ status: 503 });
    // Refuse, never degrade: no silent Transitous fallback.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TRANSIT-SVC-015: falls back to Transitous for an unusable provider value', async () => {
    settings.set('transit_provider', 'motis');
    fetchMock.mockResolvedValueOnce(okJson({ itineraries: [] }));
    await svc.plan({ from: '52.52,13.32', to: '52.53,13.33' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v6/plan?');
  });

  it('TRANSIT-SVC-016: never serves one provider the other cached itineraries', async () => {
    const query = { from: '35.64,139.74', to: '35.65,139.75' };
    fetchMock.mockResolvedValueOnce(okJson({ itineraries: [] }));
    await svc.plan(query);
    settings.set('transit_provider', 'navitime');
    settings.set('navitime_api_key', 'rapid-key');
    fetchMock.mockResolvedValueOnce(okJson({ items: [] }));
    await svc.plan(query);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('rapidapi.com');
  });
});
```

- [ ] **Step 5: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/transit.service.test.ts
npm run test:e2e
npm run typecheck --workspace=server
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/nest/transit server/tests/unit/nest/transit.service.test.ts
git commit -m "feat(transit): dispatch plan() to the admin-selected provider"
```

---

### Task 8: Provider in reservation metadata

**Files:**
- Modify: `server/src/nest/transit/transit-itinerary.helpers.ts`
- Modify: `server/src/nest/transit/transit.mcp.ts:102,207`
- Test: `server/tests/unit/nest/transit-itinerary.helpers.test.ts`, `server/tests/unit/mcp/tools-transit.test.ts`

**Interfaces:**
- Consumes: `TransitProvider` (Task 2), `TransitService.providerId()` (Task 7).
- Produces: `buildTransitReservationParts(from, to, itinerary, provider: TransitProvider)`.

- [ ] **Step 1: Thread the provider through the builder**

In `transit-itinerary.helpers.ts`, change the signature and the hardcoded value:

```ts
export function buildTransitReservationParts(
  from: TransitPlaceInput,
  to: TransitPlaceInput,
  itinerary: TransitItinerary,
  provider: TransitProvider,
) {
```

```ts
  const metadata = {
    transit: {
      provider,
```

- [ ] **Step 2: Pass the configured provider from the MCP tool**

`transit.mcp.ts:207`:
```ts
      reservationParts = buildTransitReservationParts(from, to, cleaned, this.transit.providerId());
```

And make the tool copy provider-neutral (`transit.mcp.ts:102`): replace `'Search scheduled public-transit routes via Transitous between two coordinates…'` with `'Search scheduled public-transit routes between two coordinates…'`, keeping the rest of the description byte-identical.

- [ ] **Step 3: Update the affected tests**

Every existing `buildTransitReservationParts(...)` call site in `server/tests/` gains a fourth argument. Add one assertion in `transit-itinerary.helpers.test.ts`:

```ts
it('stores the provider it was told about', () => {
  const parts = buildTransitReservationParts(from, to, itinerary, 'navitime');
  expect((parts.metadata as any).transit.provider).toBe('navitime');
});
```

- [ ] **Step 4: Run the tests**

```bash
cd server && npx vitest run tests/unit/nest/transit-itinerary.helpers.test.ts tests/unit/mcp/tools-transit.test.ts
npm run typecheck --workspace=server
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/nest/transit server/tests
git commit -m "feat(transit): record the actual provider in transit reservation metadata"
```

---

### Task 9: Estimated-times banner

**Files:**
- Modify: `client/src/components/Planner/TransitSearchPanel.tsx`
- Modify: `shared/src/i18n/<23 locales>/trip.ts`
- Test: `client/src/components/Planner/TransitSearchPanel.test.tsx`

**Interfaces:**
- Consumes: the `isTimetable` field on the `GET /api/transit/plan` response (Task 2).
- Produces: nothing consumed later.

- [ ] **Step 1: Add the i18n key to all 23 locales**

In `shared/src/i18n/en/trip.ts`, beside the other `transit.*` keys (around line 47):

```ts
  'transit.estimatedTimes': 'Times are estimated — this operator does not publish a timetable for these services.',
```

French (`shared/src/i18n/fr/trip.ts`):
```ts
  'transit.estimatedTimes': 'Horaires estimés — l’opérateur ne publie pas de grille horaire pour ces services.',
```

Add a translation to every one of: `ar br ca cs de es gr hu id it ja ko nl pl ru sv tr uk vi zh zh-TW`. Japanese, since the provider is Japanese:
```ts
  'transit.estimatedTimes': '所要時間は推定です。この事業者はこれらの便の時刻表を公開していません。',
```

- [ ] **Step 2: Read the flag and render the banner**

In `TransitSearchPanel.tsx`, where `const d = await transitApi.plan({...})` is handled (around line 381), capture the flag into the panel's state alongside the itineraries, then render above the result list:

```tsx
{estimatedTimes && (
  <div
    className="text-content-muted"
    style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, padding: '7px 9px', borderRadius: 6,
      background: 'var(--bg-tertiary)', fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
    }}
  >
    <Info size={12} style={{ flexShrink: 0, marginTop: 1 }} />
    <span>{t('transit.estimatedTimes')}</span>
  </div>
)}
```

Import `Info` from `lucide-react`. Use only appearance tokens — `cd client && npm run theme:lint` fails on a colour literal. Set the state to `d.isTimetable === false` on each successful search and clear it when a search starts.

Remember `TransitSearchPanel.tsx` is not a `*Page.tsx`, so `client/src/pages/PATTERN.md` does not restrict hooks here.

- [ ] **Step 3: Write the test**

The file already mocks `transitApi`, defines an `ITINERARY` constant, a `makeProps()` builder and a `pickFromAndTo(user)` helper, and triggers a search with `getByRole('button', { name: /^Search$/ })`. Append:

```tsx
it('FE-PLANNER-TRANSIT-028: shows the estimated-times banner when the response is not timetabled', async () => {
  const user = userEvent.setup()
  render(<TransitSearchPanel {...makeProps()} />)
  await pickFromAndTo(user)
  transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY], isTimetable: false })
  await user.click(screen.getByRole('button', { name: /^Search$/ }))
  expect(await screen.findByText(/Times are estimated/)).toBeInTheDocument()
})

it('FE-PLANNER-TRANSIT-029: hides the banner when the response is timetabled', async () => {
  const user = userEvent.setup()
  render(<TransitSearchPanel {...makeProps()} />)
  await pickFromAndTo(user)
  transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY], isTimetable: true })
  await user.click(screen.getByRole('button', { name: /^Search$/ }))
  await waitFor(() => expect(screen.getByText('Zoologischer Garten')).toBeInTheDocument())
  expect(screen.queryByText(/Times are estimated/)).not.toBeInTheDocument()
})

it('FE-PLANNER-TRANSIT-030: shows no banner when the field is absent', async () => {
  // Every pre-existing case in this file resolves plan() without isTimetable.
  // `undefined === false` is false, so none of them grows a banner — this test
  // pins that so the flag can never become opt-out by accident.
  const user = userEvent.setup()
  render(<TransitSearchPanel {...makeProps()} />)
  await pickFromAndTo(user)
  transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
  await user.click(screen.getByRole('button', { name: /^Search$/ }))
  await waitFor(() => expect(screen.getByText('Zoologischer Garten')).toBeInTheDocument())
  expect(screen.queryByText(/Times are estimated/)).not.toBeInTheDocument()
})
```

- [ ] **Step 4: Run the checks**

```bash
npm run build --workspace=shared
npm run i18n:parity:strict --workspace=shared
cd client && npx vitest run src/components/Planner/TransitSearchPanel.test.tsx && npm run theme:lint
npm run typecheck --workspace=client
```
Expected: PASS, parity exit 0.

- [ ] **Step 5: Commit**

```bash
git add shared/src/i18n client/src/components/Planner/TransitSearchPanel.tsx client/src/components/Planner/TransitSearchPanel.test.tsx
git commit -m "feat(transit): estimated-times banner when the provider publishes no timetable"
```

---

### Task 10: Admin provider card

**Files:**
- Modify: `client/src/pages/admin/useAdmin.ts`
- Modify: `client/src/pages/admin/AdminSettingsTab.tsx`
- Modify: `shared/src/i18n/<23 locales>/admin.ts`
- Test: `client/src/pages/admin/AdminSettingsTab.test.tsx`

**Interfaces:**
- Consumes: `transit_provider` and `navitime_api_key` on `GET/PUT /auth/app-settings` (Task 3).
- Produces: nothing consumed later.

- [ ] **Step 1: Add the five i18n keys to all 23 locales** (`shared/src/i18n/<locale>/admin.ts`, beside `admin.apiKeys` around line 130)

English:
```ts
  'admin.transit': 'Public transit',
  'admin.transitProvider': 'Route provider',
  'admin.transitProviderHint': 'Transitous is free and needs no key. NAVITIME covers Japan and requires a RapidAPI subscription.',
  'admin.navitimeKey': 'NAVITIME API Key',
  'admin.navitimeKeyHint': 'RapidAPI key for navitime-route-totalnavi. Required when NAVITIME is the selected provider.',
```

French:
```ts
  'admin.transit': 'Transports en commun',
  'admin.transitProvider': 'Fournisseur d’itinéraires',
  'admin.transitProviderHint': 'Transitous est gratuit et ne demande aucune clé. NAVITIME couvre le Japon et exige un abonnement RapidAPI.',
  'admin.navitimeKey': 'Clé API NAVITIME',
  'admin.navitimeKeyHint': 'Clé RapidAPI pour navitime-route-totalnavi. Obligatoire quand NAVITIME est le fournisseur choisi.',
```

Translate for the other 21 locales.

- [ ] **Step 2: Extend `useAdmin.ts`**

**Read them where the app-settings row is already read**, not in `loadAppConfig` — that one fetches `GET /auth/app-config`, the public config, which carries neither key. The admin read is the effect at `useAdmin.ts:139`:

```ts
  useEffect(() => {
    apiClient.get('/auth/app-settings').then(r => {
      setSmtpValues(r.data || {})
      if (r.data?.webauthn_rp_id) setWebauthnRpId(r.data.webauthn_rp_id)
      if (r.data?.webauthn_origins) setWebauthnOrigins(r.data.webauthn_origins)
      // Anything but an exact 'navitime' shows the default, mirroring the server reader.
      setTransitProvider(r.data?.transit_provider === 'navitime' ? 'navitime' : 'transitous')
      if (r.data?.navitime_api_key) setNavitimeKey(r.data.navitime_api_key)
      setSmtpLoaded(true)
    }).catch(() => setSmtpLoaded(true))
  }, [])
```

Declare the state beside the API-keys block (`useAdmin.ts:149-155`):

```ts
  // Transit provider (instance-wide, app_settings)
  const [transitProvider, setTransitProvider] = useState<'transitous' | 'navitime'>('transitous')
  const [navitimeKey, setNavitimeKey] = useState<string>('')
  const [savingTransit, setSavingTransit] = useState<boolean>(false)
```

And one save handler that sends both fields in a single request:
Add the two `useState` declarations, and one save handler that sends both fields in a single request:

```ts
  const handleSaveTransit = async () => {
    setSavingTransit(true)
    try {
      await authApi.updateAppSettings({ transit_provider: transitProvider, navitime_api_key: navitimeKey })
      toast.success(t('common.saved'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('common.error')))
    } finally {
      setSavingTransit(false)
    }
  }
```

The server returns `navitime_api_key` as `'••••••••'` when one is stored, and re-sending that sentinel leaves the row untouched — the same contract `smtp_pass` already has, so the field can be echoed back safely.

Export `transitProvider`, `setTransitProvider`, `navitimeKey`, `setNavitimeKey`, `savingTransit`, `handleSaveTransit` from the hook's return object.

- [ ] **Step 3: Render the card in `AdminSettingsTab.tsx`**

Immediately after the `admin.apiKeys` card (which closes after the Unsplash hint around line 347), add a card following that card's exact markup conventions — `<h2>` title, `<p>` hint, labelled inputs, a save button — containing:

- a `<select>` bound to `transitProvider` with options `transitous` (label `Transitous`) and `navitime` (label `NAVITIME`), plus `{t('admin.transitProviderHint')}`;
- the NAVITIME key input, rendered only when `transitProvider === 'navitime'`, with the same show/hide eye button the maps and Unsplash fields use;
- one save button calling `handleSaveTransit`.

Colours and sizes through appearance tokens only.

- [ ] **Step 4: Write the test**

**First extend the hook factory.** `client/tests/helpers/mobileAdmin.ts` supplies every field `AdminSettingsTab` reads (`mapsKey: ''` at line 135, `savingKeys: false` at 143, `handleSaveApiKeys: vi.fn()` at 164). Add beside them:

```ts
  transitProvider: 'transitous',
  setTransitProvider: vi.fn(),
  navitimeKey: '',
  setNavitimeKey: vi.fn(),
  savingTransit: false,
  handleSaveTransit: vi.fn(),
```

Then append to `AdminSettingsTab.test.tsx`, using the file's `renderTab()` and `card()` helpers:

```tsx
describe('transit provider card', () => {
  it('FE-ADMSET-041: hides the NAVITIME key field while Transitous is selected', () => {
    renderTab({ transitProvider: 'transitous' });
    const transit = card('Public transit');
    expect(within(transit).getByRole('combobox')).toHaveValue('transitous');
    expect(within(transit).queryByText('NAVITIME API Key')).toBeNull();
  });

  it('FE-ADMSET-042: shows the NAVITIME key field once NAVITIME is selected', () => {
    renderTab({ transitProvider: 'navitime', navitimeKey: '••••••••' });
    const transit = card('Public transit');
    expect(within(transit).getByText('NAVITIME API Key')).toBeInTheDocument();
    expect(within(transit).getByDisplayValue('••••••••')).toBeInTheDocument();
  });

  it('FE-ADMSET-043: reports a provider change through the hook', () => {
    const admin = renderTab({ transitProvider: 'transitous' });
    fireEvent.change(within(card('Public transit')).getByRole('combobox'), { target: { value: 'navitime' } });
    expect(admin.setTransitProvider).toHaveBeenCalledWith('navitime');
  });

  it('FE-ADMSET-044: saves provider and key with one handler', () => {
    const admin = renderTab({ transitProvider: 'navitime', navitimeKey: 'rapid-key' });
    fireEvent.click(within(card('Public transit')).getByRole('button', { name: /save/i }));
    expect(admin.handleSaveTransit).toHaveBeenCalledTimes(1);
  });
});
```

**And one hook-level test** in `client/src/pages/admin/useAdmin.test.tsx`, which already drives `PUT /api/auth/app-settings` through msw (see the handler at line 226) — this is where "one request, both fields" is actually provable:

```tsx
it('FE-ADMHOOK-0NN: sends the provider and the NAVITIME key in one app-settings request', async () => {
  const bodies: unknown[] = [];
  server.use(
    http.get('/api/auth/app-settings', () => HttpResponse.json({ transit_provider: 'navitime', navitime_api_key: '••••••••' })),
    http.put('/api/auth/app-settings', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ success: true });
    }),
  );
  // Render the hook the way the neighbouring cases in this file do, wait for the
  // app-settings load, then call handleSaveTransit().
  // Assert exactly one PUT, carrying both fields:
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ transit_provider: 'navitime', navitime_api_key: '••••••••' });
});
```

Use the same hook-rendering helper the surrounding cases in that file use; the two `expect` blocks above are the assertions, do not weaken them.

- [ ] **Step 5: Run the checks**

```bash
npm run build --workspace=shared
npm run i18n:parity:strict --workspace=shared
cd client && npx vitest run src/pages/admin/AdminSettingsTab.test.tsx && npm run theme:lint
npm run typecheck --workspace=client
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/i18n client/src/pages/admin
git commit -m "feat(admin): transit provider selector and NAVITIME key field"
```

---

### Task 11: Full-suite gates and documentation

**Files:**
- Modify: `server/tests/e2e/transit.e2e.test.ts`
- Modify: `MCP.md` (only if it names Transitous as the transit backend)
- Modify: `server/src/nest/transit/transit.controller.ts` (docblock only)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the e2e cases**

The file boots `TransitModule` against an in-memory SQLite that already has an `app_settings` table, authenticates with `seedUser` + `sessionCookie`, and spies on `TransitService.plan` (`planSpy`). Append:

```ts
  it('returns isTimetable alongside the itineraries', async () => {
    planSpy.mockResolvedValueOnce({ itineraries: [], isTimetable: false });
    const res = await request(server)
      .get('/api/transit/plan?from=35.60,139.70&to=35.61,139.71')
      .set('Cookie', sessionCookie(1))
      .expect(200);
    expect(res.body).toEqual({ itineraries: [], isTimetable: false });
  });

  it('503s when the admin selects NAVITIME with no key configured', async () => {
    // The real dispatch has to run for this one, so drop the spy.
    planSpy.mockRestore();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('transit_provider', 'navitime')").run();
    try {
      const res = await request(server)
        .get('/api/transit/plan?from=35.62,139.72&to=35.63,139.73')
        .set('Cookie', sessionCookie(1))
        .expect(503);
      expect(res.body.error).toContain('not configured');
    } finally {
      db.prepare("DELETE FROM app_settings WHERE key = 'transit_provider'").run();
    }
  });
```

`planSpy` is re-created in this file's `beforeEach`, so `mockRestore()` inside the second case does not leak into the others — confirm that when you read the file, and if the spy is created in `beforeAll` instead, move the second case into its own `describe` with a local build.

- [ ] **Step 2: Refresh the provider-specific prose**

`transit.controller.ts` and `transit.service.ts` docblocks say the route is "proxied through Transitous". Reword to say planning goes to the admin-selected provider (Transitous by default, NAVITIME optional) and that geocoding is always Transitous. Check `MCP.md` for the same claim about the transit tools and update it identically.

- [ ] **Step 3: Run every gate**

```bash
npm run build
npm run lint
npm run test
npm run test:e2e
npm run i18n:parity:strict --workspace=shared
cd client && npm run test && npm run lint:pages && npm run theme:lint
npm run test:cov
```
Expected: all PASS, and the `src/nest/**` coverage gate stays at or above 80%.

- [ ] **Step 4: Verify the feature end to end in the running app**

```bash
npm run dev
```
Paste a real RapidAPI key into Admin → Settings and set the provider to NAVITIME, search 新宿 → 代々木 in the transit panel, confirm the itineraries appear, the estimated-times banner shows, and the map draws continuous alignments with no gap at the 新宿西口 → 新宿 transfer. Then clear the key and confirm the panel surfaces the 503 rather than silently returning Transitous results.

- [ ] **Step 5: Note the out-of-scope follow-up in the PR description**

Add this to the PR body, under a "Deliberately out of scope" heading. It is a real
weakness this work exposed, but fixing it here would break `CONTRIBUTING.md` (one focused
change per PR, no unrelated refactors):

> **TREK's transit modes are magic strings, not a type.** `SCHEDULED_TRANSIT_MODES`
> (`server/src/nest/transit/transit.helpers.ts`) is a `readonly string[]`, `TransitLeg.mode`
> is a bare `string`, `transitLegModes` in `transit-itinerary.helpers.ts` validates only
> `/^[A-Z_]+$/`, and the client's `MODE_GROUPS` (`TransitSearchPanel.tsx:44`) repeats the
> same tokens in comma-joined string literals. Nothing type-checks one against the other.
>
> That is exactly how this port's mode-mapping bug became possible: mapping NAVITIME's
> trains to `RAIL` compiled cleanly even though the client never emits `RAIL`, so any
> partial chip selection would have silently dropped every train (unchecking "ferry" in
> Tokyo would have dropped the Yamanote line). It was caught by reading the client, not by
> the compiler.
>
> Worth a follow-up issue: a shared `TransitMode` union in `@trek/shared`, consumed by the
> server whitelist, the leg schema and the client chips, so a mismatch is a build error.

- [ ] **Step 6: Commit**

```bash
git add server MCP.md
git commit -m "test(transit): e2e coverage for the provider dispatch, refresh provider-specific docs"
```
