import {
  assertJson,
  compareIds,
  RefSchema,
  RevisionSchema,
  RevisionGraphError,
  revisionKey,
  revisionReference,
  revisionHash,
  revisionIndex,
  resolveClosure,
  characterLoadout,
  validatePolicyAbilities,
  type Revision,
} from '@fantasy/domain/spatial';

export const CATALOG_AUTHORING_LIMIT = 4096;
const placeholderHash = 'sha256:' + '0'.repeat(64);
const documentFields = new Set([
  'kind',
  'id',
  'revision',
  'schemaVersion',
  'contentHash',
  'definition',
]);

function document(input: unknown) {
  assertJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('An authored revision must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !documentFields.has(key)))
    throw new Error('Unknown authored revision field');
  const kind = RevisionSchema.options
    .map((schema) => schema.shape.kind.value)
    .find((candidate) => candidate === value.kind);
  if (!kind || (value.schemaVersion !== undefined && value.schemaVersion !== 1))
    throw new Error('Unsupported authored revision kind/schema');
  const header = RefSchema.parse({
    id: value.id,
    revision: value.revision,
    contentHash: value.contentHash ?? placeholderHash,
  });
  return {
    expectedHash: value.contentHash === undefined ? null : header.contentHash,
    header: { kind, ...header, schemaVersion: 1 as const },
    definition: value.definition,
  };
}

/** Only the explicit single-key $ref form is expanded; pinned references stay pinned. */
function expandReferences(value: unknown, reference: (key: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => expandReferences(entry, reference));
  if (!value || typeof value !== 'object') return value;
  const fields = value as Record<string, unknown>;
  if (Object.hasOwn(fields, '$ref')) {
    if (Object.keys(fields).length !== 1 || typeof fields.$ref !== 'string')
      throw new Error('Expected a single $ref with kind:id:revision');
    return reference(fields.$ref);
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, entry]) => [key, expandReferences(entry, reference)]),
  );
}

/** Compile authoring documents through the existing bounded revision graph and hash contract. */
export async function compileCatalog(inputs: readonly unknown[]): Promise<Revision[]> {
  if (!inputs.length || inputs.length > CATALOG_AUTHORING_LIMIT)
    throw new Error('Authored catalog size outside supported bounds');
  const documents = new Map<string, ReturnType<typeof document>>();
  for (const input of inputs) {
    const entry = document(input),
      key = revisionKey(entry.header);
    if (documents.has(key))
      throw new RevisionGraphError('duplicate-revision', `Duplicate authored revision: ${key}`);
    documents.set(key, entry);
  }
  const provisional = [...documents.values()].map((entry) =>
    RevisionSchema.parse({
      ...entry.header,
      definition: expandReferences(entry.definition, (key) => {
        const target = documents.get(key);
        if (!target)
          throw new RevisionGraphError('missing-revision', `Unknown authored reference: ${key}`);
        const { id, revision, contentHash } = target.header;
        return { id, revision, contentHash };
      }),
    }),
  );
  const lookup = revisionIndex(provisional);
  const ordered = resolveClosure(provisional, lookup, CATALOG_AUTHORING_LIMIT, {
    order: 'dependencies-first',
  });
  const compiled = new Map<string, Revision>();
  for (const candidate of ordered) {
    const key = revisionKey(candidate),
      entry = documents.get(key)!;
    const revision = RevisionSchema.parse({
      ...entry.header,
      definition: expandReferences(entry.definition, (dependency) => {
        const target = compiled.get(dependency);
        if (!target)
          throw new RevisionGraphError(
            'missing-revision',
            `Unresolved authored reference: ${dependency}`,
          );
        return revisionReference(target);
      }),
    });
    const hash = await revisionHash(revision);
    if (entry.expectedHash !== null && entry.expectedHash !== hash)
      throw new Error(`Authored revision content hash mismatch: ${key}`);
    compiled.set(key, { ...revision, contentHash: hash });
  }
  // Preserve the published kind/ID ordering, including IDs that prefix another ID.
  const revisions = [...compiled.values()].sort(
    (a, b) => compareIds(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`) || a.revision - b.revision,
  );
  const resolved = revisionIndex(revisions);
  resolveClosure(revisions, resolved, CATALOG_AUTHORING_LIMIT);
  for (const revision of revisions)
    if (revision.kind === 'character') {
      resolveClosure([revision], resolved);
      validatePolicyAbilities(characterLoadout(revisionReference(revision), resolved));
    }
  return revisions;
}
