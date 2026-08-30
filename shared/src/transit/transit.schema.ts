import { z } from 'zod';

export const transitProviderSchema = z.enum(['transitous', 'navitime']);
export type TransitProvider = z.infer<typeof transitProviderSchema>;

export const transitProvidersResponseSchema = z.object({
  defaultProvider: transitProviderSchema,
  providers: z.array(transitProviderSchema),
}).refine(({ defaultProvider, providers }) => providers.includes(defaultProvider), {
  message: 'defaultProvider must be configured',
  path: ['defaultProvider'],
});
export type TransitProvidersResponse = z.infer<typeof transitProvidersResponseSchema>;

const transitStopSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  time: z.string().nullable(),
  scheduledTime: z.string().nullable(),
  track: z.string().nullable(),
});

const transitLegSchema = z.object({
  mode: z.string(),
  from: transitStopSchema,
  to: transitStopSchema,
  duration: z.number(),
  distance: z.number().nullable(),
  headsign: z.string().nullable(),
  line: z.string().nullable(),
  lineColor: z.string().nullable(),
  lineTextColor: z.string().nullable(),
  agency: z.string().nullable(),
  intermediateStops: z.number(),
  geometry: z.string().nullable(),
  geometryPrecision: z.number(),
});

export const transitItinerarySchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  duration: z.number(),
  transfers: z.number(),
  walkSeconds: z.number(),
  legs: z.array(transitLegSchema),
});
export type TransitItineraryResponse = z.infer<typeof transitItinerarySchema>;

export const transitPlanResponseSchema = z.object({
  provider: transitProviderSchema,
  itineraries: z.array(transitItinerarySchema),
  isTimetable: z.boolean(),
});
export type TransitPlanResponse = z.infer<typeof transitPlanResponseSchema>;

export const transitPlanRequestSchema = z.object({
  from: z.string(),
  to: z.string(),
  time: z.string().optional(),
  arriveBy: z.boolean().optional(),
  modes: z.string().optional(),
  maxTransfers: z.number().optional(),
  provider: transitProviderSchema.optional(),
});
export type TransitPlanRequest = z.infer<typeof transitPlanRequestSchema>;
