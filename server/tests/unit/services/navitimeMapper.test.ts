import { describe, expect, it } from 'vitest';

const response = {
  unit: { datum: 'wgs84', coord_unit: 'degree', distance: 'metre', time: 'minute', currency: 'JPY' },
  items: [
    {
      summary: {
        move: {
          from_time: '2026-09-03T09:00:00+09:00',
          to_time: '2026-09-03T09:33:00+09:00',
          transit_count: 0,
          reference_fare: { lowest_total_ticket: 200, lowest_total_ic: 199 },
        },
      },
      sections: [
        { type: 'point', name: 'start', coord: { lat: 35.69803, lon: 139.703839 } },
        {
          type: 'move',
          move: 'walk',
          line_name: '徒歩',
          distance: 797,
          time: 11,
          from_time: '2026-09-03T09:00:00+09:00',
          to_time: '2026-09-03T09:11:00+09:00',
        },
        { type: 'point', name: '新大久保', coord: { lat: 35.701245, lon: 139.700032 } },
        {
          type: 'move',
          move: 'local_train',
          line_name: 'ＪＲ山手線',
          distance: 3500,
          time: 7,
          from_time: '2026-09-03T09:13:00+09:00',
          to_time: '2026-09-03T09:20:00+09:00',
          transport: {
            name: 'ＪＲ山手線',
            color: '#80C241',
            company: { name: 'ＪＲ東日本' },
            links: [{ destination: { name: '新宿' }, is_timetable: 'false' }],
          },
        },
        { type: 'point', name: '原宿', coord: { lat: 35.670168, lon: 139.702687 } },
        {
          type: 'move',
          move: 'walk',
          line_name: '徒歩',
          distance: 980,
          time: 13,
          from_time: '2026-09-03T09:20:00+09:00',
          to_time: '2026-09-03T09:33:00+09:00',
        },
        { type: 'point', name: 'goal', coord: { lat: 35.676398, lon: 139.699326 } },
      ],
      shapes: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [139.703839, 35.69803],
                [139.700032, 35.701245],
              ],
            },
            properties: { ways: 'walk' },
          },
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [139.700032, 35.701245],
                [139.702687, 35.670168],
              ],
            },
            properties: { ways: 'transport' },
          },
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [139.702687, 35.670168],
                [139.699326, 35.676398],
              ],
            },
            properties: { ways: 'walk' },
          },
        ],
      },
    },
  ],
};

async function loadMapper(): Promise<Record<string, (...args: any[]) => any>> {
  return import('../../../src/services/transit/providers/navitimeMapper').catch(() => ({}));
}

describe('NAVITIME route_transit mapping', () => {
  it('maps sections, fares, transport details and geometry to the TREK contract', async () => {
    const mapper = await loadMapper();

    const itineraries = mapper.mapNavitimeResponse(response);

    expect(itineraries).toHaveLength(1);
    expect(itineraries[0]).toMatchObject({
      startTime: '2026-09-03T09:00:00+09:00',
      endTime: '2026-09-03T09:33:00+09:00',
      duration: 1980,
      transfers: 0,
      walkSeconds: 1440,
      fare: { currency: 'JPY', ticket: 200, ic: 199 },
    });
    expect(itineraries[0].legs).toHaveLength(3);
    expect(itineraries[0].legs.map((leg: any) => leg.mode)).toEqual(['WALK', 'RAIL', 'WALK']);
    expect(itineraries[0].legs[1]).toMatchObject({
      line: 'ＪＲ山手線',
      lineColor: '#80C241',
      agency: 'ＪＲ東日本',
      headsign: '新宿',
      geometryPrecision: 6,
    });
    expect(itineraries[0].legs.every((leg: any) => typeof leg.geometry === 'string')).toBe(true);
  });

  it('drops malformed alternatives without discarding valid ones', async () => {
    const mapper = await loadMapper();
    const mixed = { ...response, items: [{ summary: {}, sections: [] }, response.items[0]] };

    expect(mapper.mapNavitimeResponse(mixed)).toHaveLength(1);
  });

  it('matches out-of-order shape groups to transfer legs by their endpoints', async () => {
    const mapper = await loadMapper();
    const times = ['09:00', '09:05', '09:10', '09:15', '09:20', '09:25'];
    const point = (name: string, lng: number) => ({ type: 'point', name, coord: { lat: 35, lon: lng } });
    const move = (kind: string, index: number) => ({
      type: 'move',
      move: kind,
      from_time: `2026-09-03T${times[index]}:00+09:00`,
      to_time: `2026-09-03T${times[index + 1]}:00+09:00`,
      transport: kind === 'walk' ? undefined : { name: `R${index}`, links: [{ is_timetable: 'false' }] },
    });
    const feature = (kind: string, from: number, to: number) => ({
      geometry: {
        type: 'LineString',
        coordinates: [
          [from, 35],
          [to, 35],
        ],
      },
      properties: { ways: kind },
    });
    const transfer = {
      unit: { currency: 'JPY' },
      items: [
        {
          summary: {
            move: { from_time: '2026-09-03T09:00:00+09:00', to_time: '2026-09-03T09:25:00+09:00', transit_count: 1 },
          },
          sections: [
            point('A', 139),
            move('walk', 0),
            point('B', 139.01),
            move('local_train', 1),
            point('C', 139.02),
            move('walk', 2),
            point('D', 139.03),
            move('local_train', 3),
            point('E', 139.04),
            move('walk', 4),
            point('F', 139.05),
          ],
          // route_transit may list both railway groups before transfer walking shapes.
          shapes: {
            type: 'FeatureCollection',
            features: [
              feature('walk', 139, 139.01),
              feature('transport', 139.01, 139.02),
              feature('transport', 139.03, 139.04),
              feature('walk', 139.02, 139.03),
              feature('walk', 139.04, 139.05),
            ],
          },
        },
      ],
    };

    const [itinerary] = mapper.mapNavitimeResponse(transfer);

    expect(itinerary.legs).toHaveLength(5);
    expect(itinerary.legs.every((leg: any) => typeof leg.geometry === 'string')).toBe(true);
  });

  it('does not steal a later leg shape when an intermediate transfer has no shape', async () => {
    const mapper = await loadMapper();
    const raw = structuredClone(response);
    raw.items[0].sections = [
      raw.items[0].sections[0],
      { ...raw.items[0].sections[1], to_time: '2026-09-03T09:05:00+09:00' },
      { type: 'point', name: 'Missing-shape transfer', coord: { lat: 35.69, lon: 139.71 } },
      {
        type: 'move',
        move: 'walk',
        distance: 0,
        from_time: '2026-09-03T09:05:00+09:00',
        to_time: '2026-09-03T09:06:00+09:00',
      },
      { type: 'point', name: 'Second start', coord: { lat: 35.691, lon: 139.711 } },
      { ...raw.items[0].sections[3], from_time: '2026-09-03T09:06:00+09:00' },
      raw.items[0].sections[4],
      raw.items[0].sections[5],
      raw.items[0].sections[6],
    ];

    const [itinerary] = mapper.mapNavitimeResponse(raw);

    expect(itinerary.legs[1].geometry).toBeNull();
    expect(itinerary.legs.at(-1).geometry).toEqual(expect.any(String));
  });
});

describe('Google polyline encoding', () => {
  it('encodes the published reference coordinates', async () => {
    const mapper = await loadMapper();

    expect(
      mapper.encodePolyline?.(
        [
          [38.5, -120.2],
          [40.7, -120.95],
          [43.252, -126.453],
        ],
        5,
      ),
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});
