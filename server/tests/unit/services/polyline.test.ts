import { describe, expect, it } from 'vitest';

import { encodePolyline, POLYLINE_PRECISION } from '../../../src/services/transit/polyline';

describe('Google polyline encoding', () => {
  it('encodes the published reference coordinates', () => {
    expect(
      encodePolyline(
        [
          [38.5, -120.2],
          [40.7, -120.95],
          [43.252, -126.453],
        ],
        5,
      ),
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('defaults to the precision the transit legs advertise', () => {
    const points: Array<[number, number]> = [
      [35.69803, 139.703839],
      [35.701245, 139.700032],
    ];

    expect(POLYLINE_PRECISION).toBe(6);
    expect(encodePolyline(points)).toBe(encodePolyline(points, POLYLINE_PRECISION));
    expect(encodePolyline(points)).not.toBe(encodePolyline(points, 5));
  });

  it('encodes an empty path as an empty string', () => {
    expect(encodePolyline([])).toBe('');
  });
});
