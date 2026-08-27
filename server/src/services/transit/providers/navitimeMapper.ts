import type { TransitItinerary, TransitLeg, TransitLegStop } from '../types';
import { deriveTransitStats } from '../validation';
import { encodePolyline, navitimeLegGeometries } from './navitimeGeometry';

export { encodePolyline } from './navitimeGeometry';

type UnknownRecord = Record<string, any>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function color(value: unknown): string | null {
  const candidate = text(value);
  return candidate && /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : null;
}

function moveMode(value: unknown): string {
  switch (text(value)?.toLowerCase()) {
    case 'walk':
      return 'WALK';
    case 'route_bus':
    case 'local_bus':
    case 'shuttle_bus':
      return 'BUS';
    case 'highway_bus':
      return 'COACH';
    case 'superexpress':
      return 'HIGHSPEED_RAIL';
    case 'sleeper_ultraexpress':
      return 'NIGHT_RAIL';
    case 'ferry':
      return 'FERRY';
    case 'domestic_flight':
      return 'AIRPLANE';
    case 'local_train':
    case 'rapid':
    case 'semiexpress':
    case 'express':
    case 'limited_express':
      return 'RAIL';
    default:
      return 'OTHER';
  }
}

function stop(point: UnknownRecord, time: string): TransitLegStop | null {
  const coord = record(point.coord);
  const lat = finite(coord?.lat);
  const lng = finite(coord?.lon);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    name: text(point.name) || '',
    lat,
    lng,
    time,
    scheduledTime: time,
    track: text(point.track),
  };
}

function linkDetails(transport: UnknownRecord | null): { headsign: string | null; intermediateStops: number } {
  const links = Array.isArray(transport?.links) ? (transport.links.map(record).filter(Boolean) as UnknownRecord[]) : [];
  const first = links[0];
  const destination = record(first?.destination);
  const callingAt = Array.isArray(first?.calling_at) ? first.calling_at.length : 0;
  return { headsign: text(destination?.name), intermediateStops: callingAt };
}

function mapItem(itemValue: unknown, currency: string): TransitItinerary | null {
  const item = record(itemValue);
  const summary = record(item?.summary);
  const summaryMove = record(summary?.move);
  const startTime = text(summaryMove?.from_time);
  const endTime = text(summaryMove?.to_time);
  const sections = Array.isArray(item?.sections) ? item.sections.map(record) : [];
  if (
    !item ||
    !startTime ||
    !endTime ||
    !Number.isFinite(Date.parse(startTime)) ||
    !Number.isFinite(Date.parse(endTime))
  ) {
    return null;
  }

  const legs: TransitLeg[] = [];
  for (let index = 1; index < sections.length - 1; index++) {
    const section = sections[index];
    if (!section || section.type !== 'move') continue;
    const fromPoint = sections[index - 1];
    const toPoint = sections[index + 1];
    if (!fromPoint || !toPoint || fromPoint.type !== 'point' || toPoint.type !== 'point') return null;
    const fromTime = text(section.from_time);
    const toTime = text(section.to_time);
    if (!fromTime || !toTime || !Number.isFinite(Date.parse(fromTime)) || !Number.isFinite(Date.parse(toTime)))
      return null;
    const from = stop(fromPoint, fromTime);
    const to = stop(toPoint, toTime);
    if (!from || !to) return null;
    const transport = record(section.transport);
    const details = linkDetails(transport);
    legs.push({
      mode: moveMode(section.move),
      from,
      to,
      duration: Math.max(0, Math.round((Date.parse(toTime) - Date.parse(fromTime)) / 1000)),
      distance: finite(section.distance) === null ? null : Math.max(0, Math.round(section.distance)),
      headsign: details.headsign,
      line: text(transport?.name) || text(section.line_name),
      lineColor: color(transport?.color),
      lineTextColor: null,
      agency: text(record(transport?.company)?.name),
      intermediateStops: details.intermediateStops,
      geometry: null,
      geometryPrecision: 6,
    });
  }
  if (!legs.length || !legs.some((leg) => leg.mode !== 'WALK')) return null;

  const geometries = navitimeLegGeometries(record(item.shapes), legs);
  legs.forEach((leg, index) => {
    leg.geometry = geometries[index] || null;
  });
  const reportedTransfers = finite(summaryMove.transit_count) ?? undefined;
  const referenceFare = record(summaryMove.reference_fare);
  const ticket = finite(referenceFare?.lowest_total_ticket);
  const ic = finite(referenceFare?.lowest_total_ic);
  const fare = ticket !== null || ic !== null ? { currency, ticket, ic } : undefined;

  return {
    startTime,
    endTime,
    ...deriveTransitStats(startTime, endTime, legs, reportedTransfers),
    legs,
    ...(fare ? { fare } : {}),
  };
}

export function mapNavitimeResponse(value: unknown): TransitItinerary[] {
  const response = record(value);
  if (!response || !Array.isArray(response.items))
    throw Object.assign(new Error('Invalid NAVITIME response'), { status: 502 });
  const currency = text(record(response.unit)?.currency) || 'JPY';
  return response.items.flatMap((item: unknown) => {
    const mapped = mapItem(item, currency);
    return mapped ? [mapped] : [];
  });
}

/** Conservative response-level flag: missing or mixed provider flags are estimated. */
export function navitimeResponseIsTimetable(value: unknown): boolean {
  const response = record(value);
  const flags = (Array.isArray(response?.items) ? response.items : []).flatMap((itemValue: unknown) => {
    const item = record(itemValue);
    return (Array.isArray(item?.sections) ? item.sections : []).flatMap((sectionValue: unknown) => {
      const section = record(sectionValue);
      if (!section || section.type !== 'move' || moveMode(section.move) === 'WALK') return [];
      const transport = record(section.transport);
      return (Array.isArray(transport?.links) ? transport.links : []).flatMap((linkValue: unknown) => {
        const link = record(linkValue);
        const flag = link?.is_timetable;
        if (flag === true || flag === 'true') return [true];
        if (flag === false || flag === 'false') return [false];
        return [];
      });
    });
  });
  return flags.length > 0 && flags.every(Boolean);
}
