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
    intermediateStops: link?.calling_at?.length ?? 0,
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
 * jamais une par leg, et ne donne aucune clé de jointure : `properties.section`
 * regroupe par point de passage (出発地/経由地/目的地), pas par section de route
 * — dans l'exemple de la spec, la feature `walk` et la feature `transport`
 * portent la même valeur. Les sections `move`, elles, ne portent pas de
 * coordonnées.
 *
 * Ce que la réponse garantit en revanche, c'est l'ordre : les features sont
 * listées le long du trajet, avec `properties.ways` valant 'walk' ou
 * 'transport'. On aligne donc les deux côtés par type — quand les compteurs
 * concordent, la n-ième feature d'un type est le n-ième leg de ce type. Sinon on
 * laisse ce type sans géométrie : le client retombe sur la ligne droite plutôt
 * que de tracer le chemin d'un autre leg.
 *
 * Si l'ordre s'avérait insuffisant en production, la jointure existe : avec
 * `shape_color=railway_line`, `properties.inline.color` d'une feature transport
 * vaut la couleur de `section.transport.color`.
 */
function attachGeometries(legs: TransitLeg[], features: NavitimeShapeFeature[] = []): void {
  const shapes: Record<'walk' | 'ride', Coordinate[][]> = { walk: [], ride: [] };
  for (const feature of features) {
    const line = lineString(feature);
    if (line) shapes[feature.properties?.ways === 'walk' ? 'walk' : 'ride'].push(line);
  }

  const walkLegs = legs.filter((leg) => leg.mode === 'WALK').length;
  const usable = {
    walk: shapes.walk.length === walkLegs,
    ride: shapes.ride.length === legs.length - walkLegs,
  };

  for (const leg of legs) {
    const kind = leg.mode === 'WALK' ? 'walk' : 'ride';
    const line = usable[kind] ? shapes[kind].shift() : undefined;
    if (line) leg.geometry = encodePolyline(line.map(([lng, lat]) => [lat, lng]));
  }
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
  for (let index = 1; index < sections.length - 1; index += 1) {
    const move = sections[index];
    if (move.type !== 'move') continue;
    const from = sections[index - 1];
    const to = sections[index + 1];
    if (from.type !== 'point' || to.type !== 'point') return null;
    const leg = toLeg(move, from, to);
    if (!leg) return null;
    legs.push(leg);
  }
  if (!legs.some((leg) => leg.mode !== 'WALK')) return null;

  attachGeometries(legs, route.shapes?.features);

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
