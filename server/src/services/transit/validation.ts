import type { TransitItinerary, TransitLeg } from './types';

export function deriveTransitStats(
  startTime: string,
  endTime: string,
  legs: TransitLeg[],
  reportedTransfers?: number,
): Pick<TransitItinerary, 'duration' | 'transfers' | 'walkSeconds'> {
  return {
    duration: Math.max(0, Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)),
    transfers:
      typeof reportedTransfers === 'number'
        ? Math.max(0, Math.round(reportedTransfers))
        : Math.max(0, legs.filter((leg) => leg.mode !== 'WALK').length - 1),
    walkSeconds: legs.filter((leg) => leg.mode === 'WALK').reduce((total, leg) => total + leg.duration, 0),
  };
}
