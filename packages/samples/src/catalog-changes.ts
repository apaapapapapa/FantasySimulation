import {
  compareIds,
  definitionChanges,
  revisionDependencies,
  revisionIndex,
  revisionKey,
  type Revision,
} from '@fantasy/domain/spatial';

/** Impact is pinned-reference reachability, not automatic rebinding to newer revisions. */
export function catalogChanges(before: readonly Revision[], after: readonly Revision[]) {
  revisionIndex(before);
  revisionIndex(after);
  const old = new Map(before.map((revision) => [revisionKey(revision), revision]));
  const next = new Map(after.map((revision) => [revisionKey(revision), revision]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].sort(compareIds).flatMap((key) => {
    const a = old.get(key),
      b = next.get(key);
    if (a?.contentHash === b?.contentHash) return [];
    return [{ key, ...definitionChanges(a?.definition ?? null, b?.definition ?? null) }];
  });
  const dependents = new Map<string, Set<string>>();
  for (const revision of [...before, ...after])
    for (const { kind, ref } of revisionDependencies(revision)) {
      const key = revisionKey({ kind, ...ref });
      const parents = dependents.get(key) ?? new Set<string>();
      parents.add(revisionKey(revision));
      dependents.set(key, parents);
    }
  const affected = new Set(changes.map((change) => change.key));
  const pending = [...affected];
  for (let index = 0; index < pending.length; index++)
    for (const parent of dependents.get(pending[index]!) ?? [])
      if (!affected.has(parent)) {
        affected.add(parent);
        pending.push(parent);
      }
  return { changes, affected: [...affected].sort(compareIds) };
}
