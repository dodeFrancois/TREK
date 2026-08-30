import { describe, expect, it } from 'vitest';
import { transitPlanResponseSchema, transitProvidersResponseSchema } from './transit.schema';

describe('transit provider contracts', () => {
  it('accepts a default provider included in the configured provider list', () => {
    expect(
      transitProvidersResponseSchema.parse({
        defaultProvider: 'navitime',
        providers: ['transitous', 'navitime'],
      }),
    ).toEqual({ defaultProvider: 'navitime', providers: ['transitous', 'navitime'] });
  });

  it('rejects unknown providers', () => {
    expect(
      transitProvidersResponseSchema.safeParse({
        defaultProvider: 'google',
        providers: ['transitous', 'google'],
      }).success,
    ).toBe(false);
  });

  it('rejects a default provider that is not configured', () => {
    expect(
      transitProvidersResponseSchema.safeParse({
        defaultProvider: 'navitime',
        providers: ['transitous'],
      }).success,
    ).toBe(false);
  });

  it('records the provider that produced a plan response', () => {
    expect(
      transitPlanResponseSchema.parse({
        provider: 'navitime',
        itineraries: [],
        isTimetable: false,
      }).provider,
    ).toBe('navitime');
  });
});
