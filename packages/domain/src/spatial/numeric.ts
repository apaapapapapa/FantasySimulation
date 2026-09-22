/** Exact binary64 big-endian encoding; canonicalize -0, reject non-finite state. */
export function floatBits(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite physical state');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeNumericState(input: unknown): unknown {
  if (typeof input === 'number') return { f64: floatBits(input) };
  if (Array.isArray(input)) return input.map(encodeNumericState);
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, encodeNumericState(value)]),
    );
  }
  return input;
}
