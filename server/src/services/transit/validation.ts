import type { TransitItinerary, TransitLeg } from './types';

/** Erreur porteuse d'un status HTTP, telle que la couche Nest l'attend. */
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const COORDINATES_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

/** Vrai pour un "lat,lng" bien formé et dans les bornes. */
export function isCoordinates(value: string | null | undefined): boolean {
  if (!value || !COORDINATES_RE.test(value)) return false;
  const [lat, lng] = value.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Un "lat,lng" décomposé, ou une 400 nommée d'après le paramètre fautif. */
export function parseCoordinates(value: string | undefined, name: string): [lat: number, lng: number] {
  if (!isCoordinates(value)) throw httpError(`${name} must be "lat,lng"`, 400);
  const [lat, lng] = value!.split(',').map(Number);
  return [lat, lng];
}

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
