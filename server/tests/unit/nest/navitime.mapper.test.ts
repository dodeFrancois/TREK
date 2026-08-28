/**
 * NAVITIME-MAP-001..012 — the NAVITIME response mapper, asserted against the
 * REAL /route_transit capture rather than a hand-written fixture. The expected
 * numbers were established by reading the raw response, not by running this
 * mapper: a fixture written to match an implementation reproduces its bugs.
 */
import { describe, expect, it } from 'vitest';
import { mapNavitimeItinerary } from '../../../src/nest/transit/providers/navitime/navitime.mapper';
import capture from '../../fixtures/navitime/route_transit.calling-at.json';

const items = (capture as { items: unknown[] }).items;
const mapped = (index: number) => mapNavitimeItinerary(items[index])!;

describe('mapNavitimeItinerary on the real capture', () => {
  it('NAVITIME-MAP-001: maps all five itineraries, 17 legs in total', () => {
    expect(items).toHaveLength(5);
    expect(items.map((item) => mapNavitimeItinerary(item)!.itinerary.legs.length)).toEqual([3, 3, 3, 3, 5]);
  });

  it('NAVITIME-MAP-002: finds the transfer on the fifth itinerary and nowhere else', () => {
    expect(items.map((item) => [...mapNavitimeItinerary(item)!.transferLegs])).toEqual([[], [], [], [], [2]]);
  });

  it('NAVITIME-MAP-003: renames the request endpoints to the START/END convention', () => {
    const legs = mapped(0).itinerary.legs;
    expect(legs[0].from.name).toBe('START');
    expect(legs[legs.length - 1].to.name).toBe('END');
    // Stations keep their own names.
    expect(legs[0].to.name).toBe('新大久保');
  });

  it('NAVITIME-MAP-004: nulls `line` on walks and keeps line_name on transit', () => {
    const legs = mapped(4).itinerary.legs;
    expect(legs.map((leg) => leg.line)).toEqual([null, '都営大江戸線', null, 'ＪＲ山手線', null]);
  });

  it('NAVITIME-MAP-005: labels the trains with the client-visible rail modes', () => {
    expect(mapped(4).itinerary.legs.map((leg) => leg.mode)).toEqual([
      'WALK',
      'REGIONAL_RAIL',
      'WALK',
      'REGIONAL_RAIL',
      'WALK',
    ]);
  });

  it('NAVITIME-MAP-006: counts an absent calling_at as zero intermediate stops', () => {
    // 東新宿 -> 新宿西口 are adjacent on the Oedo line, so the transport object
    // carries no calling_at key at all. That is zero stops, not a missing value
    // reported on the next leg.
    expect(mapped(4).itinerary.legs[1].intermediateStops).toBe(0);
    expect(mapped(4).itinerary.legs[3].intermediateStops).toBe(1);
    expect(mapped(0).itinerary.legs[1].intermediateStops).toBe(2);
  });

  it('NAVITIME-MAP-007: the six transit legs report their calling_at counts', () => {
    const counts = items.flatMap((item) => {
      const m = mapNavitimeItinerary(item)!;
      return m.itinerary.legs
        .filter((leg, index) => leg.mode !== 'WALK' && !m.transferLegs.has(index))
        .map((leg) => leg.intermediateStops);
    });
    expect(counts).toEqual([2, 1, 1, 1, 0, 1]);
  });

  it('NAVITIME-MAP-008: derives leg duration from the timestamps', () => {
    const transfer = mapped(4).itinerary.legs[2];
    // distance 0, but a real six-minute walk between two stations: the transfer
    // is a leg, not an artefact.
    expect(transfer.distance).toBe(0);
    expect(transfer.duration).toBe(360);
    expect(mapped(0).itinerary.legs[1].duration).toBe(420);
  });

  it('NAVITIME-MAP-009: carries agency, headsign and a CSS-ready colour', () => {
    const leg = mapped(0).itinerary.legs[1];
    expect(leg.agency).toBe('ＪＲ東日本');
    expect(leg.lineColor).toBe('#80C241');
    expect(leg.lineTextColor).toBeNull();
    expect(leg.headsign).toBe('新宿');
    // Read from links[0].destination.name — the terminus, not the `way` list.
    expect(mapped(4).itinerary.legs[3].headsign).toBe('渋谷');
    // Walk legs have no transport block at all.
    expect(mapped(0).itinerary.legs[0].agency).toBeNull();
    expect(mapped(0).itinerary.legs[0].headsign).toBeNull();
  });

  it('NAVITIME-MAP-010: reports the transfer count the response gives', () => {
    expect(items.map((item) => mapNavitimeItinerary(item)!.itinerary.transfers)).toEqual([0, 0, 0, 0, 1]);
    // The transfer walk is mode WALK, so it never counts as a transit leg.
    expect(mapped(4).itinerary.startTime).toBe('2026-09-03T09:00:00+09:00');
    expect(mapped(4).itinerary.endTime).toBe('2026-09-03T09:40:00+09:00');
  });

  it('NAVITIME-MAP-011: reads every link on this capture as estimated', () => {
    // is_timetable is the string 'false' throughout, so this capture never
    // exercises the timetabled branch — NAVITIME-MAP-012 does.
    expect(items.map((item) => mapNavitimeItinerary(item)!.isTimetable)).toEqual([false, false, false, false, false]);
  });
});

describe('mapNavitimeItinerary is_timetable handling', () => {
  function withTimetable(value: unknown, onlyFirstLink = false): boolean {
    const item = structuredClone(items[4]) as {
      sections: { transport?: { links?: { is_timetable?: unknown }[] } }[];
    };
    let touched = false;
    for (const section of item.sections) {
      for (const link of section.transport?.links ?? []) {
        if (onlyFirstLink && touched) continue;
        link.is_timetable = value;
        touched = true;
      }
    }
    return mapNavitimeItinerary(item)!.isTimetable;
  }

  it('NAVITIME-MAP-012: accepts the boolean and the string form, and is prudent otherwise', () => {
    expect(withTimetable(true)).toBe(true);
    expect(withTimetable('true')).toBe(true);
    expect(withTimetable(false)).toBe(false);
    expect(withTimetable('false')).toBe(false);
    expect(withTimetable(undefined)).toBe(false);
    expect(withTimetable('yes')).toBe(false);
    // Mixed indications are estimated: ALL links have to confirm. The fifth
    // itinerary has two transit legs, so confirming only the first is a mix.
    expect(withTimetable(true, true)).toBe(false);
  });
});

describe('mapNavitimeItinerary rejects unusable input', () => {
  it('NAVITIME-MAP-013: returns null without summary times or without moves', () => {
    expect(mapNavitimeItinerary({ sections: [] })).toBeNull();
    expect(mapNavitimeItinerary({ summary: { move: { from_time: 'a' } }, sections: [] })).toBeNull();
    expect(
      mapNavitimeItinerary({ summary: { move: { from_time: 'a', to_time: 'b' } }, sections: [{ type: 'point' }] }),
    ).toBeNull();
    expect(mapNavitimeItinerary(undefined)).toBeNull();
  });
});
