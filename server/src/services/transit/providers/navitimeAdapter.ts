import { localParts, resolveTimeZone } from '../../timezoneService';
import { getTransitCache, setTransitCache } from '../cache';
import { getNavitimeKey } from '../settings';
import { SCHEDULED_TRANSIT_MODES, type PlanQuery, type TransitPlanResult } from '../types';
import { httpError, parseCoordinates } from '../validation';
import { excludableMoves } from './navitimeApi';
import { mapNavitimeResponse, type NavitimeRoutes } from './navitimeMapper';

const RAPIDAPI_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const ROUTE_URL = `https://${RAPIDAPI_HOST}/route_transit`;
const CACHE_TTL = 5 * 60 * 1000;

/** Statuts qui décrivent notre requête ou notre abonnement ; le reste devient un 502. */
const PASSTHROUGH_STATUS = new Set([400, 401, 403, 429]);

/** Modes qu'un appelant peut demander : TRANSIT couvre tout, les autres filtrent. */
const ALLOWED_MODES = new Set<string>(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

/**
 * Modes TREK que NAVITIME ne sait pas distinguer : sa taxonomie ne connaît que
 * des catégories de train (普通 / 快速 / 特急 / 新幹線…), pas la différence entre
 * métro, tram et train régional. Demander l'un quelconque d'entre eux garde donc
 * toutes les catégories.
 */
const RAIL_FAMILY = new Set([
  'RAIL',
  'SUBWAY',
  'TRAM',
  'HIGHSPEED_RAIL',
  'LONG_DISTANCE',
  'NIGHT_RAIL',
  'REGIONAL_RAIL',
  'SUBURBAN',
]);

/** Les modes demandés, ou null quand l'appelant n'a posé aucun filtre. */
function requestedModes(modes: string | undefined): Set<string> | null {
  const requested = new Set(
    (modes ?? '')
      .split(',')
      .map((mode) => mode.trim().toUpperCase())
      .filter(Boolean),
  );
  for (const mode of requested) {
    if (!ALLOWED_MODES.has(mode)) throw httpError('unsupported transit mode', 400);
  }
  return requested.size === 0 || requested.has('TRANSIT') ? null : requested;
}

/**
 * NAVITIME n'a pas de paramètre « seulement ces modes », uniquement `unuse` :
 * on exclut donc tout déplacement qu'aucun mode demandé ne couvre.
 */
function unuseForModes(modes: string | undefined): string | null {
  const requested = requestedModes(modes);
  if (!requested) return null;
  const wantsRail = [...requested].some((mode) => RAIL_FAMILY.has(mode));
  return (
    excludableMoves()
      .filter(([, mode]) => !(RAIL_FAMILY.has(mode) ? wantsRail : requested.has(mode)))
      .map(([move]) => move)
      .join(',') || null
  );
}

/** NAVITIME attend une heure locale nue, prise au fuseau du point concerné. */
function navitimeTime(iso: string, [lat, lng]: [number, number]): string {
  const { date, time } = localParts(iso, resolveTimeZone(lat, lng));
  if (!date || !time) throw httpError('time must be an ISO date-time', 400);
  return `${date}T${time}:00`;
}

function buildParams(query: PlanQuery): URLSearchParams {
  const from = parseCoordinates(query.from, 'from');
  const to = parseCoordinates(query.to, 'to');
  const params = new URLSearchParams({
    start: query.from,
    goal: query.to,
    limit: '8',
    shape: 'true',
    shape_color: 'railway_line',
    options: 'railway_calling_at',
  });

  if (query.time) {
    if (Number.isNaN(Date.parse(query.time))) throw httpError('time must be an ISO date-time', 400);
    params.set(
      query.arriveBy ? 'goal_time' : 'start_time',
      navitimeTime(query.time, query.arriveBy ? to : from),
    );
  }

  const unuse = unuseForModes(query.modes);
  if (unuse) params.set('unuse', unuse);
  return params;
}

/** NAVITIME n'a pas de plafond de correspondances : on valide ici, on filtre à la sortie. */
function transferLimit(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const maximum = Number(value);
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 10) throw httpError('maxTransfers must be 0-10', 400);
  return maximum;
}

async function fetchRoutes(key: string, params: URLSearchParams): Promise<unknown> {
  const response = await fetch(`${ROUTE_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': RAPIDAPI_HOST },
  });
  if (!response.ok) {
    const status = PASSTHROUGH_STATUS.has(response.status) ? response.status : 502;
    throw httpError(`NAVITIME provider error (HTTP ${response.status})`, status);
  }
  try {
    return await response.json();
  } catch {
    throw httpError('Invalid NAVITIME response', 502);
  }
}

export async function planNavitime(userId: number, query: PlanQuery): Promise<TransitPlanResult> {
  const key = getNavitimeKey(userId);
  if (!key) throw httpError('NAVITIME RapidAPI key is not configured', 400);

  const limit = transferLimit(query.maxTransfers);
  const params = buildParams(query);

  // maxTransfers reste hors de la clé : il est appliqué ici et pas par NAVITIME,
  // donc le changer réutilise la réponse au lieu de refacturer un appel RapidAPI.
  const cacheKey = `navitime:${userId}:${params.toString()}`;
  let routes = getTransitCache<NavitimeRoutes>(cacheKey, CACHE_TTL);
  if (!routes) {
    routes = mapNavitimeResponse(await fetchRoutes(key, params));
    setTransitCache(cacheKey, routes);
  }

  return {
    provider: 'navitime',
    isTimetable: routes.isTimetable,
    itineraries:
      limit === undefined ? routes.itineraries : routes.itineraries.filter((route) => route.transfers <= limit),
  };
}
