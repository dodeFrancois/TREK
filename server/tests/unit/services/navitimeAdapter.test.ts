import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ key: 'rapid-secret' as string | null }));

vi.mock('../../../src/services/transit/settings', () => ({
  getNavitimeKey: vi.fn(() => state.key),
}));

import { planNavitime } from '../../../src/services/transit/providers/navitimeAdapter';

const fetchMock = vi.fn();

beforeEach(() => {
  state.key = 'rapid-secret';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

/** Les douze valeurs que la spec `route_transit` accepte pour `unuse`. */
const DOCUMENTED_UNUSE = [
  'domestic_flight',
  'ferry',
  'superexpress_train',
  'sleeper_ultraexpress',
  'ultraexpress_train',
  'express_train',
  'rapid_train',
  'semiexpress_train',
  'local_train',
  'shuttle_bus',
  'local_bus',
  'highway_bus',
];

function response(fromTime = '2026-09-03T09:00:00+09:00', toTime = '2026-09-03T09:20:00+09:00') {
  return {
    unit: { currency: 'JPY' },
    items: [
      {
        summary: { move: { from_time: fromTime, to_time: toTime, transit_count: 0 } },
        sections: [
          { type: 'point', name: 'A', coord: { lat: 35.68, lon: 139.7 } },
          {
            type: 'move',
            move: 'local_train',
            distance: 1000,
            from_time: fromTime,
            to_time: toTime,
            transport: { name: 'JR', company: { name: 'JR East' }, links: [{ is_timetable: 'false' }] },
          },
          { type: 'point', name: 'B', coord: { lat: 35.69, lon: 139.71 } },
        ],
      },
    ],
  };
}

/** Les paramètres de la requête sortante. */
function sentParams(): URLSearchParams {
  return new URL(String(fetchMock.mock.calls[0][0])).searchParams;
}

describe('NAVITIME RapidAPI adapter', () => {
  it('sends RapidAPI headers and localizes a departure time at the origin', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    const result = await planNavitime(7, {
      from: '35.6800,139.7000',
      to: '35.6900,139.7100',
      time: '2026-09-03T00:00:00.000Z',
    });

    expect(result).toMatchObject({ provider: 'navitime', isTimetable: false });
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://navitime-route-totalnavi.p.rapidapi.com/route_transit');
    expect(parsed.searchParams.get('start')).toBe('35.6800,139.7000');
    expect(parsed.searchParams.get('goal')).toBe('35.6900,139.7100');
    expect(parsed.searchParams.get('start_time')).toBe('2026-09-03T09:00:00');
    expect(parsed.searchParams.get('goal_time')).toBeNull();
    expect(parsed.searchParams.get('limit')).toBe('8');
    expect(parsed.searchParams.get('shape')).toBe('true');
    expect(init.headers['X-RapidAPI-Key']).toBe('rapid-secret');
    expect(init.headers['X-RapidAPI-Host']).toBe('navitime-route-totalnavi.p.rapidapi.com');
  });

  it('localizes an arrival time at the destination', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    await planNavitime(8, {
      from: '48.8566,2.3522',
      to: '35.6900,139.7100',
      time: '2026-09-03T00:00:00.000Z',
      arriveBy: true,
    });

    expect(sentParams().get('goal_time')).toBe('2026-09-03T09:00:00');
    expect(sentParams().get('start_time')).toBeNull();
  });

  it('excludes the moves the requested modes do not cover, and only documented ones', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    await planNavitime(20, { from: '35.68,139.70', to: '35.69,139.71', modes: 'RAIL' });

    const unuse = sentParams().get('unuse')!.split(',');
    expect(unuse.every((move) => DOCUMENTED_UNUSE.includes(move))).toBe(true);
    // Les bus n'ont pas été demandés : les trois catégories doivent partir.
    expect(unuse).toEqual(expect.arrayContaining(['local_bus', 'shuttle_bus', 'highway_bus']));
    // La taxonomie ferroviaire de NAVITIME est plus grossière que celle de TREK.
    expect(unuse).not.toEqual(expect.arrayContaining(['local_train', 'superexpress_train', 'ultraexpress_train']));
  });

  it('keeps every train category when a rail-family mode is requested', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    await planNavitime(21, { from: '35.68,139.70', to: '35.69,139.71', modes: 'SUBWAY' });

    expect(sentParams().get('unuse')).not.toContain('local_train');
  });

  it('excludes the trains when only buses are requested', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    await planNavitime(22, { from: '35.68,139.70', to: '35.69,139.71', modes: 'BUS' });

    const unuse = sentParams().get('unuse')!.split(',');
    expect(unuse).toEqual(expect.arrayContaining(['local_train', 'superexpress_train', 'ferry']));
    expect(unuse).not.toContain('local_bus');
  });

  it('sends no exclusion at all when the caller asks for TRANSIT', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response() });

    await planNavitime(23, { from: '35.68,139.70', to: '35.69,139.71', modes: 'TRANSIT' });

    expect(sentParams().get('unuse')).toBeNull();
  });

  it('caches successful normalized responses for the same user and query', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => response() });
    const query = { from: '35.6811,139.7011', to: '35.6911,139.7111' };

    await planNavitime(9, query);
    await planNavitime(9, query);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached response when only maxTransfers changes', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => response() });
    const query = { from: '35.6812,139.7012', to: '35.6912,139.7112' };

    const all = await planNavitime(24, query);
    const none = await planNavitime(24, { ...query, maxTransfers: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all.itineraries).toHaveLength(1);
    expect(none.itineraries).toHaveLength(1);
  });

  it('returns a configuration error without a resolved user or admin key', async () => {
    state.key = null;

    await expect(planNavitime(10, { from: '35.6822,139.7022', to: '35.6922,139.7122' })).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves quota errors and normalizes provider failures', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(planNavitime(11, { from: '35.6833,139.7033', to: '35.6933,139.7133' })).rejects.toMatchObject({
      status: 429,
    });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(planNavitime(12, { from: '35.6844,139.7044', to: '35.6944,139.7144' })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('rejects unsupported modes before making a provider request', async () => {
    await expect(
      planNavitime(13, { from: '35.6855,139.7055', to: '35.6955,139.7155', modes: 'BUS,CAR' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks a result as timetable-backed only when all transit links say so', async () => {
    const raw = response();
    raw.items[0].sections[1].transport!.links[0].is_timetable = 'true';
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => raw });

    await expect(planNavitime(14, { from: '35.6866,139.7066', to: '35.6966,139.7166' })).resolves.toMatchObject({
      isTimetable: true,
    });
  });
});
