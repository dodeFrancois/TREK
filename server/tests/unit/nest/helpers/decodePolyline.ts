/**
 * Copy of the client decoder (client/src/components/Map/transitGeometry.ts:17) —
 * the real consumer of what navitime.geometry.ts encodes. Kept here rather than
 * imported so the server test suite does not reach into the client workspace.
 */
export function decodePolylineForTest(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        if (index >= encoded.length) return coords;
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
