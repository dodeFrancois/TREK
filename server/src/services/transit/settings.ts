import { db } from '../../db/database';
import { decrypt_api_key } from '../apiKeyCrypto';
import type { TransitProviderId } from './types';

export function getTransitProvider(): TransitProviderId {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'transit_provider'").get() as
    | { value: string }
    | undefined;
  return row?.value === 'navitime' ? 'navitime' : 'transitous';
}

export function getNavitimeKey(userId: number): string | null {
  const user = db.prepare('SELECT navitime_rapidapi_key FROM users WHERE id = ?').get(userId) as
    | { navitime_rapidapi_key: string | null }
    | undefined;
  const userKey = decrypt_api_key(user?.navitime_rapidapi_key);
  if (userKey) return userKey;

  const admin = db
    .prepare(
      "SELECT navitime_rapidapi_key FROM users WHERE role = 'admin' AND navitime_rapidapi_key IS NOT NULL AND navitime_rapidapi_key != '' LIMIT 1",
    )
    .get() as { navitime_rapidapi_key: string } | undefined;
  return decrypt_api_key(admin?.navitime_rapidapi_key) || null;
}
