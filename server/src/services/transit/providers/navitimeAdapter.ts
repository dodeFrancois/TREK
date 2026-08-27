import { localParts, resolveTimeZone } from '../../timezoneService';
import { getTransitCache, setTransitCache } from '../cache';
import { getNavitimeKey } from '../settings';
import { SCHEDULED_TRANSIT_MODES, type PlanQuery, type TransitPlanResult } from '../types';
import { mapNavitimeResponse, navitimeResponseIsTimetable } from './navitimeMapper';

const RAPIDAPI_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const ROUTE_URL = `https://${RAPIDAPI_HOST}/route_transit`;
const NAVITIME_CACHE_TTL_MS = 5 * 60 * 1000;

const COORD_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const RAIL_MODES = new Set([
  'RAIL',
  'SUBWAY',
  'TRAM',
  'HIGHSPEED_RAIL',
  'LONG_DISTANCE',
  'NIGHT_RAIL',
  'REGIONAL_RAIL',
  'SUBURBAN',
]);
const ALLOWED_MODES = new Set(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function coordinate(value: string, name: string): [number, number] {
  if (!COORD_RE.test(value)) throw httpError(`${name} must be "lat,lng"`, 400);
  const [lat, lng] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw httpError(`${name} must be "lat,lng"`, 400);
  return [lat, lng];
}

function navitimeTime(iso: string, coordinateValue: [number, number]): string {
  const timezone = resolveTimeZone(coordinateValue[0], coordinateValue[1]);
  const parts = localParts(iso, timezone);
  if (!parts.date || !parts.time) throw httpError('time must be an ISO date-time', 400);
  return `${parts.date}T${parts.time}:00`;
}

function unuseForModes(modesValue: string | undefined): string | null {
  if (!modesValue) return null;
  const modes = new Set(
    modesValue
      .split(',')
      .map((mode) => mode.trim().toUpperCase())
      .filter(Boolean),
  );
  if ([...modes].some((mode) => !ALLOWED_MODES.has(mode))) throw httpError('unsupported transit mode', 400);
  if (modes.has('TRANSIT')) return null;
  const unuse: string[] = ['domestic_flight'];
  if (![...modes].some((mode) => RAIL_MODES.has(mode))) {
    unuse.push(
      'superexpress',
      'sleeper_ultraexpress',
      'limited_express',
      'express',
      'semiexpress',
      'rapid',
      'local_train',
    );
  }
  if (!modes.has('BUS')) unuse.push('route_bus');
  if (!modes.has('COACH')) unuse.push('highway_bus');
  if (!modes.has('FERRY')) unuse.push('ferry');
  return unuse.join(',');
}

function buildParams(query: PlanQuery): URLSearchParams {
  const from = coordinate(query.from, 'from');
  const to = coordinate(query.to, 'to');
  const params = new URLSearchParams({
    start: query.from,
    goal: query.to,
    limit: '8',
    shape: 'true',
    shape_color: 'railway_line',
    options: 'railway_calling_at',
  });
  if (query.time) {
    if (!Number.isFinite(Date.parse(query.time))) throw httpError('time must be an ISO date-time', 400);
    if (query.arriveBy) params.set('goal_time', navitimeTime(query.time, to));
    else params.set('start_time', navitimeTime(query.time, from));
  }
  const unuse = unuseForModes(query.modes);
  if (unuse) params.set('unuse', unuse);
  if (query.maxTransfers !== undefined) {
    const maximum = Number(query.maxTransfers);
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 10) {
      throw httpError('maxTransfers must be 0-10', 400);
    }
  }
  return params;
}

export async function planNavitime(userId: number, query: PlanQuery): Promise<TransitPlanResult> {
  const key = getNavitimeKey(userId);
  if (!key) throw httpError('NAVITIME RapidAPI key is not configured', 400);
  const params = buildParams(query);
  const cacheKey = `navitime:${userId}:${params.toString()}:${query.maxTransfers ?? ''}`;
  const cached = getTransitCache<TransitPlanResult>(cacheKey, NAVITIME_CACHE_TTL_MS);
  if (cached) return cached;

  const response = await fetch(`${ROUTE_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
  });
  if (!response.ok) {
    const status =
      response.status === 400
        ? 400
        : response.status === 401 || response.status === 403
          ? response.status
          : response.status === 429
            ? 429
            : 502;
    throw httpError(`NAVITIME provider error (HTTP ${response.status})`, status);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw httpError('Invalid NAVITIME response', 502);
  }
  let itineraries = mapNavitimeResponse(raw);
  if (query.maxTransfers !== undefined)
    itineraries = itineraries.filter((item) => item.transfers <= query.maxTransfers!);
  const result: TransitPlanResult = {
    provider: 'navitime',
    isTimetable: navitimeResponseIsTimetable(raw),
    itineraries,
  };
  setTransitCache(cacheKey, result);
  return result;
}
