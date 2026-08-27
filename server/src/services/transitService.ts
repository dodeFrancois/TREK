import { planNavitime } from './transit/providers/navitimeAdapter';
import { planTransitous, type PlanQuery, type TransitPlanResult } from './transit/providers/transitousAdapter';
import { getTransitProvider } from './transit/settings';

export {
  SCHEDULED_TRANSIT_MODES,
  TRANSIT_PROVIDERS,
  deriveTransitStats,
  geocode,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
  type TransitPlanResult,
  type TransitProviderId,
} from './transit/providers/transitousAdapter';

/** Provider facade. The one-argument form is retained while internal callers migrate. */
export async function plan(userId: number, query: PlanQuery): Promise<TransitPlanResult>;
export async function plan(query: PlanQuery): Promise<TransitPlanResult>;
export async function plan(userIdOrQuery: number | PlanQuery, maybeQuery?: PlanQuery): Promise<TransitPlanResult> {
  const userId = typeof userIdOrQuery === 'number' ? userIdOrQuery : null;
  const query = typeof userIdOrQuery === 'number' ? maybeQuery : userIdOrQuery;
  if (!query) {
    const error = new Error('Transit query is required') as Error & { status: number };
    error.status = 400;
    throw error;
  }
  if (userId !== null && getTransitProvider() === 'navitime') return planNavitime(userId, query);
  const result = await planTransitous(query);
  return { provider: 'transitous', isTimetable: true, ...result };
}
