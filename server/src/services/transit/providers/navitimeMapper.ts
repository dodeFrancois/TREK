import { encodePolyline, POLYLINE_PRECISION } from '../polyline';
import type { TransitItinerary, TransitLeg, TransitLegStop } from '../types';
import { deriveTransitStats, httpError } from '../validation';
import {
  moveMode,
  type NavitimeMove,
  type NavitimePoint,
  type NavitimeResponse,
  type NavitimeRoute,
  type NavitimeShapeFeature,
} from './navitimeApi';

/** Coordonnée GeoJSON, longitude d'abord. */
type Coordinate = [lng: number, lat: number];

function trimmed(value: string | undefined): string | null {
  return value?.trim() || null;
}

function hexColor(value: string | undefined): string | null {
  const color = trimmed(value);
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

function isLat(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 90;
}

function isLng(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 180;
}

function toStop(point: NavitimePoint, time: string): TransitLegStop | null {
  const { lat, lon } = point.coord ?? {};
  if (!isLat(lat) || !isLng(lon)) return null;
  return {
    name: trimmed(point.name) ?? '',
    lat,
    lng: lon,
    time,
    scheduledTime: time,
    track: trimmed(point.track),
  };
}

function toLeg(move: NavitimeMove, from: NavitimePoint, to: NavitimePoint): TransitLeg | null {
  const departure = move.from_time;
  const arrival = move.to_time;
  const start = Date.parse(departure ?? '');
  const end = Date.parse(arrival ?? '');
  if (!departure || !arrival || Number.isNaN(start) || Number.isNaN(end)) return null;

  const origin = toStop(from, departure);
  const destination = toStop(to, arrival);
  if (!origin || !destination) return null;

  const transport = move.transport;
  const link = transport?.links?.[0];
  return {
    mode: moveMode(move.move),
    from: origin,
    to: destination,
    // NAVITIME donne aussi `time`, mais dans l'unité déclarée par `unit.time` ;
    // les horodatages, eux, ne demandent pas d'interprétation.
    duration: Math.max(0, Math.round((end - start) / 1000)),
    distance: Number.isFinite(move.distance) ? Math.max(0, Math.round(move.distance!)) : null,
    headsign: trimmed(link?.destination?.name),
    line: trimmed(transport?.name) ?? trimmed(move.line_name),
    lineColor: hexColor(transport?.color),
    lineTextColor: null,
    agency: trimmed(transport?.company?.name),
    intermediateStops: transport?.calling_at?.length ?? 0,
    geometry: null, // rempli par attachGeometries, une fois tous les legs connus
    geometryPrecision: POLYLINE_PRECISION,
  };
}

function lineString(feature: NavitimeShapeFeature): Coordinate[] | null {
  if (feature.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) return null;
  const coordinates = feature.geometry.coordinates.filter(
    (point): point is Coordinate => Array.isArray(point) && isLng(point[0]) && isLat(point[1]),
  );
  return coordinates.length >= 2 ? coordinates : null;
}

/**
 * Pose sur chaque leg le polyline de sa portion de trajet.
 *
 * NAVITIME livre la forme du trajet en une FeatureCollection par itinéraire,
 * jamais une par leg, et sans clé de jointure : les `properties` d'une feature
 * ne portent que du style, `ways`, et un `section`/`route_no` constants sur tout
 * l'itinéraire. Ce qui se recoupe, c'est l'ordre — features et sections sont
 * listées le long du trajet — et un décompte : NAVITIME émet une feature par
 * inter-gare, et `calling_at` donne les gares intermédiaires.
 *
 * On parcourt donc les deux listes de front. Un leg transit prend
 * `intermediateStops + 1` features ; une marche prend toute la série `walk` qui
 * commence là. Une correspondance ne prend rien : NAVITIME ne la trace pas, elle
 * reçoit un segment droit d'une gare à l'autre.
 *
 * Au moindre désaccord — un type qui ne tombe pas en face, un décompte plus long
 * que ce qui reste, des features non consommées à la fin — l'itinéraire entier
 * reste sans géométrie. C'est voulu : le client ne dessine ses lignes droites de
 * secours que si aucune leg n'est tracée
 * (`client/src/components/Map/reservationsMapbox.ts`), une géométrie partielle
 * laisserait un trou.
 */
function attachGeometries(legs: TransitLeg[], transfers: Set<TransitLeg>, features: NavitimeShapeFeature[] = []): void {
  const shapes: Array<{ walk: boolean; points: Coordinate[] }> = [];
  for (const feature of features) {
    const points = lineString(feature);
    if (points) shapes.push({ walk: feature.properties?.ways === 'walk', points });
  }

  const claims: Coordinate[][] = [];
  let cursor = 0;
  for (const leg of legs) {
    if (transfers.has(leg)) {
      claims.push([
        [leg.from.lng, leg.from.lat],
        [leg.to.lng, leg.to.lat],
      ]);
      continue;
    }
    const walk = leg.mode === 'WALK';
    let count = leg.intermediateStops + 1;
    if (walk) {
      count = 0;
      while (shapes[cursor + count]?.walk) count += 1;
    }
    const claim = shapes.slice(cursor, cursor + count);
    if (!count || claim.length !== count || claim.some((shape) => shape.walk !== walk)) return;
    // Les jonctions à l'intérieur d'un leg se répètent à l'arrondi près (moins
    // de trois mètres sur l'exemple) : on concatène tel quel.
    claims.push(claim.flatMap((shape) => shape.points));
    cursor += count;
  }
  if (cursor !== shapes.length) return;

  legs.forEach((leg, index) => {
    leg.geometry = encodePolyline(claims[index].map(([lng, lat]) => [lat, lng]));
  });
}

function toItinerary(route: NavitimeRoute, currency: string): TransitItinerary | null {
  const summary = route.summary?.move;
  const startTime = summary?.from_time;
  const endTime = summary?.to_time;
  if (!startTime || !endTime || Number.isNaN(Date.parse(startTime)) || Number.isNaN(Date.parse(endTime))) return null;

  // `sections` alterne point, move, point, … : chaque move devient un leg borné
  // par ses deux voisins.
  const sections = route.sections ?? [];
  const legs: TransitLeg[] = [];
  const transfers = new Set<TransitLeg>();
  for (let index = 1; index < sections.length - 1; index += 1) {
    const move = sections[index];
    if (move.type !== 'move') continue;
    const from = sections[index - 1];
    const to = sections[index + 1];
    if (from.type !== 'point' || to.type !== 'point') return null;
    const leg = toLeg(move, from, to);
    if (!leg) return null;
    legs.push(leg);
    // Le motif d'une correspondance : transit portant `next_transit`, point,
    // ce walk, point, transit. Le move d'avant est deux sections plus haut.
    const previous = sections[index - 2];
    if (leg.mode === 'WALK' && previous?.type === 'move' && previous.next_transit) transfers.add(leg);
  }
  if (!legs.some((leg) => leg.mode !== 'WALK')) return null;

  attachGeometries(legs, transfers, route.shapes?.features);

  const fare = summary?.reference_fare;
  const ticket = Number.isFinite(fare?.lowest_total_ticket) ? fare!.lowest_total_ticket! : null;
  const ic = Number.isFinite(fare?.lowest_total_ic) ? fare!.lowest_total_ic! : null;

  return {
    startTime,
    endTime,
    ...deriveTransitStats(startTime, endTime, legs, summary?.transit_count),
    legs,
    ...(ticket !== null || ic !== null ? { fare: { currency, ticket, ic } } : {}),
  };
}

/** Un itinéraire n'est horaire que si tous ses liens transit le confirment. */
function routeIsTimetable(route: NavitimeRoute): boolean {
  const links = (route.sections ?? []).flatMap((section) =>
    section.type === 'move' && moveMode(section.move) !== 'WALK' ? (section.transport?.links ?? []) : [],
  );
  return links.length > 0 && links.every((link) => link.is_timetable === true || link.is_timetable === 'true');
}

export interface NavitimeRoutes {
  itineraries: TransitItinerary[];
  /** Faux dès qu'un lien transit n'est pas adossé à un horaire publié. */
  isTimetable: boolean;
}

export function mapNavitimeResponse(value: unknown): NavitimeRoutes {
  const response = value as NavitimeResponse | null;
  if (!Array.isArray(response?.items)) throw httpError('Invalid NAVITIME response', 502);

  const currency = trimmed(response.unit?.currency) ?? 'JPY';
  const routes = response.items.flatMap((route) => {
    const itinerary = toItinerary(route, currency);
    return itinerary ? [{ itinerary, timetable: routeIsTimetable(route) }] : [];
  });

  return {
    itineraries: routes.map((route) => route.itinerary),
    // Prudent : un lien sans indication, ou des indications mêlées, valent estimé.
    isTimetable: routes.length > 0 && routes.every((route) => route.timetable),
  };
}
