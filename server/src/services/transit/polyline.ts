/**
 * Décimales d'un polyline de leg (~11 cm de résolution).
 *
 * C'est notre choix, pas celui d'un fournisseur : NAVITIME renvoie du GeoJSON
 * brut, donc c'est nous qui encodons. MOTIS, lui, envoie le polyline déjà encodé
 * avec sa propre précision — la constante n'y sert que de valeur par défaut
 * quand il ne la précise pas. Le client décode chaque leg avec le
 * `geometryPrecision` qu'on lui a envoyé
 * (`client/src/components/Map/transitGeometry.ts`).
 */
export const POLYLINE_PRECISION = 6;

function encodeValue(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';
  while (shifted >= 0x20) {
    encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  return encoded + String.fromCharCode(shifted + 63);
}

/** Google encoded polyline algorithm, latitude first. */
export function encodePolyline(points: Array<[number, number]>, precision = POLYLINE_PRECISION): string {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLng = 0;
  let encoded = '';
  for (const [lat, lng] of points) {
    const nextLat = Math.round(lat * factor);
    const nextLng = Math.round(lng * factor);
    encoded += encodeValue(nextLat - previousLat) + encodeValue(nextLng - previousLng);
    previousLat = nextLat;
    previousLng = nextLng;
  }
  return encoded;
}
