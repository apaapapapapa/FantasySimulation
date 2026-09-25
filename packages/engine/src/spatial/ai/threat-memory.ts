import type { DecisionView, PerceptionMemory, ThreatExperience, MotionState } from '../state.ts';
import type { DeepReadonly, Effect } from '@fantasy/domain/spatial/execution';
import { canSee, bodyPoint } from '../world/visibility.ts';
import type { SpatialWorld } from '../world/physics.ts';

/** Self impacts and visible attack cues cross the same delayed, bounded memory boundary. */
export function rememberThreat(
  memory: PerceptionMemory,
  entry: ThreatExperience,
): PerceptionMemory {
  const history = memory.threatHistory ?? [];
  if (
    history.some(
      (e) =>
        e.eventId === entry.eventId && e.statusId === entry.statusId && e.element === entry.element,
    )
  )
    return memory;
  return { ...memory, threatHistory: [...history, entry].slice(-32) };
}
export function seenAttack(
  world: SpatialWorld,
  self: MotionState,
  source: MotionState,
  effects: readonly DeepReadonly<Effect>[],
  eventId: string,
  step: number,
  memory: PerceptionMemory,
  ttl: number,
) {
  if (
    source.vision?.visible === false ||
    !canSee(world, self, bodyPoint(source, source.actor.character.body.muzzleOffset))
  )
    return memory;
  for (const element of new Set(effects.flatMap((e) => (e.kind === 'damage' ? [e.element] : []))))
    memory = rememberThreat(memory, {
      eventId: `${eventId}.${element}`,
      sourceId: source.actor.participant.actorId,
      element,
      sampledAt: step,
      availableAt: step + self.actor.character.perception.reactionSteps,
      expiresAt: step + ttl,
    });
  return memory;
}

export function reapplicationEstimate(view: DecisionView, statusId: string, activation: number) {
  if (!view.rules.reapplication) return null;
  const history = (view.memory.threatHistory ?? []).filter(
    (e) => e.availableAt <= view.step && e.expiresAt > view.step,
  );
  const applied = history.filter((e) => e.statusId === statusId);
  const last = applied.at(-1);
  if (!last) return null;
  let observations = applied.filter((e) => e.sourceId === last.sourceId);
  if (new Set(observations.map((e) => e.sampledAt)).size < 2)
    observations = last.element
      ? history.filter(
          (e) => !e.statusId && e.sourceId === last.sourceId && e.element === last.element,
        )
      : [];
  const samples = [...new Set(observations.map((e) => e.sampledAt))].sort((a, b) => a - b);
  if (samples.length < 2) return null;
  const interval = Math.max(1, Math.round((samples.at(-1)! - samples[0]!) / (samples.length - 1)));
  const origin = Math.max(last.sampledAt, samples.at(-1)!);
  const next = origin + Math.max(1, Math.ceil((activation - origin) / interval)) * interval;
  return {
    statusId,
    intervalSteps: interval,
    effectiveSteps: Math.max(0, next - activation),
    basis: observations[0]!.statusId ? ('self-application' as const) : ('visible-element' as const),
    evidence: observations.map((e) => e.eventId),
  };
}
