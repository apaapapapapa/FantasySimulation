import { describe, expect, it } from 'vite-plus/test';
import fc from 'fast-check';
import { canonicalJson } from '@fantasy/domain/spatial/execution';
import { sameRecordValue, utf8ByteLength } from './rules/record-values.ts';

const comparisons: [unknown, unknown, boolean][] = [
  [-0, 0, true],
  [null, null, true],
  [0, false, false],
  [{ x: 1, y: 2, z: -0 }, { z: 0, y: 2, x: 1 }, true],
  [{ hp: 1, stamina: 0 }, { hp: 1 }, false],
  [{ phase: null }, {}, false],
  [[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }], false],
  [[1], { '0': 1 }, false],
  [Object.assign(Object.create(null), { value: 3 }), { value: 3 }, true],
];
describe('allocation-light record values', () => {
  it.each(comparisons)('compares %j with %j as %s', (left, right, equal) => {
    expect(sameRecordValue(left, right)).toBe(equal);
    expect(sameRecordValue(left, right)).toBe(canonicalJson(left) === canonicalJson(right));
  });
  it('matches canonical treatment of non-enumerable keys and accepted array holes', () => {
    const hidden = Object.defineProperty({ other: 0 }, 'value', { value: 1 });
    expect(sameRecordValue({ value: 1 }, hidden)).toBe(false);
    expect(canonicalJson({ value: 1 }) === canonicalJson(hidden)).toBe(false);
    const hole = Object.assign(new Array(1), { ignored: 0 });
    expect(sameRecordValue(hole, [null])).toBe(true);
    expect(sameRecordValue(hole, [1])).toBe(false);
    expect(canonicalJson(hole)).toBe('[null]');
  });
  it('agrees with canonical JSON for independently generated JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (left, right) => {
        expect(sameRecordValue(left, right)).toBe(canonicalJson(left) === canonicalJson(right));
        expect(sameRecordValue(left, structuredClone(left))).toBe(true);
      }),
      { seed: 189, numRuns: 200 },
    );
  });
  it('still validates equal references and rejects invalid or over-budget values', () => {
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;
    for (const value of [undefined, NaN, Infinity, { missing: undefined }, new Date(), cycle])
      expect(() => sameRecordValue(value, value)).toThrow(/JSON/);
    let deep: unknown = null;
    for (let index = 0; index < 26; index++) deep = { child: deep };
    expect(() => sameRecordValue(deep, deep)).toThrow('JSON structure budget exceeded');
  });
  it('counts UTF-16 and scratch-buffer boundaries exactly', () => {
    const encoder = new TextEncoder();
    let mismatches = 0;
    for (let code = 0; code <= 0xffff; code++) {
      const text = String.fromCharCode(code);
      if (utf8ByteLength(text) !== encoder.encode(text).byteLength) mismatches++;
    }
    expect(mismatches).toBe(0);
    for (const text of [
      '',
      '一🙂\n"\\',
      '\ud800x\udfff',
      '\ud800\udc00',
      'a'.repeat(4096),
      '一'.repeat(4096),
      '🙂'.repeat(2048),
      '一'.repeat(4097),
      'x'.repeat(20000),
    ])
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    expect(utf8ByteLength('a')).toBe(1);
  });
});
