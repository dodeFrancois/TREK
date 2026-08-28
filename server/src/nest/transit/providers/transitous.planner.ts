import { Injectable } from '@nestjs/common';
import { getAppUrl, readEnv } from '../../../app-config';
import { buildUserAgent } from '../../maps/maps.helpers';
import { fetchJson } from '../transit.http';
import {
  deriveTransitStats,
  POLYLINE_PRECISION,
  safeColor,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
} from '../transit.helpers';
import type { TransitPlanResult, TransitPlanner } from './transit-planner';

/**
 * Transitous (api.transitous.org), the community-run MOTIS instance over public
 * GTFS feeds — free, no API key, fits TREK's no-paid-providers rule.
 * Self-hosters can point TRANSIT_API_URL at their own MOTIS instance instead.
 *
 * The browser never talks to Transitous directly: their usage policy wants an
 * identifying User-Agent with contact info, which we send once from the server.
 *
 * The base URL and the lazy User-Agent memo stay module-scoped on purpose (the
 * permissions/exchange-rates precedent), and the base URL keeps its
 * frozen-at-import legacy timing. `upstream` is exported because geocode — which
 * is Transitous on every provider — still lives in TransitService.
 */

// Frozen at import on purpose (legacy timing).
const TRANSIT_API_BASE = readEnv().integrations.transitApiBase;
let userAgent: string | null = null;

function getUserAgent(): string {
  userAgent ??= buildUserAgent(getAppUrl());
  return userAgent;
}

/** Transitous keeps its base URL and its identifying User-Agent; the rest of the
 * upstream contract (timeout, size ceiling, 429/502) lives in transit.http.ts. */
export async function upstream(path: string, params: URLSearchParams): Promise<unknown> {
  return fetchJson(`${TRANSIT_API_BASE}${path}?${params}`, { 'User-Agent': getUserAgent() });
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
    // A missing coordinate becomes 0 (null island) rather than null on
    // purpose: TransitLegStop.lat/lng are non-nullable across the wire
    // contract (transitStopSchema, the client picker) — making them nullable
    // would ripple through transit-itinerary.helpers' validation and drop
    // otherwise-usable itineraries. MOTIS places carry coordinates in
    // practice; endpoint stops are re-checked by transitCoordinatesMatch.
    lat: typeof p?.lat === 'number' ? p.lat : 0,
    lng: typeof p?.lon === 'number' ? p.lon : 0,
    time: (kind === 'departure' ? p?.departure : p?.arrival) || null,
    scheduledTime: (kind === 'departure' ? p?.scheduledDeparture : p?.scheduledArrival) || null,
    track: p?.track || p?.scheduledTrack || null,
  };
}

@Injectable()
export class TransitousPlanner implements TransitPlanner {
  readonly id = 'transitous' as const;

  /** A public MOTIS instance — no credential to hold, so always usable. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Route search between two coordinates. TransitService has already validated
   * the query (coordinates, mode whitelist, maxTransfers range, parseable time),
   * so this only translates it into MOTIS parameters.
   */
  async plan(q: PlanQuery): Promise<TransitPlanResult> {
    const params = new URLSearchParams({ fromPlace: q.from, toPlace: q.to, numItineraries: '8' });

    if (q.time) params.set('time', new Date(q.time).toISOString());
    if (q.arriveBy) params.set('arriveBy', 'true');

    if (q.modes) {
      const modes = q.modes
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      if (modes.length > 0) params.set('transitModes', modes.join(','));
    }
    if (q.maxTransfers !== undefined && q.maxTransfers !== null) {
      params.set('maxTransfers', String(Number(q.maxTransfers)));
    }
    // We only want scheduled transit journeys in the results — a pure-walk
    // "direct" connection is what the existing OSRM footpath routing is for.
    params.set('directModes', 'WALK');

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
        // displayName is the public identifier MOTIS resolved for the run, taking
        // the trip number into account where the feed has one. Plenty of operators
        // (German long distance among them) keep routeShortName as an internal line
        // number, so preferring it showed "20" instead of "ICE 72" (#1715).
        line: leg.displayName || leg.routeShortName || null,
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

    // GTFS feeds ARE published timetables, so a MOTIS itinerary is always scheduled.
    return { itineraries, isTimetable: true };
  }
}
