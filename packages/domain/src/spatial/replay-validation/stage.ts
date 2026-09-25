import { stageWindow, actionActiveUntil } from '../combat-derivations.ts';
import type { DeepReadonly } from '../canonical.ts';
import type { StageContact } from '../contracts.ts';
import type { RecordedManifest } from '../replay.ts';
import type { ActorDisplay } from '../stream.ts';
import type { ReplayActor } from './context.ts';
import { fail, requireReplay } from './common.ts';
import { validateGeometry } from './geometry.ts';
type RecordedRevision = RecordedManifest['revisions'][number];
export function recordedStage(
  ability: DeepReadonly<Extract<RecordedRevision, { kind: 'ability' }>> | undefined,
  contact: StageContact,
) {
  const stage = ability?.definition.stages?.[contact.stageIndex];
  if (
    !stage ||
    stage.id !== contact.stageId ||
    contact.emitterId !== 0 ||
    contact.hitGroupId !== (stage.hit?.group ?? 'shared')
  )
    return fail('stage reference');
  return stage;
}

export function validateStage(
  actor: ActorDisplay,
  ability: ReplayActor['abilities'][number] | undefined,
  step: number,
  activeUntil: number,
) {
  const action = actor.action!;
  if (action.stage) {
    const stage = recordedStage(ability, action.stage.contact),
      last = ability!.definition.stages!.at(-1)!;
    requireReplay(
      action.stage.contact.actionId === action.id &&
        action.stage.startAt === stageWindow(action.launchAt, stage).startAt &&
        action.stage.endAt === stageWindow(action.launchAt, stage).endAt &&
        action.activeUntil === actionActiveUntil(action.launchAt, ability!.definition) &&
        action.stage.shape === (stage.attack?.kind ?? 'hold'),
      'stage display clocks/shape',
    );
    requireReplay(
      action.stage.state !== 'active' ||
        (step >= action.stage.startAt && step < action.stage.endAt && action.phase === 'active'),
      'active stage window',
    );
    const state = action.stage.state;
    requireReplay(
      (action.phase !== 'active' || state === 'active') &&
        (state !== 'preparing' ||
          (step < action.launchAt && action.stage.contact.stageIndex === 0)) &&
        (state !== 'complete' || (stage === last && step >= activeUntil)) &&
        (state !== 'waiting' ||
          step === action.launchAt ||
          (step >= action.stage.endAt && step < activeUntil)),
      'stage state window',
    );
    if (action.stage.geometry) validateGeometry(stage.attack, action.stage.geometry);
    if (action.stage.motion) {
      const motion = action.stage.motion,
        configured = stage.selfMotion;
      requireReplay(
        !!configured &&
          motion.kind === configured.kind &&
          motion.speedMmPerSecond === configured.speedMmPerSecond &&
          motion.accelerationMmPerSecond2 === configured.accelerationMmPerSecond2 &&
          motion.fromStep >= action.stage.startAt &&
          motion.fromStep < action.stage.endAt &&
          motion.fromStep < step &&
          (!actor.force?.active || motion.fromStep !== actor.force.fromStep || !motion.applied),
        'stage motion reference/time',
      );
    }
  } else
    requireReplay(
      !ability?.definition.stages && action.activeUntil === undefined,
      'missing stage display',
    );
}
