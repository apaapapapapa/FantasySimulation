import {
  characterLoadout,
  revisionHash,
  revisionIndex,
  revisionDependencies,
  resolveClosure,
} from '../revision-graph.ts';
import { contentHash, deepFreeze } from '../canonical.ts';
import { parseJson } from '../contracts.ts';
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
      return { participant, character, abilities };
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
