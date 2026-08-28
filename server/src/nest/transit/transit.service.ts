import { Injectable } from '@nestjs/common';
import { badRequest } from './transit.http';
import { SCHEDULED_TRANSIT_MODES, type PlanQuery, type TransitPlace } from './transit.helpers';
import type { TransitPlanResult, TransitPlanner, TransitProvider } from './providers/transit-planner';
import { TransitousPlanner, upstream } from './providers/transitous.planner';

/**
 * Public transit routing (#1065). This service owns what is provider-agnostic —
 * query validation, the shared response cache, and the dispatch to the planner
 * the administrator selected — while each provider's request building and
 * response mapping lives in providers/.
 *
 * `geocode` is NOT dispatched: it always goes to Transitous, because the
 * NAVITIME subscription exposes no geocoding endpoint at all.
 *
 * The response cache stays module-scoped on purpose (the
 * permissions/exchange-rates precedent): the DI singleton and any future
 * non-Nest caller share one cache.
 */

const ALLOWED_MODES = new Set(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

// Short-lived response cache: planning is the expensive call per the Transitous
// usage policy, and a user toggling filters re-requests identical plans.
const CACHE_TTL = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; data: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (true LRU): geocode and plan share this Map, so without
  // the re-insert a burst of geocoding evicts still-hot plan entries.
  cache.delete(key);
  cache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, data: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), data });
}

const COORD_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

function isCoord(v: string): boolean {
  if (!COORD_RE.test(v)) return false;
  const [lat, lng] = v.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

@Injectable()
export class TransitService {
  private readonly planners: { transitous: TransitPlanner };

  constructor(transitous: TransitousPlanner) {
    this.planners = { transitous };
  }

  /** Station/place search for the from/to pickers. `near` biases results. */
  async geocode(query: string, language?: string, near?: string): Promise<{ results: TransitPlace[] }> {
    const text = (query || '').trim();
    if (text.length < 2) return { results: [] };
    if (text.length > 200) throw badRequest('Query too long');

    const params = new URLSearchParams({ text });
    if (language) params.set('language', language.slice(0, 5));
    if (near && isCoord(near)) params.set('place', near);

    const key = `geo:${params.toString()}`;
    const cached = cacheGet(key);
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
    cacheSet(key, data);
    return data;
  }

  /**
   * Route search between two coordinates. Validates, then hands the query to the
   * selected provider — every 400 below is raised here so no provider has to
   * repeat it.
   */
  async plan(q: PlanQuery): Promise<TransitPlanResult> {
    if (!q.from || !isCoord(q.from)) throw badRequest('from must be "lat,lng"');
    if (!q.to || !isCoord(q.to)) throw badRequest('to must be "lat,lng"');
    if (q.time !== undefined && Number.isNaN(new Date(q.time).getTime())) {
      throw badRequest('time must be an ISO date-time');
    }
    if (q.modes) {
      const modes = q.modes
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      if (modes.some((m) => !ALLOWED_MODES.has(m))) throw badRequest('unsupported transit mode');
    }
    if (q.maxTransfers !== undefined && q.maxTransfers !== null) {
      const n = Number(q.maxTransfers);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw badRequest('maxTransfers must be 0-10');
    }

    const provider: TransitProvider = 'transitous';
    const planner = this.planners[provider];

    // Keyed on the TREK query plus the provider id, not on the provider's own
    // parameters: without the id, flipping providers would serve the previous
    // one's itineraries for a full TTL.
    const key = `plan:${planner.id}:${q.from}|${q.to}|${q.time ?? ''}|${q.arriveBy ? '1' : '0'}|${q.modes ?? ''}|${q.maxTransfers ?? ''}`;
    const cached = cacheGet(key);
    if (cached) return cached as TransitPlanResult;

    const data = await planner.plan(q);
    cacheSet(key, data);
    return data;
  }
}
