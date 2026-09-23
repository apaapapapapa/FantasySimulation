import { describe, expect, it } from 'vite-plus/test';
import { encodeNumericState, floatBits } from './numeric.ts';

describe('binary64 replay encoding', () => {
  it.each([
    [0, '0000000000000000'],
    [-0, '0000000000000000'],
    [1, '3ff0000000000000'],
    [-1, 'bff0000000000000'],
    [0.1, '3fb999999999999a'],
    [Number.MIN_VALUE, '0000000000000001'],
    [-Number.MIN_VALUE, '8000000000000001'],
    [2 ** -1022, '0010000000000000'],
    [Number.MAX_VALUE, '7fefffffffffffff'],
    [-Number.MAX_VALUE, 'ffefffffffffffff'],
    [Number.MAX_SAFE_INTEGER, '433fffffffffffff'],
  ] as const)('preserves the exact bits of %s across buffer reuse', (value, expected) => {
    floatBits(Number.MAX_VALUE);
    expect(floatBits(value)).toBe(expected);
    floatBits(-Number.MIN_VALUE);
    expect(floatBits(value)).toBe(expected);
  });
  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite input %s without poisoning later calls',
    (value) => {
      expect(() => floatBits(value)).toThrow('Non-finite physical state');
      expect(floatBits(1)).toBe('3ff0000000000000');
    },
  );
  it('keeps nested numeric values independent and leaves the input untouched', () => {
    const input = { z: [-0, 0.1], a: { y: Number.MIN_VALUE } };
    expect(encodeNumericState(input)).toEqual({
      a: { y: { f64: '0000000000000001' } },
      z: [{ f64: '0000000000000000' }, { f64: '3fb999999999999a' }],
    });
    expect(Object.is(input.z[0], -0)).toBe(true);
    expect(input.a.y).toBe(Number.MIN_VALUE);
  });
});
