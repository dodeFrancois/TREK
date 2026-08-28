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

function chunk(delta: number): string {
  let value = delta < 0 ? ~(delta << 1) : delta << 1;
  let out = '';
  while (value >= 0x20) {
    out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return out + String.fromCharCode(value + 63);
}

/** Google polyline, latitude first — the encoding the client decodes with. */
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

function ways(feature: NavitimeShapeFeature | undefined): string | undefined {
  return feature?.properties?.ways;
}

/** GeoJSON is [lon, lat]; TREK polylines are latitude first. */
function toLatLng(feature: NavitimeShapeFeature): [number, number][] {
  return (feature.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon] as [number, number]);
}

export function attachNavitimeGeometry(
  mapped: NavitimeMapped,
  features: NavitimeShapeFeature[],
): { itinerary: TransitItinerary; fallback: string | null } {
  const legs = mapped.itinerary.legs;
  const taken: (NavitimeShapeFeature[] | null)[] = legs.map(() => null);
  let cursor = 0;

  const giveUp = (reason: string) => ({
    // Every leg, not just the mismatched one: the map only draws its
    // straight-line fallback when NO leg has geometry (reservationsMapbox.ts:304,
    // ReservationOverlay.tsx:232), so partial geometry produces exactly the gap
    // this code exists to close.
    itinerary: {
      ...mapped.itinerary,
      legs: legs.map((leg) => ({ ...leg, geometry: null, geometryPrecision: 0 })),
    },
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
      ? [
          [leg.from.lat, leg.from.lng],
          [leg.to.lat, leg.to.lng],
        ]
      : // Concatenated raw: consecutive features share their junction point, at
        // times only to the rounding (139.701875 / 139.70188). A near-duplicate
        // point is invisible once drawn.
        (taken[index] ?? []).flatMap(toLatLng);
    return coords.length >= 2
      ? { ...leg, geometry: encodePolyline(coords, POLYLINE_PRECISION), geometryPrecision: POLYLINE_PRECISION }
      : { ...leg, geometry: null, geometryPrecision: 0 };
  });

  return { itinerary: { ...mapped.itinerary, legs: withGeometry }, fallback: null };
}
