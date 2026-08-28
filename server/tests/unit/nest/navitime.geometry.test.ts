/**
 * NAVITIME-GEO-001..012 — the geometry assembly, asserted against the REAL
 * captures. Every distance below was measured on the response before this code
 * existed (an independent prototype produced the same numbers), so these are
 * expectations, not a transcript of the implementation.
 *
 * The decoder used here is a copy of the client's, because the client is what
 * actually consumes these polylines.
 */
import { describe, expect, it } from 'vitest';
import { mapNavitimeItinerary, navitimeShapes } from '../../../src/nest/transit/providers/navitime/navitime.mapper';
import {
  attachNavitimeGeometry,
  encodePolyline,
} from '../../../src/nest/transit/providers/navitime/navitime.geometry';
import { decodePolylineForTest } from './helpers/decodePolyline';
import capture from '../../fixtures/navitime/route_transit.calling-at.json';
import bareCapture from '../../fixtures/navitime/route_transit.no-calling-at.json';

const items = (capture as { items: unknown[] }).items;

function attach(item: unknown) {
  return attachNavitimeGeometry(mapNavitimeItinerary(item)!, navitimeShapes(item));
}

/** Great-circle metres, so the assertions read in the unit the spec uses. */
function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const path = (leg: { geometry: string | null; geometryPrecision: number }) =>
  decodePolylineForTest(leg.geometry!, leg.geometryPrecision);

describe('attachNavitimeGeometry on the reference capture', () => {
  it('NAVITIME-GEO-001: traces all 17 legs across the 5 itineraries', () => {
    const results = items.map(attach);
    expect(results.map((r) => r.fallback)).toEqual([null, null, null, null, null]);
    const legs = results.flatMap((r) => r.itinerary.legs);
    expect(legs).toHaveLength(17);
    expect(legs.every((leg) => typeof leg.geometry === 'string' && leg.geometry.length > 0)).toBe(true);
    expect(legs.every((leg) => leg.geometryPrecision === 6)).toBe(true);
  });

  it('NAVITIME-GEO-002: closes the 421 m hole on the fifth itinerary', () => {
    const legs = attach(items[4]).itinerary.legs;
    // The Oedo line owns a single feature (no calling_at = one hop) and ends at
    // its station: measured 2.6 m.
    expect(metres(path(legs[1]).at(-1)!, [legs[1].to.lat, legs[1].to.lng])).toBeLessThan(5);
    // The fabricated connector is exactly the two station coordinates.
    expect(path(legs[2])).toHaveLength(2);
    expect(metres(path(legs[2])[0], [legs[1].to.lat, legs[1].to.lng])).toBeLessThan(1);
    expect(metres(path(legs[2])[1], [legs[3].from.lat, legs[3].from.lng])).toBeLessThan(1);
    // The Yamanote resumes 41.6 m from 新宿 — not 421 m away, which is what the
    // straight-line gap used to be.
    expect(metres(path(legs[3])[0], [legs[3].from.lat, legs[3].from.lng])).toBeLessThan(45);
  });

  it('NAVITIME-GEO-003: leaves no gap larger than the known station/shape offset', () => {
    // 239.5 m is the widest measured, on the Fukutoshin line at 東新宿. Those
    // offsets are out of scope; what matters is that nothing exceeds them.
    let widest = 0;
    for (const item of items) {
      const legs = attach(item).itinerary.legs;
      for (let i = 1; i < legs.length; i += 1) {
        widest = Math.max(widest, metres(path(legs[i - 1]).at(-1)!, path(legs[i])[0]));
      }
    }
    expect(widest).toBeLessThan(240);
  });

  it('NAVITIME-GEO-004: gives each transit leg calling_at + 1 features worth of points', () => {
    // Point counts measured on the capture: the Oedo leg is one 42-point
    // feature, the Yamanote two features totalling 20 points.
    const legs = attach(items[4]).itinerary.legs;
    expect(path(legs[1])).toHaveLength(42);
    expect(path(legs[3])).toHaveLength(20);
    // And the greedy walk runs: 3 features (2+2+17) then 2 (17+2).
    expect(path(legs[0])).toHaveLength(21);
    expect(path(legs[4])).toHaveLength(19);
  });

  it('NAVITIME-GEO-005: stays far below the combined geometry budget', () => {
    // MAX_GEOMETRY_CHARS is 60 000 for a whole itinerary; the largest here is 808.
    const largest = Math.max(
      ...items.map((item) => attach(item).itinerary.legs.reduce((n, leg) => n + (leg.geometry?.length ?? 0), 0)),
    );
    expect(largest).toBeLessThan(1000);
  });
});

describe('attachNavitimeGeometry falls back for the whole itinerary', () => {
  const moves = (item: { sections: { type?: string }[] }) => item.sections.filter((s) => s.type === 'move');

  function mutate(index: number, change: (item: never) => void) {
    const item = structuredClone(items[index]);
    change(item as never);
    return attach(item);
  }

  /** Every leg null, never just the mismatched one. */
  function expectTotalFallback(result: ReturnType<typeof attach>, reason?: string) {
    expect(result.fallback).toBeTruthy();
    if (reason) expect(result.fallback).toBe(reason);
    expect(result.itinerary.legs.every((leg) => leg.geometry === null)).toBe(true);
    expect(result.itinerary.legs.every((leg) => leg.geometryPrecision === 0)).toBe(true);
  }

  it('NAVITIME-GEO-006: when next_transit is gone, so the transfer looks ordinary', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        delete (moves(item as never)[1] as { next_transit?: boolean }).next_transit;
      }),
      'leg 2: no walk feature at cursor 4',
    );
  });

  it('NAVITIME-GEO-007: when shapes are absent altogether', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        delete (item as unknown as { shapes?: unknown }).shapes;
      }),
      'leg 0: no walk feature at cursor 0',
    );
  });

  it('NAVITIME-GEO-008: when a calling_at entry goes missing', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        delete (moves(item as never)[3] as { transport?: { calling_at?: unknown } }).transport!.calling_at;
      }),
      'leg 4: no walk feature at cursor 5',
    );
  });

  it('NAVITIME-GEO-009: when a calling_at entry is added', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        const list = (moves(item as never)[3] as { transport: { calling_at: unknown[] } }).transport.calling_at;
        list.push(structuredClone(list[0]));
      }),
      'leg 3: a non-transport feature among the 3 expected',
    );
  });

  it('NAVITIME-GEO-010: when a transport feature is appended', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        const features = (item as unknown as { shapes: { features: unknown[] } }).shapes.features;
        features.push(structuredClone(features[3]));
      }),
      '1 feature(s) left unconsumed',
    );
  });

  it('NAVITIME-GEO-011: when a transport feature is prepended', () => {
    expectTotalFallback(
      mutate(4, (item) => {
        const features = (item as unknown as { shapes: { features: unknown[] } }).shapes.features;
        features.unshift(structuredClone(features[3]));
      }),
      'leg 0: no walk feature at cursor 0',
    );
  });

  it('NAVITIME-GEO-012: for every itinerary of the capture taken without railway_calling_at', () => {
    // Same request, same shapes, only calling_at missing: each transit leg then
    // claims one feature instead of its real count, the tally never balances, and
    // the log says exactly where. The dependency on the option is detected, not
    // suffered.
    const bare = (bareCapture as { items: unknown[] }).items;
    expect(bare).toHaveLength(5);
    for (const item of bare) expectTotalFallback(attach(item));
  });
});

describe('encodePolyline', () => {
  it('NAVITIME-GEO-013: round-trips through the client decoder within a centimetre', () => {
    const coords: [number, number][] = [
      [35.697933, 139.707528],
      [35.693277, 139.699157],
      [35.684601, 139.701875],
    ];
    const back = decodePolylineForTest(encodePolyline(coords, 6), 6);
    expect(back).toHaveLength(3);
    for (const [i, coord] of coords.entries()) expect(metres(coord, back[i])).toBeLessThan(0.01);
  });
});
