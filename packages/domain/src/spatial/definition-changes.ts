import { assertJson, compareIds } from './canonical.ts';

export type DefinitionChange = {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  before?: string;
  after?: string;
};
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const fields = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
const preview = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 1000 ? text.slice(0, 1000) + '…' : text;
};

/** Bounded structural differences; JSON object order/whitespace are not content changes. */
export function definitionChanges(before: unknown, after: unknown, limit = 256) {
  assertJson(before);
  assertJson(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
    throw new Error('Invalid definition diff limit');
  const changes: DefinitionChange[] = [];
  let truncated = false;
  function visit(left: unknown, right: unknown, path: string) {
    if (left === right || truncated) return;
    const a = fields(left),
      b = fields(right);
    if (a && b && Array.isArray(left) === Array.isArray(right)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareIds);
      for (const key of keys)
        visit(
          Object.hasOwn(a, key) ? a[key] : undefined,
          Object.hasOwn(b, key) ? b[key] : undefined,
          `${path}/${pointer(key)}`,
        );
      return;
    }
    if (changes.length === limit) {
      truncated = true;
      return;
    }
    changes.push({
      path: path || '/',
      kind: left === undefined ? 'add' : right === undefined ? 'remove' : 'replace',
      ...(left === undefined ? {} : { before: preview(left) }),
      ...(right === undefined ? {} : { after: preview(right) }),
    });
  }
  visit(before, after, '');
  return { changes, truncated };
}
