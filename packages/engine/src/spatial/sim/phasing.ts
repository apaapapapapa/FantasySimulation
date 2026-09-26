import { canonicalJson, type PhaseContribution } from '@fantasy/domain/spatial/execution';
import { activePhaseContributions, combinedPhase } from '../rules/phasing.ts';
import { capsuleOverlapsObstacle } from '../world/geometry.ts';
import { bodyCapsule } from '../world/terrain.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import { selfView } from '../ai/self-view.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';

/** Full solid clearance resets the lifetime counter; active masks never reset an embedded exit. */
function embedded(tx: StepTransaction, index: number) {
  const actor = tx.next.actors[index]!,
    body = bodyCapsule(actor.body.motion.actor.character.body);
  const world = tx.context.world.forQuery({ ownerId: actorId(actor) });
  world.countCast();
  return world
    .obstacles('movement')
    .filter((o) => capsuleOverlapsObstacle(actor.body.motion.position, body, o));
}
export function updateBodyPhasing(tx: StepTransaction) {
  for (const [index, actor] of tx.next.actors.entries()) {
    const previous = actor.body.motion.phasing;
    const active = activePhaseContributions(
      actor,
      tx.step,
      selfView(actor, tx.step, tx.context.battle.rules.ai, tx.context.battle.statuses).silenced,
    );
    if (!active.length && !previous) continue;
    const allPrior = [...(previous?.active ?? []), ...(previous?.retained ?? [])];
    const occupied = embedded(tx, index),
      current = combinedPhase(active);
    const retained: PhaseContribution[] = [];
    for (const contribution of allPrior) {
      const materials = contribution.materials.filter(
        (material) =>
          occupied.some(
            (o) => !o.id.startsWith('boundary.') && (o.material ?? 'generic') === material,
          ) &&
          (!current.materials.includes(material) || (contribution.floor && !current.floor)),
      );
      if (!materials.length) continue;
      const next = { ...contribution, materials };
      if (!retained.some((c) => canonicalJson(c) === canonicalJson(next))) retained.push(next);
    }
    const exitPending = occupied.length > 0 && (!!previous?.exitPending || retained.length > 0),
      extendedIntervals = occupied.length ? (previous?.extendedIntervals ?? 0) : 0;
    const cause =
      retained.flatMap((c) => c.causes)[0] ??
      previous?.retained.flatMap((c) => c.causes)[0] ??
      active.flatMap((c) => c.causes)[0] ??
      actorId(actor);
    if (active.length + retained.length > 256)
      throw new SpatialBudgetError('spatial-phase-contributions', undefined, {
        observed: active.length + retained.length,
        limit: 256,
        cause,
      });
    if (exitPending && extendedIntervals >= 50)
      throw new SpatialBudgetError('phase-exit-steps', undefined, {
        observed: extendedIntervals + 1,
        limit: 50,
        cause,
      });
    actor.body.motion.phasing =
      active.length || retained.length || exitPending
        ? { active, retained, exitPending, extendedIntervals }
        : null;
    if (canonicalJson(previous ?? null) !== canonicalJson(actor.body.motion.phasing))
      tx.journal.emit({
        kind: 'diagnostic',
        phase: 'boundary',
        step: tx.step,
        actorId: actorId(actor),
        ruleId: 'phasing.boundary',
        reason: exitPending ? 'exit-pending' : active.length ? 'active' : 'solid',
        causes: [...new Set([...active, ...retained].flatMap((c) => c.causes))],
      });
  }
}
/** Teleport may clear a pending exit within its existing budget; it cannot erase prior work. */
export function clearRelocatedPhasing(tx: StepTransaction) {
  for (const [index, actor] of tx.next.actors.entries()) {
    const phase = actor.body.motion.phasing;
    if (!phase?.exitPending || embedded(tx, index).length) continue;
    actor.body.motion.phasing = phase.active.length
      ? { ...phase, retained: [], exitPending: false, extendedIntervals: 0 }
      : null;
  }
}
export function executedPhaseInterval(tx: StepTransaction) {
  for (const actor of tx.next.actors) {
    const phase = actor.body.motion.phasing;
    if (phase?.exitPending)
      actor.body.motion.phasing = { ...phase, extendedIntervals: phase.extendedIntervals + 1 };
  }
}
