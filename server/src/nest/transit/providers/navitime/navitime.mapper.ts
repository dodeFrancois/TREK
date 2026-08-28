import {
  deriveTransitStats,
  safeColor,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
} from '../../transit.helpers';
import { navitimeMode } from './navitime.modes';

/**
 * NAVITIME /route_transit response -> TREK itineraries. Pure, so it runs
 * straight against the committed captures rather than a hand-written fixture.
 *
 * `sections` alternates point, move, point, …: every `move` is a leg bounded by
 * its two neighbours.
 */

interface RawCoord {
  lat?: number;
  lon?: number;
}

interface RawPoint {
  name?: string;
  coord?: RawCoord;
  node_id?: string;
  track?: string;
}

interface RawLink {
  is_timetable?: boolean | string;
  destination?: { name?: string };
}

interface RawTransport {
  name?: string;
  color?: string;
  company?: { name?: string };
  calling_at?: unknown[];
  links?: RawLink[];
}

interface RawMove {
  move?: string;
  from_time?: string;
  to_time?: string;
  distance?: number;
  line_name?: string;
  next_transit?: boolean;
  transport?: RawTransport;
}

type RawSection = RawPoint & RawMove & { type?: string };

export interface NavitimeShapeFeature {
  properties?: { ways?: string };
  geometry?: { coordinates?: [number, number][] };
}

export interface NavitimeMapped {
  /** Legs carry geometry: null at this stage — attachNavitimeGeometry fills them. */
  itinerary: TransitItinerary;
  /**
   * Indexes of the legs that are a transfer connection. The only thing the
   * geometry step needs that TransitLeg cannot express: the mode gives
   * walk-vs-transit, intermediateStops gives the count, from/to give the
   * connector's endpoints.
   */
  transferLegs: Set<number>;
  /** True only when every transit link confirms a published timetable. */
  isTimetable: boolean;
}

/**
 * NAVITIME names the request endpoints `start`/`goal`; MOTIS calls them
 * START/END, and both the reservation builder (cleanTransitItineraryNames) and
 * the client picker (TransitSearchPanel.tsx:384) already swap those for the
 * places the user picked. Emitting the MOTIS convention means nothing downstream
 * needs to learn a second one.
 */
function stopName(point: RawPoint | undefined): string {
  const name = point?.name ?? '';
  if (name === 'start') return 'START';
  if (name === 'goal') return 'END';
  return name;
}

function stop(point: RawPoint | undefined, time: string): TransitLegStop {
  return {
    name: stopName(point),
    lat: typeof point?.coord?.lat === 'number' ? point.coord.lat : 0,
    lng: typeof point?.coord?.lon === 'number' ? point.coord.lon : 0,
    time,
    // NAVITIME has no separate scheduled time; effectiveTransitStopTime falls
    // back to `time`, so null here is correct rather than a duplicate.
    scheduledTime: null,
    track: point?.track ?? null,
  };
}

/** A link confirms a timetable only when it says so. NAVITIME sends the boolean
 * and the string form interchangeably; absent, mixed or unparsable reads as
 * estimated, which is what raises the client's banner. */
function linkIsTimetable(link: RawLink): boolean {
  return link.is_timetable === true || link.is_timetable === 'true';
}

export function navitimeShapes(item: unknown): NavitimeShapeFeature[] {
  const features = (item as { shapes?: { features?: unknown } })?.shapes?.features;
  return Array.isArray(features) ? (features as NavitimeShapeFeature[]) : [];
}

export function mapNavitimeItinerary(item: unknown): NavitimeMapped | null {
  const raw = item as {
    sections?: RawSection[];
    summary?: { move?: { from_time?: string; to_time?: string; transit_count?: number } };
  };
  const sections = Array.isArray(raw?.sections) ? raw.sections : [];
  const startTime = raw?.summary?.move?.from_time;
  const endTime = raw?.summary?.move?.to_time;
  if (!startTime || !endTime) return null;

  const moveIndexes = sections.reduce<number[]>((acc, section, index) => {
    if (section.type === 'move') acc.push(index);
    return acc;
  }, []);
  if (moveIndexes.length === 0) return null;

  const transferLegs = new Set<number>();
  const legs: TransitLeg[] = [];
  let timetabled = true;
  let sawTransitLink = false;

  for (const [legIndex, sectionIndex] of moveIndexes.entries()) {
    const move = sections[sectionIndex];
    const from = sections[sectionIndex - 1];
    const to = sections[sectionIndex + 1];
    if (!move.from_time || !move.to_time || !from || !to) return null;

    const mode = navitimeMode(move.move);
    const transport = move.transport;

    // A transfer is the walk that follows a transit run flagged next_transit.
    // That flag is the API saying so; the alternative test — both bounding points
    // carry a node_id — also matches an ordinary station-to-station walk, which
    // does have a shape of its own.
    if (mode === 'WALK' && legIndex > 0 && sections[moveIndexes[legIndex - 1]].next_transit === true) {
      transferLegs.add(legIndex);
    }

    for (const link of transport?.links ?? []) {
      sawTransitLink = true;
      if (!linkIsTimetable(link)) timetabled = false;
    }

    const durationMs = new Date(move.to_time).getTime() - new Date(move.from_time).getTime();

    legs.push({
      mode,
      from: stop(from, move.from_time),
      to: stop(to, move.to_time),
      // Derived from the timestamps, not from `move.time`, which is expressed in
      // the response's `unit.time` (minutes on every capture so far).
      duration: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1000)) : 0,
      distance: typeof move.distance === 'number' ? Math.round(move.distance) : null,
      headsign: transport?.links?.[0]?.destination?.name ?? null,
      // NAVITIME puts 徒歩 in line_name on a walk; TREK expects null there.
      line: mode === 'WALK' ? null : move.line_name ?? null,
      lineColor: safeColor(transport?.color),
      lineTextColor: null,
      agency: transport?.company?.name ?? null,
      intermediateStops: Array.isArray(transport?.calling_at) ? transport.calling_at.length : 0,
      geometry: null,
      geometryPrecision: 0,
    });
  }

  const stats = deriveTransitStats(startTime, endTime, legs, raw.summary?.move?.transit_count);
  return {
    itinerary: { startTime, endTime, ...stats, legs },
    transferLegs,
    // No transit link at all means nothing confirmed a timetable.
    isTimetable: sawTransitLink && timetabled,
  };
}
