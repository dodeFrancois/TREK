import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { fetchJson, notConfigured } from '../../transit.http';
import { readNavitimeApiKey } from '../../transit.settings';
import type { PlanQuery, TransitItinerary } from '../../transit.helpers';
import type { TransitPlanResult, TransitPlanner } from '../transit-planner';
import { buildNavitimeQuery, NAVITIME_HOST, NAVITIME_PATH } from './navitime.request';
import { mapNavitimeItinerary, navitimeShapes } from './navitime.mapper';
import { attachNavitimeGeometry } from './navitime.geometry';

/**
 * NAVITIME /route_transit, reached through RapidAPI.
 *
 * Deliberately thin: the request builder, the response mapper and the geometry
 * assembly are pure functions in sibling files, so each of them runs against the
 * committed capture without a network or a container. This class only holds the
 * credential, makes the call, and glues the three together.
 */
@Injectable()
export class NavitimePlanner implements TransitPlanner {
  readonly id = 'navitime' as const;
  private readonly logger = new Logger(NavitimePlanner.name);

  constructor(private readonly db: DatabaseService) {}

  isConfigured(): boolean {
    return readNavitimeApiKey(this.db) !== null;
  }

  async plan(query: PlanQuery): Promise<TransitPlanResult> {
    const apiKey = readNavitimeApiKey(this.db);
    if (!apiKey) throw notConfigured('The NAVITIME transit provider is not configured.');

    const params = buildNavitimeQuery(query);
    const raw = (await fetchJson(`https://${NAVITIME_HOST}${NAVITIME_PATH}?${params}`, {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': NAVITIME_HOST,
    })) as { items?: unknown[] };

    const itineraries: TransitItinerary[] = [];
    let isTimetable = true;

    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      const mapped = mapNavitimeItinerary(item);
      if (!mapped) continue;
      // /route_transit has no maxTransfers parameter, but summary.transit_count
      // carries the answer — filter rather than ignore what the caller asked for.
      if (
        query.maxTransfers !== undefined &&
        query.maxTransfers !== null &&
        mapped.itinerary.transfers > Number(query.maxTransfers)
      ) {
        continue;
      }
      const { itinerary, fallback } = attachNavitimeGeometry(mapped, navitimeShapes(item));
      if (fallback) {
        // The one place a lost `options=railway_calling_at` shows up. Without this
        // line the regression is silent: every route quietly becomes a straight
        // line on the map and nothing says why.
        this.logger.warn(`NAVITIME itinerary returned without geometry — ${fallback}`);
      }
      if (!mapped.isTimetable) isTimetable = false;
      itineraries.push(itinerary);
    }

    // An empty result confirms nothing about timetables.
    return { itineraries, isTimetable: itineraries.length > 0 && isTimetable };
  }
}
