import { DefinitionKindSchema, RefSchema, type Revision } from '@fantasy/domain/spatial';
import { revisionHash } from '@fantasy/engine/spatial';
import published from '../data/spatial/published-revisions.json' with { type: 'json' };

/** The reviewed release inventory is append-only; replacements need new definition IDs. */
export async function assertPublishedRevisions(revisions: readonly Revision[]) {
  const schema = RefSchema.extend({ kind: DefinitionKindSchema });
  const prior = [...published.revisions, ...published.additions].map((r) => schema.parse(r));
  const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
  const current = new Map(revisions.map((r) => [key(r), r]));
  if (current.size !== revisions.length || new Set(prior.map(key)).size !== prior.length)
    throw new Error('Duplicate catalog definition ID');
  if (current.size !== prior.length)
    throw new Error('Published sample inventory differs; record every distributed ID');
  for (const old of prior) {
    const actual = current.get(key(old));
    if (
      !actual ||
      actual.revision !== old.revision ||
      actual.contentHash !== old.contentHash ||
      (await revisionHash(actual)) !== old.contentHash
    )
      throw new Error(`Published sample changed: ${key(old)}; add a new ID`);
  }
}
