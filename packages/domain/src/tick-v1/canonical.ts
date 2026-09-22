/** Project canonical-json-v1: plain JSON, safe integers, UTF-16 key order. */
export function canonicalJson(input: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  function visit(value: unknown, depth: number): string {
    if (++nodes > 20_000 || depth > 32) throw new Error('JSON complexity limit exceeded');
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new Error('JSON numbers must be safe integers without negative zero');
      }
      return String(value);
    }
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 1_000_000) throw new Error('JSON text limit exceeded');
      return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new Error('Non-JSON value');
    if (ancestors.has(value)) throw new Error('Cyclic JSON');
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error('JSON objects must be plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error('JSON symbol keys are unsupported');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((property) => !('value' in property))) {
      throw new Error('JSON accessors are unsupported');
    }
    ancestors.add(value);
    let result: string;
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new Error('Sparse or extended JSON array');
      }
      result = `[${keys.map((key) => visit(descriptors[key]?.value, depth + 1)).join(',')}]`;
    } else {
      result = `{${Object.keys(value)
        .sort()
        .map((key) => {
          characters += key.length;
          if (characters > 1_000_000) throw new Error('JSON text limit exceeded');
          return `${JSON.stringify(key)}:${visit(descriptors[key]?.value, depth + 1)}`;
        })
        .join(',')}}`;
    }
    ancestors.delete(value);
    return result;
  }
  return visit(input, 0);
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Hash input limit exceeded');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function hashJson(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function createRevision<T>(revisionId: string, definition: T) {
  // Clone at the JSON boundary, so freezing never changes the caller's objects.
  const canonical = canonicalJson(definition);
  const snapshot = JSON.parse(canonical) as T;
  return deepFreeze({ revisionId, contentHash: await sha256Text(canonical), definition: snapshot });
}
