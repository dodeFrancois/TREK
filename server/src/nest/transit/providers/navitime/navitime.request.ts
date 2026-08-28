import { localParts, resolveTimeZone } from '../../../common/timezoneService';
import { badRequest } from '../../transit.http';
import type { PlanQuery } from '../../transit.helpers';
import { unuseFor } from './navitime.modes';

/**
 * The /route_transit query string. Pure so it can be asserted without a network
 * stub — the local-time conversion and the `unuse` separator are the two things
 * most likely to regress silently.
 */

export const NAVITIME_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
export const NAVITIME_PATH = '/route_transit';

// Matches numItineraries=8 on the MOTIS side so the picker offers the same depth.
const ITINERARY_LIMIT = '8';

/**
 * NAVITIME wants a bare local date-time at the timezone of the point the time
 * anchors to: the origin for depart-by, the destination for arrive-by. localParts
 * yields HH:MM, hence the appended seconds.
 */
function nakedLocalTime(iso: string, coord: string): string {
  const [lat, lng] = coord.split(',').map(Number);
  const timezone = resolveTimeZone(lat, lng);
  if (!timezone) throw badRequest(`Unable to resolve timezone for ${coord}`);
  const parts = localParts(iso, timezone);
  if (!parts.date || !parts.time) throw badRequest('time must be an ISO date-time');
  return `${parts.date}T${parts.time}:00`;
}

export function buildNavitimeQuery(query: PlanQuery): URLSearchParams {
  const params = new URLSearchParams({
    start: query.from,
    goal: query.to,
    limit: ITINERARY_LIMIT,
    shape: 'true',
    shape_color: 'railway_line',
    // The geometry assembly counts one transport feature per inter-stop hop, so
    // it needs calling_at. Without this option nothing is drawn at all.
    options: 'railway_calling_at',
  });

  if (query.time) {
    const anchor = query.arriveBy ? query.to : query.from;
    params.set(query.arriveBy ? 'goal_time' : 'start_time', nakedLocalTime(query.time, anchor));
  }

  const unuse = unuseFor(query.modes);
  // Period-separated ("ピリオド区切り"), not comma-separated. A comma here is
  // silently ignored upstream and every mode comes back.
  if (unuse.length > 0) params.set('unuse', unuse.join('.'));

  return params;
}
