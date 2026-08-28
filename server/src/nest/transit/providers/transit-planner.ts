import type { PlanQuery, TransitItinerary } from '../transit.helpers';

/** The value stored in app_settings.transit_provider. */
export type TransitProvider = 'transitous' | 'navitime';

export interface TransitPlanResult {
  itineraries: TransitItinerary[];
  /**
   * False as soon as one itinerary is not confirmed to run to a published
   * timetable — the client turns this into the estimated-times banner. Reported
   * per response rather than per itinerary on purpose: transitItinerarySchema is
   * the contract create_transit_journey validates on the way IN, and it must not
   * grow a field for a display concern.
   */
  isTimetable: boolean;
}

/**
 * A route-planning provider. Only planning is interchangeable: `geocode` stays
 * Transitous in all cases, because the NAVITIME subscription exposes no
 * geocoding endpoint at all.
 */
export interface TransitPlanner {
  /** The value stored in app_settings.transit_provider. */
  readonly id: TransitProvider;
  /** Refuse rather than degrade: TransitService 503s when this is false. */
  isConfigured(): boolean;
  plan(query: PlanQuery): Promise<TransitPlanResult>;
}
