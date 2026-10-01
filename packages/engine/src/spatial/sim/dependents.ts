import { dependentSeed, nextRandom } from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, ActorState, DependentState } from '../state.ts';
import { capsulesOverlap } from '../rules/relocation.ts';
import { capsuleShape } from '../world/physics.ts';
import { bodyCapsule } from '../world/terrain.ts';
import type { StepTransaction } from './step-transaction.ts';
import { actorId } from './step-transaction.ts';
import { canSee } from '../world/visibility.ts';

const MAX_ACTIVE_PER_OWNER = 2;
const MAX_CREATED_PER_OWNER = 8;

const ownerSlot = (tx: StepTransaction, ownerId: string) =>
  tx.context.battle.manifest.participants.findIndex((p) => p.actorId === ownerId) === 0 ? 'a' : 'b';

function removeDependent(
  tx: StepTransaction,
  dependent: DependentState,
  reason: 'expired' | 'dismissed' | 'owner-defeated' | 'upkeep',
  step: number,
  phase: 'boundary' | 'resolution',
) {
  tx.next.dependents = (tx.next.dependents ?? []).filter((d) => d.id !== dependent.id);
  tx.dependentRemovals.set(dependent.id, reason);
  tx.journal.emit({
    kind: 'dependent-despawn',
    phase,
    step,
    actorId: dependent.ownerId,
    targetId: dependent.hostileOwnerId,
    entityId: dependent.id,
    abilityId: dependent.ability.id,
    ruleId: 'dependent.lifecycle',
    reason,
    dependent: {
      transition: 'despawn',
      ownerId: dependent.ownerId,
      hostileOwnerId: dependent.hostileOwnerId,
      ordinal: dependent.ordinal,
      reason,
    },
  });
}

export function summonDependent(
  tx: StepTransaction,
  owner: ActorState,
  ability: AbilityRevision,
  cause: string,
) {
  const spec = ability.definition.summon;
  if (!spec) throw new Error('Missing dependent specification');
  const ownerId = actorId(owner);
  const active = (tx.next.dependents ?? []).filter((d) => d.ownerId === ownerId);
  const ordinal = tx.next.dependentCreated?.[ownerId] ?? 0;
  if (active.length >= MAX_ACTIVE_PER_OWNER || ordinal >= MAX_CREATED_PER_OWNER) {
    tx.journal.emit({
      kind: 'fizzle',
      phase: 'launch',
      step: tx.step,
      actorId: ownerId,
      abilityId: ability.id,
      parentEventId: cause,
      ruleId: 'dependent.cap',
      reason:
        active.length >= MAX_ACTIVE_PER_OWNER ? 'active-dependent-cap' : 'created-dependent-cap',
    });
    return;
  }
  const hostile = tx.next.actors.find((actor) => actorId(actor) !== ownerId)!;
  const body = bodyCapsule(spec.body);
  const base = {
    x: owner.body.motion.position.x + spec.spawnOffsetMm.x / 1000,
    y: owner.body.motion.position.y + spec.spawnOffsetMm.y / 1000,
    z: owner.body.motion.position.z + spec.spawnOffsetMm.z / 1000,
  };
  const candidates = [
    base,
    { ...base, x: base.x + body.radius * 2 + 0.01 },
    { ...base, x: base.x - body.radius * 2 - 0.01 },
  ];
  const position = candidates.find(
    (candidate) =>
      !tx.context.world.forQuery({ ownerId }).overlaps(candidate, capsuleShape(body)) &&
      !tx.next.actors.some((actor) =>
        capsulesOverlap(
          candidate,
          body,
          actor.body.motion.position,
          bodyCapsule(actor.body.motion.actor.character.body),
        ),
      ) &&
      !(tx.next.dependents ?? []).some((d) =>
        capsulesOverlap(candidate, body, d.position, bodyCapsule(d.body)),
      ),
  );
  if (!position) {
    tx.journal.emit({
      kind: 'fizzle',
      phase: 'launch',
      step: tx.step,
      actorId: ownerId,
      abilityId: ability.id,
      parentEventId: cause,
      ruleId: 'dependent.spawn',
      reason: 'no-collision-free-bounded-spawn',
    });
    return;
  }
  const id = `dependent.${ownerSlot(tx, ownerId)}.${ordinal}.scout-rat`;
  const dependent: DependentState = {
    id,
    profile: spec.profile,
    ownerId,
    hostileOwnerId: actorId(hostile),
    ordinal,
    ability,
    position,
    body: spec.body,
    hp: spec.hp,
    maxHp: spec.hp,
    createdAt: tx.step,
    expiresAt: tx.step + spec.lifetimeSteps,
    nextActionAt: tx.step + spec.actionEverySteps,
    nextUpkeepAt: tx.step + spec.upkeep.everySteps,
    rngState: dependentSeed(
      tx.context.battle.manifest.seed,
      owner.body.motion.actor.participant.rngStream,
      ordinal,
      id,
      'policy-target',
    ),
  };
  (tx.next.dependents ??= []).push(dependent);
  (tx.next.dependentCreated ??= {})[ownerId] = ordinal + 1;
  tx.journal.emit({
    kind: 'dependent-create',
    phase: 'launch',
    step: tx.step,
    actorId: ownerId,
    targetId: dependent.hostileOwnerId,
    entityId: id,
    abilityId: ability.id,
    parentEventId: cause,
    ruleId: 'dependent.spawn',
    reason: 'bounded-collision-valid-dependent',
    dependent: {
      transition: 'create',
      ownerId,
      hostileOwnerId: dependent.hostileOwnerId,
      ordinal,
      nextActionAt: dependent.nextActionAt,
    },
  });
}

/** Advance global lifetime/upkeep and each dependent's own action clock at the boundary. */
export function advanceDependents(tx: StepTransaction) {
  const due = [...(tx.next.dependents ?? [])].sort(
    (a, b) =>
      a.nextActionAt - b.nextActionAt ||
      a.ownerId.localeCompare(b.ownerId) ||
      a.ordinal - b.ordinal,
  );
  for (const dependent of due) {
    if (tx.step >= dependent.expiresAt) {
      removeDependent(tx, dependent, 'expired', tx.step, 'boundary');
      continue;
    }
    const owner = tx.next.actors.find((actor) => actorId(actor) === dependent.ownerId)!;
    if (tx.step >= dependent.nextUpkeepAt) {
      const mp = owner.vitals.resources.mp;
      if (mp < dependent.ability.definition.summon!.upkeep.mp) {
        removeDependent(tx, dependent, 'upkeep', tx.step, 'boundary');
        continue;
      }
      owner.vitals.resources.mp -= dependent.ability.definition.summon!.upkeep.mp;
      dependent.nextUpkeepAt += dependent.ability.definition.summon!.upkeep.everySteps;
      tx.journal.emit({
        kind: 'cost',
        phase: 'boundary',
        step: tx.step,
        actorId: dependent.ownerId,
        targetId: dependent.hostileOwnerId,
        entityId: dependent.id,
        abilityId: dependent.ability.id,
        before: { ...owner.vitals.resources, mp },
        after: { ...owner.vitals.resources },
        ruleId: 'dependent.upkeep',
        reason: 'global-lifetime-upkeep',
      });
    }
    const clockFrozen =
      dependent.clock &&
      dependent.clock.frozenFrom <= tx.step &&
      tx.step < dependent.clock.frozenUntil;
    if (
      clockFrozen ||
      tx.step < dependent.nextActionAt ||
      !(tx.next.dependents ?? []).some((d) => d.id === dependent.id)
    )
      continue;
    const spec = dependent.ability.definition.summon!;
    const observation = owner.mind.memory.observation;
    const observed =
      observation?.availableAt !== undefined &&
      observation.availableAt <= tx.step &&
      observation.enemy?.id === dependent.hostileOwnerId;
    if (
      !observed ||
      owner.vitals.resources.hp === 0 ||
      owner.vitals.resources.mp < spec.commandCostMp
    ) {
      dependent.nextActionAt += spec.actionEverySteps;
      continue;
    }
    const hostileCandidate = (tx.next.dependents ?? [])
      .filter(
        (candidate) =>
          candidate.ownerId === dependent.hostileOwnerId &&
          candidate.hostileOwnerId === dependent.ownerId &&
          candidate.hp > 0 &&
          canSee(tx.context.world, owner.body.motion, {
            x: candidate.position.x,
            y: candidate.position.y + candidate.body.heightMm / 2000,
            z: candidate.position.z,
          }),
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const policyRoll = nextRandom(dependent.rngState);
    const hostileDependent = policyRoll & 1 ? hostileCandidate : undefined;
    const targetId = hostileDependent?.id ?? dependent.hostileOwnerId;
    const before = { ...owner.vitals.resources };
    owner.vitals.resources.mp -= spec.commandCostMp;
    const command = tx.journal.emit({
      kind: 'dependent-command',
      phase: 'boundary',
      step: tx.step,
      actorId: dependent.ownerId,
      targetId: dependent.hostileOwnerId,
      entityId: dependent.id,
      abilityId: dependent.ability.id,
      before,
      after: { ...owner.vitals.resources },
      ruleId: 'dependent.observed-command',
      reason: 'owner-delivered-enemy-observation',
      dependent: {
        transition: 'command',
        ownerId: dependent.ownerId,
        hostileOwnerId: dependent.hostileOwnerId,
        ordinal: dependent.ordinal,
        nextActionAt: dependent.nextActionAt,
      },
    });
    dependent.rngState = policyRoll;
    dependent.nextActionAt += spec.actionEverySteps;
    const act = tx.journal.emit({
      kind: 'dependent-act',
      phase: 'boundary',
      step: tx.step,
      actorId: dependent.ownerId,
      targetId: dependent.hostileOwnerId,
      entityId: dependent.id,
      abilityId: dependent.ability.id,
      parentEventId: command.id,
      ruleId: 'dependent.subject-clock',
      reason: hostileDependent
        ? 'stable-ordinal-visible-hostile-dependent'
        : 'stable-ordinal-policy',
      dependent: {
        transition: 'act',
        ownerId: dependent.ownerId,
        hostileOwnerId: dependent.hostileOwnerId,
        ordinal: dependent.ordinal,
        nextActionAt: dependent.nextActionAt,
      },
    });
    tx.effects.push({
      actorId: dependent.ownerId,
      targetId,
      effect: {
        kind: 'damage',
        amount: spec.damage.amount,
        attackScaleBps: 0,
        element: 'physical',
        drainBps: spec.damage.drainBps,
      },
      attack: 0,
      parentEventId: act.id,
      abilityId: dependent.ability.id,
      sourceDependentId: dependent.id,
      drainRecipientId: dependent.id,
    });
  }
}

/** A control feature freezes only the action clock; lifetime and upkeep remain global. */
export function freezeDependent(
  dependent: DependentState,
  controlId: string,
  frozenFrom: number,
  frozenUntil: number,
) {
  if (dependent.clock || frozenFrom >= frozenUntil)
    throw new Error('Invalid dependent clock freeze');
  dependent.clock = { controlId, frozenFrom, frozenUntil };
}

/** Rebase only the dependent's subject-action deadline; lifetime and upkeep stay global. */
export function thawDependent(dependent: DependentState, controlId: string, global: number) {
  const clock = dependent.clock;
  if (!clock || clock.controlId !== controlId) return;
  dependent.nextActionAt += global - clock.frozenFrom;
  delete dependent.clock;
}

/** Called only after before-defeat revival has committed. */
export function settleDefeatedDependents(
  tx: StepTransaction,
  activationStep: number,
  phase: 'boundary' | 'resolution',
) {
  for (const dependent of [...(tx.next.dependents ?? [])]) {
    const owner = tx.next.actors.find((actor) => actorId(actor) === dependent.ownerId)!;
    if (owner.vitals.resources.hp === 0)
      removeDependent(tx, dependent, 'owner-defeated', activationStep, phase);
  }
}
