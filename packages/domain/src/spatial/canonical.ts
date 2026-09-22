/** Reject cycles, non-JSON values and oversized/deep input before recursive schemas or hashing. */
export function assertJson(value: unknown, maxNodes = 100_000, maxDepth = 24): void {
  const ancestors = new Set<object>();
  let nodes = 0,
    bytes = 0;
  function visit(input: unknown, depth: number) {
    if (++nodes > maxNodes || depth > maxDepth || bytes > 4_000_000)
      throw new Error('JSON structure budget exceeded');
    if (input === null || typeof input === 'boolean') return;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Non-finite JSON number');
      return;
    }
    if (typeof input === 'string') {
      bytes += input.length * 3;
      if (bytes > 4_000_000) throw new Error('JSON byte budget exceeded');
      return;
    }
    if (
      typeof input !== 'object' ||
      (!Array.isArray(input) &&
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    )
      throw new Error('Expected plain JSON');
    if (ancestors.has(input)) throw new Error('Cyclic JSON');
    if (Array.isArray(input) && Object.keys(input).length !== input.length)
      throw new Error('Sparse/non-JSON array');
    ancestors.add(input);
    for (const [key, child] of Object.entries(input)) {
      bytes += key.length * 3;
      visit(child, depth + 1);
    }
    ancestors.delete(input);
  }
  visit(value, 0);
}
export function canonicalJson(value: unknown): string {
  assertJson(value);
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])]),
      );
    return input;
  }
  return JSON.stringify(normalize(value));
}
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
export const contentHash = (value: unknown) =>
  hashBytes(new TextEncoder().encode(canonicalJson(value)));
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  const seen = new WeakSet<object>();
  function visit(input: unknown) {
    if (input === null || typeof input !== 'object' || seen.has(input)) return;
    seen.add(input);
    for (const child of Object.values(input)) visit(child);
    Object.freeze(input);
  }
  visit(value);
  return value as DeepReadonly<T>;
}
