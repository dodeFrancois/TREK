import { plan } from '../../../src/services/transitService';

import { beforeEach, describe, expect, it } from 'vitest';

const state = vi.hoisted(() => ({ provider: 'transitous' as 'transitous' | 'navitime' }));
const adapters = vi.hoisted(() => ({ transitous: vi.fn(), navitime: vi.fn() }));

vi.mock('../../../src/services/transit/settings', () => ({
  getTransitProvider: vi.fn(() => state.provider),
}));
vi.mock('../../../src/services/transit/providers/transitousAdapter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planTransitous: adapters.transitous,
}));
vi.mock('../../../src/services/transit/providers/navitimeAdapter', () => ({
  planNavitime: adapters.navitime,
}));

beforeEach(() => {
  state.provider = 'transitous';
  adapters.transitous.mockReset().mockResolvedValue({ itineraries: [] });
  adapters.navitime.mockReset().mockResolvedValue({ provider: 'navitime', isTimetable: false, itineraries: [] });
});

describe('transit provider facade', () => {
  it('uses Transitous by default', async () => {
    const query = { from: '48.8,2.3', to: '48.9,2.4' };

    await expect(plan(4, query)).resolves.toMatchObject({ provider: 'transitous', isTimetable: true });
    expect(adapters.transitous).toHaveBeenCalledWith(query);
    expect(adapters.navitime).not.toHaveBeenCalled();
  });

  it('passes the authenticated user to NAVITIME when selected', async () => {
    state.provider = 'navitime';
    const query = { from: '35.6,139.6', to: '35.7,139.7' };

    await expect(plan(42, query)).resolves.toMatchObject({ provider: 'navitime', isTimetable: false });
    expect(adapters.navitime).toHaveBeenCalledWith(42, query);
    expect(adapters.transitous).not.toHaveBeenCalled();
  });
});
