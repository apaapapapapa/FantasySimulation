import { assertJson } from '@fantasy/domain/spatial/execution';

/** Compare display values without allocating canonical objects or serialized strings.
 * Keep the same validation/size boundaries as the former two canonicalJson calls.
 */
export function sameRecordValue(left: unknown, right: unknown): boolean {
  assertJson(left);
  assertJson(right);
  return equalValue(left, right);
}
function equalValue(left: unknown, right: unknown): boolean {
  // JSON normalizes -0 to 0; non-finite values have already been rejected.
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalValue(value, right[index]))
    );
  if (Array.isArray(right)) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]))
  );
}

const encoder = new TextEncoder();
const scratchUnits = 4096;
// At most three UTF-8 bytes per UTF-16 code unit, including unpaired surrogates.
const scratch = new Uint8Array(scratchUnits * 3);
/** Synchronous scratch use only: no reference to these bytes escapes into a replay. */
export function utf8ByteLength(text: string): number {
  return text.length <= scratchUnits
    ? encoder.encodeInto(text, scratch).written
    : encoder.encode(text).byteLength;
}
