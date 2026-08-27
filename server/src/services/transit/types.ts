export type TransitProviderId = 'transitous' | 'navitime';

export const SCHEDULED_TRANSIT_MODES = [
  'BUS',
  'COACH',
  'TRAM',
  'SUBWAY',
  'RAIL',
  'FERRY',
  'FUNICULAR',
  'AERIAL_LIFT',
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
  geometry: string | null;
  geometryPrecision: number;
}

export interface TransitFare {
  currency: string;
  ticket: number | null;
  ic: number | null;
}

export interface TransitItinerary {
  startTime: string;
  endTime: string;
  duration: number;
  transfers: number;
  walkSeconds: number;
  legs: TransitLeg[];
  fare?: TransitFare;
}

export interface TransitPlanResult {
  provider: TransitProviderId;
  isTimetable: boolean;
  itineraries: TransitItinerary[];
}

export interface PlanQuery {
  from: string;
  to: string;
  time?: string;
  arriveBy?: boolean;
  modes?: string;
  maxTransfers?: number;
}
