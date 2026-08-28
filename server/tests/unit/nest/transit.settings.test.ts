/**
 * TRANSIT-SET-001..003 — the instance-wide transit settings readers. Both are
 * deliberately forgiving on read: a misconfigured row must fall back to the
 * default provider rather than select one nobody chose.
 */
import { describe, expect, it } from 'vitest';
import { readNavitimeApiKey, readTransitProvider } from '../../../src/nest/transit/transit.settings';

/** A DatabaseService stand-in over one app_settings row. */
function fakeDb(value: string | null | undefined) {
  return { get: () => (value === undefined ? undefined : { value }) } as never;
}

describe('readTransitProvider', () => {
  it('TRANSIT-SET-001: returns navitime on an exact match', () => {
    expect(readTransitProvider(fakeDb('navitime'))).toBe('navitime');
  });

  it('TRANSIT-SET-002: falls back to transitous for anything else', () => {
    // Missing row, null value, wrong case, stray whitespace, a provider we do
    // not have, and the empty string all mean "nobody chose navitime".
    for (const stored of [undefined, null, 'NAVITIME', ' navitime', 'motis', '']) {
      expect(readTransitProvider(fakeDb(stored))).toBe('transitous');
    }
  });
});

describe('readNavitimeApiKey', () => {
  it('TRANSIT-SET-003: reads the instance row, and null when it is unset', () => {
    // A legacy plaintext value reads back untouched (see instance-api-keys.ts).
    expect(readNavitimeApiKey(fakeDb('rapid-key'))).toBe('rapid-key');
    expect(readNavitimeApiKey(fakeDb(''))).toBeNull();
    expect(readNavitimeApiKey(fakeDb(undefined))).toBeNull();
  });
});
