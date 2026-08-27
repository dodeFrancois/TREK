type Coordinate = [number, number];

interface GeometryFeature {
  geometry?: { type?: unknown; coordinates?: unknown };
  properties?: { ways?: unknown };
}

interface FeatureCollection {
  type?: unknown;
  features?: unknown;
}

interface GeometryLegTarget {
  mode: string;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}

function validCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    Math.abs(value[0]) <= 180 &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1]) &&
    Math.abs(value[1]) <= 90
  );
}

function encodeValue(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let result = '';
  while (shifted >= 0x20) {
    result += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  return result + String.fromCharCode(shifted + 63);
}

export function encodePolyline(points: Array<[number, number]>, precision = 6): string {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLng = 0;
  let encoded = '';
  for (const [lat, lng] of points) {
    const nextLat = Math.round(lat * factor);
    const nextLng = Math.round(lng * factor);
    encoded += encodeValue(nextLat - previousLat);
    encoded += encodeValue(nextLng - previousLng);
    previousLat = nextLat;
    previousLng = nextLng;
  }
  return encoded;
}

function sameCoordinate(left: Coordinate | undefined, right: Coordinate | undefined): boolean {
  return !!left && !!right && left[0] === right[0] && left[1] === right[1];
}

export function navitimeLegGeometries(
  shapes: FeatureCollection | null | undefined,
  legTargets: Array<string | GeometryLegTarget>,
): Array<string | null> {
  const features = Array.isArray(shapes?.features) ? (shapes.features as GeometryFeature[]) : [];
  const groups: Array<{ kind: 'walk' | 'transit'; coordinates: Coordinate[] }> = [];

  for (const feature of features) {
    if (feature?.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) continue;
    const coordinates = feature.geometry.coordinates.filter(validCoordinate);
    if (coordinates.length < 2) continue;
    const kind = String(feature.properties?.ways || '').toLowerCase() === 'walk' ? 'walk' : 'transit';
    const previous = groups.at(-1);
    if (previous?.kind === kind && sameCoordinate(previous.coordinates.at(-1), coordinates[0])) {
      previous.coordinates.push(...coordinates.slice(1));
    } else {
      groups.push({ kind, coordinates: [...coordinates] });
    }
  }

  const assignments = new Map<number, { groupIndex: number; reverse: boolean }>();
  if (legTargets.every((target) => typeof target !== 'string')) {
    const pairs: Array<{ legIndex: number; groupIndex: number; reverse: boolean; score: number }> = [];
    legTargets.forEach((target, legIndex) => {
      if (typeof target === 'string') return;
      const expected = target.mode === 'WALK' ? 'walk' : 'transit';
      groups.forEach((candidate, groupIndex) => {
        if (candidate.kind !== expected) return;
        const first = candidate.coordinates[0];
        const last = candidate.coordinates.at(-1)!;
        const direct =
          (first[0] - target.from.lng) ** 2 +
          (first[1] - target.from.lat) ** 2 +
          (last[0] - target.to.lng) ** 2 +
          (last[1] - target.to.lat) ** 2;
        const reversed =
          (last[0] - target.from.lng) ** 2 +
          (last[1] - target.from.lat) ** 2 +
          (first[0] - target.to.lng) ** 2 +
          (first[1] - target.to.lat) ** 2;
        pairs.push({ legIndex, groupIndex, reverse: reversed < direct, score: Math.min(direct, reversed) });
      });
    });
    const assignedLegs = new Set<number>();
    const assignedGroups = new Set<number>();
    pairs
      .sort((left, right) => left.score - right.score)
      .forEach((pair) => {
        if (assignedLegs.has(pair.legIndex) || assignedGroups.has(pair.groupIndex)) return;
        assignments.set(pair.legIndex, pair);
        assignedLegs.add(pair.legIndex);
        assignedGroups.add(pair.groupIndex);
      });
  } else {
    let sequentialIndex = 0;
    legTargets.forEach((target, legIndex) => {
      const mode = typeof target === 'string' ? target : target.mode;
      const expected = mode === 'WALK' ? 'walk' : 'transit';
      while (sequentialIndex < groups.length && groups[sequentialIndex].kind !== expected) sequentialIndex++;
      if (groups[sequentialIndex]) assignments.set(legIndex, { groupIndex: sequentialIndex++, reverse: false });
    });
  }

  return legTargets.map((_target, legIndex) => {
    const assignment = assignments.get(legIndex);
    const group = assignment ? groups[assignment.groupIndex] : undefined;
    if (!group) return null;
    const coordinates = assignment?.reverse ? [...group.coordinates].reverse() : group.coordinates;
    return encodePolyline(
      coordinates.map(([lng, lat]) => [lat, lng]),
      6,
    );
  });
}
