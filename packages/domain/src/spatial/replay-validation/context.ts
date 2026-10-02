import {
  characterLoadout,
  validateAbilityLoadout,
  revisionHash,
  revisionIndex,
  revisionDependencies,
  resolveClosure,
} from '../revision-graph.ts';
import { canonicalJson, compareIds, contentHash, deepFreeze } from '../canonical.ts';
import { parseJson, skillReceiptExecutionResolutions } from '../contracts.ts';
import { RecordedManifestSchema } from '../replay.ts';
import { fail, requireReplay } from './common.ts';
export type ReplayContext = Awaited<ReturnType<typeof replayContext>>;
/** Validate content identity and resolve display metadata without loading any engine/WASM. */
export async function replayContext(input: unknown, simulationHash: string) {
  const manifest = parseJson(RecordedManifestSchema, input);
  let get: ReturnType<typeof revisionIndex>;
  try {
    get = revisionIndex(manifest.revisions);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'revision index');
  }
  for (const revision of manifest.revisions)
    requireReplay(revision.contentHash === (await revisionHash(revision)), 'revision content hash');
  for (const participant of manifest.participants) {
    const receipt = participant.skillLoadout;
    if (!receipt) continue;
    requireReplay(
      canonicalJson(receipt.character) === canonicalJson(participant.character),
      'skill loadout character',
    );
  }
  // Replay v1 historically checks ability/status references but not status transformation closure.
  // Preserve its acceptance boundary while sharing the graph traversal.
  let actors;
  try {
    resolveClosure(manifest.revisions, get, 256, {
      dependencies: (revision) =>
        revision.kind === 'status' ? [] : revisionDependencies(revision),
    });
    actors = manifest.participants.map((participant) => {
      const { character, abilities } = characterLoadout(participant.character, get);
      const originalAbilities = new Map(abilities.map((ability) => [ability.id, ability])),
        byId = new Map(originalAbilities);
      for (const item of participant.skillLoadout
        ? skillReceiptExecutionResolutions(participant.skillLoadout)
        : []) {
        if (item.kind === 'augment') {
          const base = get('ability', item.baseAbility),
            resolved = get('ability', item.resolvedAbility),
            equipped = originalAbilities.get(base.id);
          requireReplay(
            !!equipped &&
              equipped.revision === base.revision &&
              equipped.contentHash === base.contentHash,
            'augment base ability',
          );
          requireReplay(
            resolved.id === base.id &&
              (resolved.revision !== base.revision || resolved.contentHash !== base.contentHash) &&
              resolved.definition.trigger === base.definition.trigger,
            'augment identity and trigger',
          );
          byId.set(resolved.id, resolved);
          continue;
        }
        const ability = get('ability', item.ability);
        if (participant.skillLoadout?.schemaVersion !== 1)
          requireReplay(
            item.kind === 'active-ability'
              ? ability.definition.trigger === 'action'
              : ability.definition.trigger !== 'action',
            'skill ability trigger',
          );
        const previous = byId.get(ability.id);
        requireReplay(
          !previous ||
            (previous.revision === ability.revision &&
              previous.contentHash === ability.contentHash),
          'conflicting skill ability',
        );
        byId.set(ability.id, ability);
      }
      validateAbilityLoadout([...byId.values()]);
      return {
        participant,
        character,
        abilities: [...byId.values()].sort((a, b) => compareIds(a.id, b.id)),
      };
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'revision graph');
  }
  requireReplay(
    actors[0]!.participant.actorId !== actors[1]!.participant.actorId,
    'duplicate actor',
  );
  const rules = get('ruleset', manifest.ruleset).definition;
  requireReplay(rules.rulesVersion === manifest.engineVersion, 'rules/engine version mismatch');
  get('scenario', manifest.scenario);
  requireReplay(
    (await contentHash(manifest.physicsProfile)) === manifest.physicsProfileHash,
    'physics profile hash',
  );
  requireReplay((await contentHash(manifest)) === simulationHash, 'simulation hash');
  return deepFreeze({ manifest, simulationHash, actors, rules });
}

export type ReplayActor = ReplayContext['actors'][number];
