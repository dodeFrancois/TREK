/**
 * Pure transit helpers shared by TransitService and the itinerary
 * validation/reservation builders in transit-itinerary.helpers.ts. Kept as
 * plain functions/consts (the maps.helpers.ts / files.constants.ts
 * precedent) — helpers never block a migration.
 */

// Modes the client may request — a strict whitelist so the proxy can't be used
// to smuggle arbitrary query values upstream. TRANSIT covers everything; the
// others let the user filter (RAIL already includes subway/suburban etc.).
export const SCHEDULED_TRANSIT_MODES = [
  'BUS',
  'COACH',
  'TRAM',
  'SUBWAY',
  'RAIL',
  'FERRY',
  'FUNICULAR',
  'AERIAL_LIFT',
  // Fine-grained rail modes so "train without subway" is expressible (RAIL
  // itself includes SUBWAY per the MOTIS mode taxonomy).
  'HIGHSPEED_RAIL',
  'LONG_DISTANCE',
  'NIGHT_RAIL',
  'REGIONAL_RAIL',
  'SUBURBAN',
] as const;

export interface TransitPlace {
  name: string;
  lat: number;
  lng: number;
  type: string;
  area: string | null;
}

export interface TransitLegStop {
  name: string;
  lat: number;
  lng: number;
  time: string | null;
  scheduledTime: string | null;
  track: string | null;
}

export interface TransitLeg {
  mode: string;
  from: TransitLegStop;
  to: TransitLegStop;
  duration: number;
  distance: number | null;
  headsign: string | null;
  line: string | null;
  lineColor: string | null;
  lineTextColor: string | null;
  agency: string | null;
  intermediateStops: number;
  /** Encoded polyline of the leg's real path (Google encoding) + its precision. */
  geometry: string | null;
  geometryPrecision: number;
}

export interface TransitItinerary {
  startTime: string;
  endTime: string;
  duration: number;
  transfers: number;
  walkSeconds: number;
  legs: TransitLeg[];
}

export interface PlanQuery {
  from: string;
  to: string;
  time?: string;
  arriveBy?: boolean;
  modes?: string;
  maxTransfers?: number;
}

export function deriveTransitStats(
  startTime: string,
  endTime: string,
  legs: TransitLeg[],
  reportedTransfers?: number,
): Pick<TransitItinerary, 'duration' | 'transfers' | 'walkSeconds'> {
  // Number.isFinite, not bare Math.max: an unparseable provider timestamp
  // yields NaN, which Math.max passes through and JSON.stringify turns into
  // null — report 0 instead of a null duration.
  const wallClock = Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000);
  return {
    duration: Number.isFinite(wallClock) ? Math.max(0, wallClock) : 0,
    transfers:
      typeof reportedTransfers === 'number'
        ? reportedTransfers
        : Math.max(0, legs.filter((leg) => leg.mode !== 'WALK').length - 1),
    walkSeconds: legs.filter((leg) => leg.mode === 'WALK').reduce((total, leg) => total + leg.duration, 0),
  };
}

/**
 * Precision of the encoded polylines TREK writes (~11 cm). MOTIS sends its own
 * precision beside the geometry and this is only the fallback; NAVITIME sends
 * raw GeoJSON, so this is what the encoder actually uses.
 */
export const POLYLINE_PRECISION = 6;

/**
 * Normalise a provider line colour to a #-prefixed value the client can drop
 * straight into CSS, or null. GTFS colours arrive as bare hex ("FF0000"), with
 * a hash, or empty; NAVITIME already sends "#80C241" — one normaliser covers both.
 */
export function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex) ? `#${hex}` : null;
}
