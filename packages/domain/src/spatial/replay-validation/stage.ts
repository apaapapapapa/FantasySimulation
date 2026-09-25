import { stageWindow, actionActiveUntil } from '../combat-derivations.ts';
import type { DeepReadonly } from '../canonical.ts';
import type { StageContact } from '../contracts.ts';
import type { RecordedManifest } from '../replay.ts';
import type { ActorDisplay } from '../stream.ts';
import type { ReplayActor } from './context.ts';
import { fail, requireReplay, same } from './common.ts';
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
    if (action.stage.geometry) {
      const geometry = action.stage.geometry,
        shape = stage.attack;
      if (geometry.kind === 'blade') {
        if (shape?.kind !== 'arc' && shape?.kind !== 'radial') return fail('blade shape');
        requireReplay(
          geometry.radiusMm === shape.bladeRadiusMm && geometry.poses[0]!.fraction === 0,
          'blade radius/start',
        );
        for (const [i, pose] of geometry.poses.entries())
          requireReplay(
            pose.root.y === pose.tip.y &&
              Math.abs(
                Math.sqrt((pose.tip.x - pose.root.x) ** 2 + (pose.tip.z - pose.root.z) ** 2) -
                  shape.reachMm / 1000,
              ) < 1e-6 &&
              (i === 0 || pose.fraction > geometry.poses[i - 1]!.fraction),
            'blade length/time',
          );
      } else {
        requireReplay(
          !!shape &&
            (shape.kind === 'melee' || shape.kind === 'hitscan') &&
            geometry.kind === (shape.kind === 'melee' ? 'sphere' : 'ray') &&
            geometry.radiusMm === shape.radiusMm,
          'stage geometry shape',
        );
        for (let i = 1; i < geometry.segments.length; i++) {
          const previous = geometry.segments[i - 1]!,
            current = geometry.segments[i]!;
          requireReplay(
            Math.abs(previous.to - current.from) <= 1e-12 && same(previous.end, current.start),
            'stage geometry continuity',
          );
        }
      }
    }
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
