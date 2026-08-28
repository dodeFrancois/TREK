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
 * No environment variable for either one, deliberately: an env override would be
 * a second source for a value the admin edits in the UI, and the UI could then
 * show a key the server does not use.
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
