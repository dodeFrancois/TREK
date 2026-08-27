import { describe, expect, it } from 'vitest';

import { encodePolyline } from '../../../src/services/transit/polyline';
import { mapNavitimeResponse } from '../../../src/services/transit/providers/navitimeMapper';

const at = (time: string) => `2026-09-03T${time}:00+09:00`;

const point = (name: string, lat: number, lon: number) => ({ type: 'point', name, coord: { lat, lon } });

const move = (kind: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  type: 'move',
  move: kind,
  from_time: at(from),
  to_time: at(to),
  ...extra,
});

/** `ways` à null = feature sans indication de type, comme NAVITIME peut en émettre. */
const line = (ways: string | null, coordinates: Array<[number, number]>) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: ways === null ? {} : { ways },
});

function response(
  sections: Array<Record<string, unknown>>,
  options: { shapes?: unknown[]; transitCount?: number; fare?: unknown } = {},
) {
  const moves = sections.filter((section) => section.type === 'move');
  return {
    unit: { currency: 'JPY' },
    items: [
      {
        summary: {
          move: {
            from_time: moves[0].from_time,
            to_time: moves[moves.length - 1].to_time,
            transit_count: options.transitCount ?? 0,
            ...(options.fare ? { reference_fare: options.fare } : {}),
          },
        },
        sections,
        ...(options.shapes ? { shapes: { type: 'FeatureCollection', features: options.shapes } } : {}),
      },
    ],
  };
}

/** Un aller simple d'un seul leg, pour n'observer que le mode. */
const singleLeg = (kind: string) =>
  response([
    point('A', 35.68, 139.7),
    move(kind, '09:00', '09:20', { transport: { links: [{ is_timetable: 'true' }] } }),
    point('B', 35.69, 139.71),
  ]);

describe('NAVITIME route_transit mapping', () => {
  const walkShape: Array<[number, number]> = [
    [139.703839, 35.69803],
    [139.700032, 35.701245],
  ];
  const trainShape: Array<[number, number]> = [
    [139.700032, 35.701245],
    [139.702687, 35.670168],
  ];
  const lastWalkShape: Array<[number, number]> = [
    [139.702687, 35.670168],
    [139.699326, 35.676398],
  ];

  const yamanote = response(
    [
      point('start', 35.69803, 139.703839),
      move('walk', '09:00', '09:11', { line_name: '徒歩', distance: 797 }),
      point('新大久保', 35.701245, 139.700032),
      move('local_train', '09:13', '09:20', {
        distance: 3500,
        transport: {
          name: 'ＪＲ山手線',
          color: '#80C241',
          company: { name: 'ＪＲ東日本' },
          links: [{ destination: { name: '新宿' }, calling_at: [{}, {}], is_timetable: 'false' }],
        },
      }),
      point('原宿', 35.670168, 139.702687),
      move('walk', '09:20', '09:33', { distance: 980 }),
      point('goal', 35.676398, 139.699326),
    ],
    {
      fare: { lowest_total_ticket: 200, lowest_total_ic: 199 },
      shapes: [line('walk', walkShape), line('transport', trainShape), line('walk', lastWalkShape)],
    },
  );

  it('maps sections, fares and transport details to the TREK contract', () => {
    const { itineraries, isTimetable } = mapNavitimeResponse(yamanote);

    expect(isTimetable).toBe(false);
    expect(itineraries).toHaveLength(1);
    expect(itineraries[0]).toMatchObject({
      startTime: at('09:00'),
      endTime: at('09:33'),
      duration: 1980,
      transfers: 0,
      walkSeconds: 1440,
      fare: { currency: 'JPY', ticket: 200, ic: 199 },
    });
    expect(itineraries[0].legs.map((leg) => leg.mode)).toEqual(['WALK', 'RAIL', 'WALK']);
    expect(itineraries[0].legs[1]).toMatchObject({
      line: 'ＪＲ山手線',
      lineColor: '#80C241',
      agency: 'ＪＲ東日本',
      headsign: '新宿',
      intermediateStops: 2,
      distance: 3500,
      geometryPrecision: 6,
    });
  });

  it('drops malformed alternatives without discarding valid ones', () => {
    const mixed = { ...yamanote, items: [{ summary: {}, sections: [] }, yamanote.items[0]] };

    expect(mapNavitimeResponse(mixed).itineraries).toHaveLength(1);
  });

  it.each([
    ['walk', 'WALK'],
    ['local_train', 'RAIL'],
    ['rapid_train', 'RAIL'],
    ['express_train', 'RAIL'],
    ['ultraexpress_train', 'RAIL'],
    ['superexpress_train', 'HIGHSPEED_RAIL'],
    ['sleeper_ultraexpress', 'NIGHT_RAIL'],
    ['local_bus', 'BUS'],
    ['shuttle_bus', 'COACH'],
    ['highway_bus', 'COACH'],
    ['ferry', 'FERRY'],
    ['domestic_flight', 'AIRPLANE'],
    ['unknown', 'OTHER'],
    // Vocabulaire de la génération précédente : lu, mais jamais émis dans `unuse`.
    ['superexpress', 'HIGHSPEED_RAIL'],
    ['limited_express', 'RAIL'],
    ['route_bus', 'BUS'],
  ])('labels the NAVITIME move %s as %s', (kind, mode) => {
    const [itinerary] = mapNavitimeResponse(singleLeg(kind)).itineraries;

    // Un itinéraire tout à pied n'est pas un trajet en transport en commun.
    if (mode === 'WALK') expect(itinerary).toBeUndefined();
    else expect(itinerary.legs[0].mode).toBe(mode);
  });
});

describe('NAVITIME shape assignment', () => {
  it('assigns the shapes to the legs of the same kind, in route order', () => {
    const shapes: Array<[number, number]>[] = [
      [
        [139, 35],
        [139.01, 35],
      ],
      [
        [139.01, 35],
        [139.02, 35],
      ],
      [
        [139.02, 35],
        [139.03, 35],
      ],
    ];
    const raw = response(
      [
        point('A', 35, 139),
        move('walk', '09:00', '09:05'),
        point('B', 35, 139.01),
        move('local_train', '09:05', '09:10', { transport: { links: [{ is_timetable: 'true' }] } }),
        point('C', 35, 139.02),
        move('walk', '09:10', '09:15'),
        point('D', 35, 139.03),
      ],
      {
        transitCount: 0,
        shapes: [line('walk', shapes[0]), line('transport', shapes[1]), line('walk', shapes[2])],
      },
    );

    const [itinerary] = mapNavitimeResponse(raw).itineraries;

    expect(itinerary.legs.map((leg) => leg.geometry)).toEqual(
      shapes.map((shape) => encodePolyline(shape.map(([lng, lat]) => [lat, lng]))),
    );
  });

  it('leaves a kind without geometry when its shapes do not line up with its legs', () => {
    const train: Array<[number, number]> = [
      [139.02, 35],
      [139.03, 35],
    ];
    const raw = response(
      [
        point('A', 35, 139),
        move('walk', '09:00', '09:05'),
        point('B', 35, 139.01),
        // Transfert intra-gare : NAVITIME n'en donne pas la forme.
        move('walk', '09:05', '09:06'),
        point('C', 35, 139.02),
        move('local_train', '09:06', '09:12', { transport: { links: [{ is_timetable: 'true' }] } }),
        point('D', 35, 139.03),
        move('walk', '09:12', '09:15'),
        point('E', 35, 139.04),
      ],
      {
        shapes: [
          line('walk', [
            [139, 35],
            [139.01, 35],
          ]),
          line('transport', train),
          line('walk', [
            [139.03, 35],
            [139.04, 35],
          ]),
        ],
      },
    );

    const [itinerary] = mapNavitimeResponse(raw).itineraries;

    // Trois legs à pied pour deux formes : on préfère la ligne droite à un tracé
    // volé au leg suivant. Le train, lui, garde le sien.
    expect(itinerary.legs.filter((leg) => leg.mode === 'WALK').map((leg) => leg.geometry)).toEqual([null, null, null]);
    expect(itinerary.legs[2].geometry).toBe(encodePolyline(train.map(([lng, lat]) => [lat, lng])));
  });

  it('treats a feature without `ways` as transport', () => {
    const shape: Array<[number, number]> = [
      [139.7, 35.68],
      [139.71, 35.69],
    ];
    const raw = {
      ...singleLeg('local_train'),
      items: [{ ...singleLeg('local_train').items[0], shapes: { features: [line(null, shape)] } }],
    };

    const [itinerary] = mapNavitimeResponse(raw).itineraries;

    expect(itinerary.legs[0].geometry).toBe(encodePolyline(shape.map(([lng, lat]) => [lat, lng])));
  });
});

describe('NAVITIME timetable flag', () => {
  const withLinks = (links: unknown[]) =>
    response([
      point('A', 35.68, 139.7),
      move('local_train', '09:00', '09:20', { transport: { links } }),
      point('B', 35.69, 139.71),
    ]);

  it('is timetable-backed only when every transit link says so', () => {
    expect(mapNavitimeResponse(withLinks([{ is_timetable: 'true' }])).isTimetable).toBe(true);
    expect(mapNavitimeResponse(withLinks([{ is_timetable: true }])).isTimetable).toBe(true);
    expect(mapNavitimeResponse(withLinks([{ is_timetable: 'true' }, { is_timetable: 'false' }])).isTimetable).toBe(
      false,
    );
  });

  it('stays estimated when a link carries no indication at all', () => {
    expect(mapNavitimeResponse(withLinks([{ is_timetable: 'true' }, {}])).isTimetable).toBe(false);
    expect(mapNavitimeResponse(withLinks([])).isTimetable).toBe(false);
  });
});

describe('NAVITIME response guard', () => {
  it('rejects a payload without items', () => {
    expect(() => mapNavitimeResponse({ unit: { currency: 'JPY' } })).toThrow(/Invalid NAVITIME response/);
  });
});
