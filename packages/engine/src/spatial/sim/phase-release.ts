import { hitscan, inObservedRange, launchDirection, muzzleBlocked } from '../rules/attacks.ts';
import { add, mul, sub } from '../math.ts';
import { selfView } from '../ai/self-view.ts';
import { blockedBySilence } from '../rules/categories.ts';
import { bodyPoint } from '../world/visibility.ts';
import { conditionMatches } from '../rules/conditions.ts';
import { straight } from '../world/physics.ts';
import { isDodgeDecision } from '../ai/policy.ts';
import { displayProjectile, type ProjectileState } from '../rules/projectiles.ts';
import { statusDamageSource } from '../rules/status-damage.ts';
import { interruptStage, releaseStage } from '../rules/stages.ts';
import { applyStageMotion } from '../rules/stage-motion.ts';
import { releaseCounters } from './counter-release.ts';
import { seenAttack } from '../ai/threat-memory.ts';
import { postureAllows } from '../rules/posture.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { effectsOf } from './step-effects.ts';
export function releasePhase(tx: StepTransaction) {
  const { battle, world, work } = tx.context;
  const {
    step,
    journal,
    effects,
    resourceBudgets,
    forcePlans,
    spawns,
    aiBoundary,
    previousMovement,
  } = tx;
  const next = tx.next.actors,
    attacks = tx.next.melees,
    bullets = tx.next.projectiles,
    nextLedger = tx.next.ledger;
  for (const actor of next) {
    const action = actor.actions.action;
    if (!action) continue;
    if (!action.stages && (action.released || action.launchAt !== step)) continue;
    const releaseView = selfView(actor, step, battle.rules.ai, battle.statuses);
    const staged = action.stages
      ? releaseStage(actor, releaseView, step, resourceBudgets.get(actorId(actor))!, journal, {
          dodge: aiBoundary && isDodgeDecision(actor.mind.decision),
          previous: previousMovement.get(actorId(actor))!,
        })
      : null;
    if (action.stages && !staged?.ability) continue;
    if (!staged) action.released = true;
    const ability = staged?.ability ?? action.ability;
    const definition = ability.definition;
    if (
      !postureAllows(actor.body.motion, definition) ||
      (!staged &&
        (!inObservedRange(definition, releaseView) ||
          releaseView.incapacitated ||
          !conditionMatches(definition.condition, releaseView) ||
          (releaseView.silenced && blockedBySilence(definition))))
    ) {
      journal.emit({
        kind: 'fizzle',
        step,
        phase: 'launch',
        actorId: actorId(actor),
        abilityId: ability.id,
        parentEventId: action.cause,
        ruleId: 'action.release',
        reason: 'Release condition/range no longer holds; cost is retained',
      });
      continue;
    }
    const launch = journal.emit({
      kind: 'launch',
      step,
      phase: 'launch',
      actorId: actorId(actor),
      abilityId: ability.id,
      parentEventId: staged?.cause ?? action.cause,
      ruleId: 'action.release',
      ...(staged ? { stage: staged.contact } : {}),
    });
    if (definition.attack.kind === 'direct') {
      if (staged) nextLedger.contact(staged.contact, staged.hit, actorId(actor), step);
      effects.push(...effectsOf(actor, ability, actorId(actor), launch.id, step, staged?.contact));
      continue;
    }
    const enemy = next.find((a) => actorId(a) !== actorId(actor))!;
    if (battle.rules.ai.reapplication)
      enemy.mind.memory = seenAttack(
        world,
        enemy.body.motion,
        actor.body.motion,
        definition.effects,
        launch.id,
        step,
        enemy.mind.memory,
        battle.rules.ai.knowledgeTtlSteps,
      );
    const aim = launchDirection(
      actor.body.motion.facing,
      definition.aimErrorMilliDegrees,
      actor.mind.random,
    );
    actor.mind.random = aim.random;
    if (
      (definition.attack.kind === 'melee' ||
        definition.attack.kind === 'projectile' ||
        definition.attack.kind === 'arc' ||
        definition.attack.kind === 'radial') &&
      muzzleBlocked(world, actor.body.motion)
    ) {
      journal.emit({
        kind: 'fizzle',
        step,
        phase: 'launch',
        actorId: actorId(actor),
        abilityId: ability.id,
        parentEventId: launch.id,
        ruleId: `${definition.attack.kind}.muzzle-blocked`,
      });
      if (staged) interruptStage(actor, step, journal, 'launch', 'muzzle-blocked');
      continue;
    }
    if (definition.attack.kind === 'hitscan') {
      work.candidate();
      const contact = hitscan(
        world,
        actor.body.motion,
        enemy.body.motion,
        aim.direction,
        definition.rangeMm / 1000,
        definition.attack.radiusMm / 1000,
      );
      if (staged) {
        const origin = bodyPoint(
          actor.body.motion,
          actor.body.motion.actor.character.body.muzzleOffset,
        );
        action.stages!.geometry = {
          kind: 'ray',
          radiusMm: definition.attack.radiusMm,
          segments: straight(
            origin,
            contact?.point ?? add(origin, mul(aim.direction, definition.rangeMm / 1000)),
          ),
        };
      }
      if (contact) {
        if (contact.kind === 'body' && staged)
          nextLedger.contact(staged.contact, staged.hit, actorId(enemy), step);
        const hit = journal.emit({
          kind: contact.kind === 'body' ? 'hit' : 'fizzle',
          step,
          phase: 'contact',
          actorId: actorId(actor),
          targetId: contact.kind === 'body' ? actorId(enemy) : null,
          abilityId: ability.id,
          parentEventId: launch.id,
          ruleId: 'hitscan.first-contact',
          point: contact.point,
          reason: contact.kind,
          ...(staged ? { stage: staged.contact } : {}),
        });
        if (contact.kind === 'body')
          effects.push(
            ...effectsOf(actor, ability, actorId(enemy), hit.id, step, staged?.contact).map(
              (effect) => ({
                ...effect,
                observation: { self: actor.body.motion, target: enemy.body.motion },
              }),
            ),
          );
      }
    } else if (
      definition.attack.kind === 'melee' ||
      definition.attack.kind === 'arc' ||
      definition.attack.kind === 'radial'
    ) {
      attacks.push({
        id: staged?.id ?? action.id,
        actorId: actorId(actor),
        ability,
        cause: launch.id,
        launchStep: step,
        direction: aim.direction,
        offset: sub(
          bodyPoint(actor.body.motion, actor.body.motion.actor.character.body.muzzleOffset),
          actor.body.motion.position,
        ),
        ...statusDamageSource(actor, ability, step),
        hits: 0,
        ...(staged ? { stage: staged.contact, ...(staged.hit ? { hit: staged.hit } : {}) } : {}),
      });
    } else if (definition.attack.kind === 'projectile') {
      const target = actor.mind.memory.observation?.enemy ?? actor.mind.memory.lastSeen;
      const projectile: ProjectileState = {
        id: `projectile.${staged?.id ?? action.id}`,
        ownerId: actorId(actor),
        ...(staged ? { stage: staged.contact, ...(staged.hit ? { hit: staged.hit } : {}) } : {}),
        ability,
        cause: launch.id,
        launchStep: step,
        position: bodyPoint(actor.body.motion, actor.body.motion.actor.character.body.muzzleOffset),
        velocity: mul(aim.direction, definition.attack.speedMmPerSecond / 1000),
        ...statusDamageSource(actor, ability, step),
        target: target ? { ...target.position } : null,
      };
      const spawn = journal.emit({
        kind: 'projectile-spawn',
        step,
        phase: 'launch',
        entityId: projectile.id,
        actorId: projectile.ownerId,
        abilityId: ability.id,
        parentEventId: launch.id,
        ruleId: 'projectile.spawn',
        point: projectile.position,
      });
      projectile.cause = spawn.id;
      bullets.push(projectile);
      work.projectiles(bullets.length);
      spawns.push(displayProjectile(projectile));
    }
  }
  for (const actor of next) {
    const force = forcePlans.get(actorId(actor));
    if (force?.active) actor.body.intent.forced = { gravity: force.gravity!, force: force.force };
    applyStageMotion(actor, step);
  }
  effects.push(
    ...releaseCounters(next, battle, journal, world, step, nextLedger, () => {
      work.candidate();
    }),
  );
}
