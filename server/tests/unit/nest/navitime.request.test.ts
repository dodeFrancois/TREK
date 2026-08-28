/**
 * NAVITIME-REQ-001..013 — the outbound half of the NAVITIME provider: the mode
 * tables and the /route_transit query string. Pure, so no network stub is needed.
 */
import { describe, expect, it } from 'vitest';
import { buildNavitimeQuery } from '../../../src/nest/transit/providers/navitime/navitime.request';
import { navitimeMode, unuseFor } from '../../../src/nest/transit/providers/navitime/navitime.modes';

const TOKYO = { from: '35.69803,139.703839', to: '35.676398,139.699326' };

describe('buildNavitimeQuery', () => {
  it('NAVITIME-REQ-001: always asks for shapes and calling_at', () => {
    const p = buildNavitimeQuery({ ...TOKYO });
    expect(p.get('start')).toBe(TOKYO.from);
    expect(p.get('goal')).toBe(TOKYO.to);
    expect(p.get('limit')).toBe('8');
    expect(p.get('shape')).toBe('true');
    expect(p.get('shape_color')).toBe('railway_line');
    // Without calling_at the geometry assembly draws nothing at all.
    expect(p.get('options')).toBe('railway_calling_at');
  });

  it('NAVITIME-REQ-002: omits both time parameters when no time is given', () => {
    const p = buildNavitimeQuery({ ...TOKYO });
    expect(p.get('start_time')).toBeNull();
    expect(p.get('goal_time')).toBeNull();
  });

  it('NAVITIME-REQ-003: anchors depart-by at the origin timezone as a bare local time', () => {
    // 2026-09-03T00:00:00Z is 09:00 in Tokyo.
    const p = buildNavitimeQuery({ ...TOKYO, time: '2026-09-03T00:00:00Z' });
    expect(p.get('start_time')).toBe('2026-09-03T09:00:00');
    expect(p.get('goal_time')).toBeNull();
  });

  it('NAVITIME-REQ-004: anchors arrive-by at the destination timezone', () => {
    const p = buildNavitimeQuery({ ...TOKYO, time: '2026-09-03T00:00:00Z', arriveBy: true });
    expect(p.get('goal_time')).toBe('2026-09-03T09:00:00');
    expect(p.get('start_time')).toBeNull();
  });

  it('NAVITIME-REQ-005: each end anchors in its own zone, not the server’s', () => {
    // Berlin (UTC+2 in June) to Tokyo (UTC+9): the same instant is a different
    // wall clock at each end, and the anchor decides which one is sent.
    const crossing = { from: '52.52,13.405', to: '35.6812,139.7671', time: '2026-06-01T10:00:00Z' };
    expect(buildNavitimeQuery(crossing).get('start_time')).toBe('2026-06-01T12:00:00');
    expect(buildNavitimeQuery({ ...crossing, arriveBy: true }).get('goal_time')).toBe('2026-06-01T19:00:00');
  });

  it('NAVITIME-REQ-006: separates unuse with periods, never commas', () => {
    const p = buildNavitimeQuery({ ...TOKYO, modes: 'FERRY' });
    const unuse = p.get('unuse')!;
    expect(unuse).not.toContain(',');
    expect(unuse.split('.')).toContain('local_train');
    expect(unuse.split('.')).not.toContain('ferry');
  });

  it('NAVITIME-REQ-007: sends no unuse at all when no mode filter is requested', () => {
    expect(buildNavitimeQuery({ ...TOKYO }).get('unuse')).toBeNull();
  });

  it('NAVITIME-REQ-008: refuses a time it cannot place on a clock', () => {
    expect(() => buildNavitimeQuery({ ...TOKYO, time: 'not-a-date' })).toThrow();
  });
});

describe('unuseFor', () => {
  it('NAVITIME-REQ-009: keeps every train when the rail chip is selected', () => {
    // The exact string the client's "rail" chip sends (TransitSearchPanel.tsx:44).
    const unuse = unuseFor('HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN');
    for (const key of [
      'local_train',
      'rapid_train',
      'semiexpress_train',
      'express_train',
      'ultraexpress_train',
      'superexpress_train',
      'sleeper_ultraexpress',
    ]) {
      expect(unuse).not.toContain(key);
    }
  });

  it('NAVITIME-REQ-010: never unuses walking, whatever is selected', () => {
    for (const modes of ['FERRY', 'TRAM', 'SUBWAY', 'BUS,COACH']) {
      for (const always of ['walk', 'car', 'bicycle', 'unknown']) {
        expect(unuseFor(modes)).not.toContain(always);
      }
    }
  });

  it('NAVITIME-REQ-011: excludes what was not asked for', () => {
    const unuse = unuseFor('BUS,COACH');
    expect(unuse).toEqual(expect.arrayContaining(['local_train', 'ferry', 'domestic_flight']));
    expect(unuse).not.toEqual(expect.arrayContaining(['local_bus', 'shuttle_bus', 'highway_bus']));
  });

  it('NAVITIME-REQ-012: unuses everything expressible when only unmappable chips are selected', () => {
    // Neither TRAM nor SUBWAY exists in NAVITIME's vocabulary: an empty result is
    // the honest answer, not a silently ignored filter.
    expect(unuseFor('TRAM,SUBWAY').length).toBeGreaterThan(0);
    expect(unuseFor('TRAM,SUBWAY')).toContain('local_train');
  });
});

describe('navitimeMode', () => {
  it('NAVITIME-REQ-013: labels both vocabularies and falls back to OTHER', () => {
    expect(navitimeMode('walk')).toBe('WALK');
    expect(navitimeMode('local_train')).toBe('REGIONAL_RAIL');
    expect(navitimeMode('ultraexpress_train')).toBe('LONG_DISTANCE');
    expect(navitimeMode('superexpress_train')).toBe('HIGHSPEED_RAIL');
    expect(navitimeMode('highway_bus')).toBe('COACH');
    // Legacy names are readable but must never be sent back in unuse.
    expect(navitimeMode('route_bus')).toBe('BUS');
    expect(navitimeMode('limited_express')).toBe('LONG_DISTANCE');
    expect(unuseFor('BUS')).not.toContain('route_bus');
    expect(navitimeMode('teleporter')).toBe('OTHER');
    expect(navitimeMode(undefined)).toBe('OTHER');
  });
});
