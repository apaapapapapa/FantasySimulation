import { createHash } from 'node:crypto';
import {
  SkillCatalogSchema,
  canonicalJson,
  parseCompleteSkillCatalog,
  revisionRefKey,
  skillCoordinateKey,
  type RevisionRef,
  type SkillCatalog,
} from '@fantasy/domain';

type ReleaseIdentity = {
  readonly reference: Readonly<RevisionRef>;
  readonly parent: Readonly<RevisionRef> | null;
  readonly changedNodeIds: readonly string[];
};

/** Checkpoints are a historical boundary; ordinary releases append explicit node deltas. */
export type SkillCatalogRelease = ReleaseIdentity &
  (
    | { readonly kind: 'historical-snapshot'; readonly catalog: unknown }
    | {
        readonly kind: 'delta';
        readonly changes: readonly { readonly nodeId: string; readonly node: unknown }[];
      }
  );

export class SkillCatalogReleaseError extends Error {
  readonly code:
    | 'duplicate-revision'
    | 'invalid-parent'
    | 'invalid-node'
    | 'undeclared-change'
    | 'content-mismatch';

  constructor(code: SkillCatalogReleaseError['code'], message: string) {
    super(message);
    this.name = 'SkillCatalogReleaseError';
    this.code = code;
  }
}

function fail(code: SkillCatalogReleaseError['code'], message: string): never {
  throw new SkillCatalogReleaseError(code, message);
}

function catalogForRelease(release: SkillCatalogRelease, parent: SkillCatalog | undefined) {
  if (release.kind === 'historical-snapshot') return SkillCatalogSchema.parse(release.catalog);
  if (!parent) fail('invalid-parent', 'A delta needs an exact previously assembled parent');
  const nodes = new Map(parent.nodes.map((node) => [node.id, node])),
    changed = new Set<string>();
  for (const replacement of release.changes) {
    const prior = nodes.get(replacement.nodeId);
    if (!prior || changed.has(replacement.nodeId))
      fail('invalid-node', `Missing or repeated replacement node: ${replacement.nodeId}`);
    // Reuse the catalog's domain-owned node schema; do not create another recipe schema.
    const node = SkillCatalogSchema.shape.nodes.element.parse(replacement.node);
    if (
      node.id !== replacement.nodeId ||
      skillCoordinateKey(node.coordinate) !== skillCoordinateKey(prior.coordinate)
    )
      fail('invalid-node', `Replacement changes node identity: ${replacement.nodeId}`);
    changed.add(node.id);
    nodes.set(node.id, node);
  }
  return parseCompleteSkillCatalog({
    ...parent,
    id: release.reference.id,
    revision: release.reference.revision,
    nodes: [...nodes.values()],
  });
}

function inspectDeclaredChanges(
  release: SkillCatalogRelease,
  catalog: SkillCatalog,
  parent: SkillCatalog | undefined,
) {
  const prior = new Map(parent?.nodes.map((node) => [node.id, node])),
    declared = new Set(release.changedNodeIds),
    changed = new Set<string>();
  if (declared.size !== release.changedNodeIds.length)
    fail('undeclared-change', 'Changed node IDs must be unique');
  for (const node of catalog.nodes) {
    const old = prior.get(node.id);
    if (
      parent &&
      (!old || skillCoordinateKey(old.coordinate) !== skillCoordinateKey(node.coordinate))
    )
      fail('invalid-node', `Release changes node identity: ${node.id}`);
    if (!old || canonicalJson(old) !== canonicalJson(node)) changed.add(node.id);
  }
  if (
    catalog.nodes.length !== (parent?.nodes.length ?? catalog.nodes.length) ||
    changed.size !== declared.size ||
    [...changed].some((id) => !declared.has(id))
  )
    fail('undeclared-change', 'Actual node changes do not match the declared release changes');
}

/** Assemble immutable history without consulting current authoring or updating persistence. */
export function assembleSkillCatalogReleases(
  releases: readonly SkillCatalogRelease[],
): SkillCatalog[] {
  const catalogs: SkillCatalog[] = [],
    byRevision = new Map<string, { reference: Readonly<RevisionRef>; catalog: SkillCatalog }>();
  for (const release of releases) {
    const key = `${release.reference.id}@${release.reference.revision}`;
    if (byRevision.has(key)) fail('duplicate-revision', `Repeated catalog revision: ${key}`);
    const parentRecord = release.parent
        ? byRevision.get(`${release.parent.id}@${release.parent.revision}`)
        : undefined,
      parent = parentRecord?.catalog;
    if (
      (release.parent &&
        (!parentRecord ||
          revisionRefKey(release.parent) !== revisionRefKey(parentRecord.reference) ||
          release.reference.id !== release.parent.id ||
          release.reference.revision <= release.parent.revision)) ||
      (!release.parent && catalogs.length > 0)
    )
      fail('invalid-parent', `Missing, changed or non-ancestral catalog parent: ${key}`);
    const catalog = catalogForRelease(release, parent),
      canonical = parseCompleteSkillCatalog(catalog);
    inspectDeclaredChanges(release, catalog, parent);
    const hash = `sha256:${createHash('sha256').update(canonicalJson(canonical)).digest('hex')}`;
    if (
      catalog.id !== release.reference.id ||
      catalog.revision !== release.reference.revision ||
      hash !== release.reference.contentHash
    )
      fail('content-mismatch', `Catalog differs from its immutable release identity: ${key}`);
    catalogs.push(catalog);
    byRevision.set(key, { reference: release.reference, catalog });
  }
  return catalogs;
}
