// Synchronous numeric-only calls cannot re-enter this scratch buffer. Each Worker
// has its own module instance; no memory is shared between isolates.
const floatView = new DataView(new ArrayBuffer(8));

/** Exact binary64 big-endian encoding; canonicalize -0, reject non-finite state. */
export function floatBits(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite physical state');
  floatView.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  return (
    floatView.getUint32(0, false).toString(16).padStart(8, '0') +
    floatView.getUint32(4, false).toString(16).padStart(8, '0')
  );
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
