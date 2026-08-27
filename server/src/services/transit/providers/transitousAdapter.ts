import { buildUserAgent } from '../../mapsService';
import { getAppUrl } from '../../notifications';
import { getTransitCache, setTransitCache } from '../cache';
import { POLYLINE_PRECISION } from '../polyline';
import {
  SCHEDULED_TRANSIT_MODES,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
} from '../types';
import { deriveTransitStats, httpError, isCoordinates } from '../validation';

export {
  SCHEDULED_TRANSIT_MODES,
  TRANSIT_PROVIDERS,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
  type TransitPlanResult,
  type TransitProviderId,
} from '../types';
export { deriveTransitStats } from '../validation';

/**
 * Public transit routing (#1065) backed by Transitous (api.transitous.org), the
 * community-run MOTIS instance over public GTFS feeds — free, no API key, fits
 * TREK's no-paid-providers rule. Self-hosters can point TRANSIT_API_URL at their
 * own MOTIS instance instead.
 *
 * This service is a thin, validating proxy: the browser never talks to
 * Transitous directly (their usage policy wants an identifying User-Agent with
 * contact info, which we send once from the server), and responses are mapped
 * to a compact shape so the client isn't coupled to the MOTIS schema.
 */

const TRANSIT_API_BASE = (process.env.TRANSIT_API_URL || 'https://api.transitous.org').replace(/\/+$/, '');
let userAgent: string | null = null;

function getUserAgent(): string {
  userAgent ??= buildUserAgent(getAppUrl());
  return userAgent;
}

// Modes the client may request — a strict whitelist so the proxy can't be used
// to smuggle arbitrary query values upstream. TRANSIT covers everything; the
// others let the user filter (RAIL already includes subway/suburban etc.).
const ALLOWED_MODES = new Set(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

// Short-lived response cache: planning is the expensive call per the Transitous
// usage policy, and a user toggling filters re-requests identical plans.
const CACHE_TTL = 60 * 1000;

async function upstream(path: string, params: URLSearchParams): Promise<unknown> {
  const url = `${TRANSIT_API_BASE}${path}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': getUserAgent(), Accept: 'application/json' } });
  if (!res.ok) {
    throw httpError(`Transit provider error (HTTP ${res.status})`, res.status === 429 ? 429 : 502);
  }
  return res.json();
}

// ── Geocode ──────────────────────────────────────────────────────────────────

/** Station/place search for the from/to pickers. `near` biases results. */
export async function geocode(query: string, language?: string, near?: string): Promise<{ results: TransitPlace[] }> {
  const text = (query || '').trim();
  if (text.length < 2) return { results: [] };
  if (text.length > 200) throw httpError('Query too long', 400);

  const params = new URLSearchParams({ text });
  if (language) params.set('language', language.slice(0, 5));
  if (isCoordinates(near)) params.set('place', near!);

  const key = `transitous:geo:${params.toString()}`;
  const cached = getTransitCache<{ results: TransitPlace[] }>(key, CACHE_TTL);
  if (cached) return cached as { results: TransitPlace[] };

  const raw = (await upstream('/api/v1/geocode', params)) as Array<{
    name?: string;
    lat?: number;
    lon?: number;
    type?: string;
    areas?: Array<{ name?: string; matched?: boolean; default?: boolean }>;
  }>;

  const results: TransitPlace[] = (Array.isArray(raw) ? raw : []).slice(0, 8).flatMap((m) => {
    if (typeof m.lat !== 'number' || typeof m.lon !== 'number' || !m.name) return [];
    const area = m.areas?.find((a) => a.default)?.name || m.areas?.[0]?.name || null;
    return [{ name: m.name, lat: m.lat, lng: m.lon, type: m.type || 'PLACE', area }];
  });

  const data = { results };
  setTransitCache(key, data);
  return data;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

// GTFS colors come as bare hex ("FF0000"), with hash, or empty — normalise to
// a #-prefixed value or null so the client can use them in CSS directly.
function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex) ? `#${hex}` : null;
}

interface MotisPlaceRaw {
  name?: string;
  lat?: number;
  lon?: number;
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  track?: string;
  scheduledTrack?: string;
}

function mapStop(p: MotisPlaceRaw | undefined, kind: 'departure' | 'arrival'): TransitLegStop {
  return {
    name: p?.name || '',
    lat: typeof p?.lat === 'number' ? p.lat : 0,
    lng: typeof p?.lon === 'number' ? p.lon : 0,
    time: (kind === 'departure' ? p?.departure : p?.arrival) || null,
    scheduledTime: (kind === 'departure' ? p?.scheduledDeparture : p?.scheduledArrival) || null,
    track: p?.track || p?.scheduledTrack || null,
  };
}

/** Transitous route search between two coordinates. */
export async function planTransitous(q: PlanQuery): Promise<{ itineraries: TransitItinerary[] }> {
  if (!isCoordinates(q.from)) throw httpError('from must be "lat,lng"', 400);
  if (!isCoordinates(q.to)) throw httpError('to must be "lat,lng"', 400);

  const params = new URLSearchParams({ fromPlace: q.from, toPlace: q.to, numItineraries: '8' });

  if (q.time) {
    const parsed = new Date(q.time);
    if (isNaN(parsed.getTime())) throw httpError('time must be an ISO date-time', 400);
    params.set('time', parsed.toISOString());
  }
  if (q.arriveBy) params.set('arriveBy', 'true');

  if (q.modes) {
    const modes = q.modes
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
    if (modes.some((m) => !ALLOWED_MODES.has(m))) throw httpError('unsupported transit mode', 400);
    if (modes.length > 0) params.set('transitModes', modes.join(','));
  }
  if (q.maxTransfers !== undefined && q.maxTransfers !== null) {
    const n = Number(q.maxTransfers);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw httpError('maxTransfers must be 0-10', 400);
    params.set('maxTransfers', String(n));
  }
  // We only want scheduled transit journeys in the results — a pure-walk
  // "direct" connection is what the existing OSRM footpath routing is for.
  params.set('directModes', 'WALK');

  const key = `transitous:plan:${params.toString()}`;
  const cached = getTransitCache<{ itineraries: TransitItinerary[] }>(key, CACHE_TTL);
  if (cached) return cached as { itineraries: TransitItinerary[] };

  const raw = (await upstream('/api/v6/plan', params)) as {
    itineraries?: Array<{
      duration?: number;
      startTime?: string;
      endTime?: string;
      transfers?: number;
      legs?: Array<{
        mode?: string;
        duration?: number;
        distance?: number;
        headsign?: string;
        routeShortName?: string;
        displayName?: string;
        routeColor?: string;
        routeTextColor?: string;
        agencyName?: string;
        from?: MotisPlaceRaw;
        to?: MotisPlaceRaw;
        intermediateStops?: unknown[];
        legGeometry?: { points?: string; precision?: number };
      }>;
    }>;
  };

  const itineraries: TransitItinerary[] = (raw.itineraries || []).flatMap((it) => {
    if (!it.startTime || !it.endTime || !Array.isArray(it.legs)) return [];
    const legs: TransitLeg[] = it.legs.map((leg) => ({
      mode: (leg.mode || 'WALK').toUpperCase(),
      from: mapStop(leg.from, 'departure'),
      to: mapStop(leg.to, 'arrival'),
      duration: typeof leg.duration === 'number' ? leg.duration : 0,
      distance: typeof leg.distance === 'number' ? Math.round(leg.distance) : null,
      headsign: leg.headsign || null,
      line: leg.routeShortName || leg.displayName || null,
      lineColor: safeColor(leg.routeColor),
      lineTextColor: safeColor(leg.routeTextColor),
      agency: leg.agencyName || null,
      intermediateStops: Array.isArray(leg.intermediateStops) ? leg.intermediateStops.length : 0,
      geometry: leg.legGeometry?.points || null,
      geometryPrecision: leg.legGeometry?.precision ?? POLYLINE_PRECISION,
    }));
    const stats = deriveTransitStats(it.startTime, it.endTime, legs, it.transfers);
    return [
      {
        startTime: it.startTime,
        endTime: it.endTime,
        // Wall-clock duration (start→end) so waits/transfers count — summing leg
        // run-times would understate the journey and mis-slot it in the timeline.
        ...stats,
        legs,
      },
    ];
  });

  const data = { itineraries };
  setTransitCache(key, data);
  return data;
}
