import { opponentInDuel } from './duel.ts';
import {
  matchAttack,
  type AttackHandlers,
  type AttackVariant,
  type BattleEvent,
} from '@fantasy/domain/spatial/execution';
import type { ActorState, ActionState, AbilityRevision } from '../state.ts';
import { launchDirection, muzzleBlocked } from '../rules/attacks.ts';
import { mul, sub, type Vec3 } from '../math.ts';
import { bodyPoint } from '../world/visibility.ts';
import { straight } from '../world/physics.ts';
import { displayProjectile, type ProjectileState } from '../rules/projectiles.ts';
import { statusDamageSource } from '../rules/status-damage.ts';
import { interruptStage, type releaseStage } from '../rules/stages.ts';
import { seenAttack } from '../ai/threat-memory.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import { effectsOf } from './step-effects.ts';
import { contactAttack } from '../rules/attack-contact.ts';
import { queueRelocation } from './relocation.ts';

type ReleaseContext = {
  tx: StepTransaction;
  actor: ActorState;
  action: ActionState;
  ability: AbilityRevision;
  staged: ReturnType<typeof releaseStage>;
  launch: BattleEvent;
};
type SpatialRelease = ReleaseContext & { enemy: ActorState; aim: { direction: Vec3 } };

function spatial<K extends Exclude<AttackVariant['kind'], 'direct'>>(
  shape: AttackVariant<K>,
  context: ReleaseContext,
  needsMuzzle: boolean,
  fire: (shape: AttackVariant<K>, context: SpatialRelease) => void,
) {
  const { tx, actor, ability, staged, launch } = context;
  const { world, battle } = tx.context;
  const definition = ability.definition,
    step = tx.step;
  const enemy = opponentInDuel(tx.next.actors, actorId(actor), actorId);
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
  if (needsMuzzle && muzzleBlocked(world, actor.body.motion)) {
    tx.journal.emit({
      kind: 'fizzle',
      step,
      phase: 'launch',
      actorId: actorId(actor),
      abilityId: ability.id,
      parentEventId: launch.id,
      ruleId: `${shape.kind}.muzzle-blocked`,
    });
    if (staged) interruptStage(actor, step, tx.journal, 'launch', 'muzzle-blocked');
    return;
  }
  fire(shape, { ...context, enemy, aim });
}
function releaseRay(shape: AttackVariant<'hitscan'>, context: SpatialRelease) {
  const { tx, actor, action, ability, staged, launch, enemy, aim } = context;
  const { world, work } = tx.context;
  const { step, journal, effects } = tx;
  const definition = ability.definition,
    nextLedger = tx.next.ledger;

  work.candidate();
  const result = contactAttack(shape, {
    world,
    source: actor.body.motion,
    target: enemy.body.motion,
    trace: straight(actor.body.motion.position, actor.body.motion.position),
    targetTrace: straight(enemy.body.motion.position, enemy.body.motion.position),
    direction: aim.direction,
    offset: { x: 0, y: 0, z: 0 },
    rangeMm: definition.rangeMm,
    elapsedSteps: 0,
    stageDuration: undefined,
    staged: !!staged,
    rules: tx.context.battle.rules,
    budget: tx.context.budget,
  });
  const { contact } = result;
  if (staged && result.geometry) action.stages!.geometry = result.geometry;
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
}
function releaseAttached(
  _shape: AttackVariant<'melee' | 'arc' | 'radial'>,
  context: SpatialRelease,
) {
  const { tx, actor, action, ability, staged, launch, aim } = context;
  const step = tx.step,
    attacks = tx.next.melees;
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
}
function releaseProjectile(shape: AttackVariant<'projectile'>, context: SpatialRelease) {
  const { tx, actor, action, ability, staged, launch, aim } = context;
  const { step, journal, spawns } = tx;
  const { work } = tx.context;
  const bullets = tx.next.projectiles;

  const target = actor.mind.memory.observation?.enemy ?? actor.mind.memory.lastSeen;
  const projectile: ProjectileState = {
    id: `projectile.${staged?.id ?? action.id}`,
    ownerId: actorId(actor),
    ...(staged ? { stage: staged.contact, ...(staged.hit ? { hit: staged.hit } : {}) } : {}),
    ability,
    cause: launch.id,
    launchStep: step,
    position: bodyPoint(actor.body.motion, actor.body.motion.actor.character.body.muzzleOffset),
    velocity: mul(aim.direction, shape.speedMmPerSecond / 1000),
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
const releaseHandlers: AttackHandlers<ReleaseContext, void> = {
  direct: (_shape, { tx, actor, ability, staged, launch }) => {
    if (staged) tx.next.ledger.contact(staged.contact, staged.hit, actorId(actor), tx.step);
    tx.effects.push(
      ...effectsOf(actor, ability, actorId(actor), launch.id, tx.step, staged?.contact),
    );
  },
  hitscan: (shape, context) => spatial(shape, context, false, releaseRay),
  melee: (shape, context) => spatial(shape, context, true, releaseAttached),
  arc: (shape, context) => spatial(shape, context, true, releaseAttached),
  radial: (shape, context) => spatial(shape, context, true, releaseAttached),
  projectile: (shape, context) => spatial(shape, context, true, releaseProjectile),
};
export function releaseAttack(context: ReleaseContext) {
  const relocation = context.ability.definition.relocation;
  if (relocation) {
    queueRelocation(
      context.tx,
      context.actor,
      context.ability,
      context.launch.id,
      relocation,
      context.staged?.contact,
    );
    return;
  }
  matchAttack(context.ability.definition.attack, releaseHandlers, context);
}
