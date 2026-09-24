import {
  actorSeed,
  contentHash,
  CURRENT_ENGINE_VERSION,
  parseJson,
  RevisionSchema,
  characterLoadout,
  validatePolicyAbilities,
  revisionDependencies,
  revisionHash,
  revisionIndex,
  revisionKey,
  revisionReference,
  requireRevision,
  resolveClosure,
  RevisionGraphError,
  type Definition,
  type DefinitionKind,
  type Manifest,
  type Revision,
  type RevisionLookup,
  type RevisionRef,
} from '@fantasy/domain/spatial/execution';
import { prepareBattle, implementation, profile } from './prepare.ts';
import {
  EngineInputError,
  requireExecutable,
  rulesExecutionEligibility,
} from './execution-policy.ts';

export type ManifestInput = Pick<Manifest, 'seed' | 'participants' | 'ruleset' | 'scenario'>;
type UnseededParticipant = Omit<Manifest['participants'][number], 'rngSeed' | 'rngStream'>;
export function deriveParticipants(
  seed: number,
  participants: [UnseededParticipant, UnseededParticipant],
): Manifest['participants'] {
  const input = structuredClone(participants);
  return [
    { ...input[0], rngStream: 0, rngSeed: actorSeed(seed, 0) },
    { ...input[1], rngStream: 1, rngSeed: actorSeed(seed, 1) },
  ];
}
export async function sealRevision<K extends DefinitionKind>(
  kind: K,
  id: string,
  revision: number,
  definition: Definition<K>,
): Promise<Extract<Revision, { kind: K }>> {
  // Clone and validate before yielding so the hash seals the returned snapshot.
  const snapshot = parseJson(RevisionSchema, {
    kind,
    id,
    revision,
    schemaVersion: 1,
    contentHash: `sha256:${'0'.repeat(64)}`,
    definition,
  });
  if (snapshot.kind === 'ruleset')
    requireExecutable(rulesExecutionEligibility(snapshot.definition));
  snapshot.contentHash = await revisionHash(snapshot);
  return snapshot as Extract<Revision, { kind: K }>;
}

/** Construction tooling lives outside the execution import closure. */
export class ManifestBuilder {
  private readonly lookup: RevisionLookup;
  constructor(lookup: RevisionLookup) {
    this.lookup = lookup;
  }
  static from(revisions: readonly Revision[]) {
    return new ManifestBuilder(revisionIndex(structuredClone(revisions)));
  }
  static create = sealRevision;
  static participants = deriveParticipants;
  closure(roots: readonly Revision[], limit = 256) {
    const revisions = resolveClosure(roots, this.lookup, limit);
    const get = revisionIndex(revisions);
    for (const revision of revisions)
      if (revision.kind === 'character')
        validatePolicyAbilities(characterLoadout(revisionReference(revision), get));
    return revisions;
  }
  async build(input: ManifestInput) {
    const request = structuredClone(input);
    const get = <K extends DefinitionKind>(kind: K, ref: RevisionRef) =>
      requireRevision(this.lookup, kind, ref);
    const rules = get('ruleset', request.ruleset);
    requireExecutable(rulesExecutionEligibility(rules.definition));
    const revisions = structuredClone(
      this.closure([
        ...request.participants.map((participant) => get('character', participant.character)),
        rules,
        get('scenario', request.scenario),
      ]),
    );
    return prepareBattle({
      ...request,
      schemaVersion: 3,
      eventSchemaVersion: 1,
      replaySchemaVersion: 1,
      engineVersion: CURRENT_ENGINE_VERSION,
      aiProfile: 'observed-utility-v1',
      implementationDigest: implementation.digest,
      physicsProfileHash: await contentHash(profile),
      physicsProfile: profile,
      wasmHash: implementation.wasm,
      angleTableHash: implementation.table,
      prng: 'xorshift32-v1',
      seedDerivation: 'actor-stream-v1',
      revisions,
    });
  }
  /** Replace owned nodes and reseal their owners in dependency order without reordering arrays. */
  static async relink(
    input: Manifest,
    changes: readonly { from: Revision; to: Revision }[],
  ): Promise<Manifest> {
    const manifest = structuredClone(input),
      replacements = structuredClone(changes);
    const originals = revisionIndex(manifest.revisions),
      changed = new Map<string, Revision>();
    for (const { from, to } of replacements) {
      requireRevision(originals, from.kind, revisionReference(from));
      if (from.kind !== to.kind || changed.has(revisionKey(from)))
        throw new RevisionGraphError(
          'duplicate-revision',
          'Invalid or repeated revision replacement',
        );
      const replacement = parseJson(RevisionSchema, to);
      if (replacement.contentHash !== (await revisionHash(replacement)))
        throw new EngineInputError(
          'revision-content',
          `Revision content hash mismatch: ${replacement.id}`,
        );
      changed.set(revisionKey(from), replacement);
    }
    const owned = new Map(manifest.revisions.map((revision) => [revisionKey(revision), revision]));
    const targets = new Map<string, Revision>();
    for (const revision of manifest.revisions) {
      const target = changed.get(revisionKey(revision)) ?? revision;
      if (
        targets.has(revisionKey(target)) ||
        (owned.has(revisionKey(target)) && revisionKey(target) !== revisionKey(revision))
      )
        throw new RevisionGraphError('duplicate-revision', 'Replacement identity is already owned');
      targets.set(revisionKey(target), revision);
    }
    for (const { from, to } of replacements)
      if (
        from.kind === 'ability' &&
        from.id !== to.id &&
        manifest.revisions.some(
          (revision) =>
            revision.kind === 'ability' &&
            revision.id === from.id &&
            revisionKey(revision) !== revisionKey(from),
        )
      )
        throw new RevisionGraphError(
          'duplicate-revision',
          'Ability ID rename is ambiguous across owned revisions',
        );
    const source = (kind: DefinitionKind, ref: RevisionRef): Revision | undefined => {
      const key = revisionKey({ kind, ...ref });
      const original = owned.get(key);
      if (original?.contentHash === ref.contentHash) return original;
      const owner = targets.get(key);
      if (owner && (changed.get(revisionKey(owner)) ?? owner).contentHash === ref.contentHash)
        return owner;
      if (original || owner)
        throw new RevisionGraphError('missing-revision', `Mismatched owned revision: ${key}`);
      return undefined; // Assembly may add this external revision later; build validates the complete closure.
    };
    const ordered = resolveClosure(manifest.revisions, originals, 256, {
      order: 'dependencies-first',
      dependencies: (revision) =>
        revisionDependencies(changed.get(revisionKey(revision)) ?? revision).flatMap(
          ({ kind, ref }) => {
            const owner = source(kind, ref);
            return owner ? [{ kind: owner.kind, ref: revisionReference(owner) }] : [];
          },
        ),
    });
    const sealed = new Map<string, Revision>();
    const referenceFor = (kind: DefinitionKind, ref: RevisionRef): RevisionRef => {
      const owner = source(kind, ref);
      return owner ? revisionReference(sealed.get(revisionKey(owner))!) : ref;
    };
    const abilityIds = new Map(
      replacements.filter((r) => r.from.kind === 'ability').map(({ from, to }) => [from.id, to.id]),
    );
    for (const original of ordered) {
      const revision = changed.get(revisionKey(original)) ?? original;
      for (const edge of revisionDependencies(revision))
        Object.assign(edge.ref, referenceFor(edge.kind, edge.ref));
      if (revision.kind === 'policy')
        for (const priority of revision.definition.priorities)
          priority.abilityId = abilityIds.get(priority.abilityId) ?? priority.abilityId;
      sealed.set(
        revisionKey(original),
        await sealRevision(revision.kind, revision.id, revision.revision, revision.definition),
      );
    }
    for (const participant of manifest.participants)
      participant.character = referenceFor('character', participant.character);
    manifest.ruleset = referenceFor('ruleset', manifest.ruleset);
    manifest.scenario = referenceFor('scenario', manifest.scenario);
    manifest.revisions = manifest.revisions.map((revision) => sealed.get(revisionKey(revision))!);
    revisionIndex(manifest.revisions);
    return manifest;
  }
}
