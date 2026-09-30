import type { ReplayContext } from './context.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import type { DependentChanges, DependentDisplay, DisplayState, StreamRecord } from '../stream.ts';
import { requireReplay, same } from './common.ts';

const ownerAbility = (context: ReplayContext, dependent: DependentDisplay) =>
  context.actors
    .find((actor) => actor.participant.actorId === dependent.ownerId)
    ?.abilities.find((ability) => ability.id === dependent.abilityId);

export function validateDependent(
  context: ReplayContext,
  dependent: DependentDisplay,
  step: number,
) {
  const ability = ownerAbility(context, dependent);
  const spec = ability?.definition.summon;
  requireReplay(
    !!spec &&
      dependent.ownerId !== dependent.hostileOwnerId &&
      context.actors.some((actor) => actor.participant.actorId === dependent.hostileOwnerId) &&
      spec.profile === dependent.profile &&
      same(spec.body, dependent.body) &&
      spec.hp === dependent.maxHp &&
      dependent.hp <= dependent.maxHp &&
      dependent.createdAt <= step &&
      step <= dependent.expiresAt &&
      dependent.expiresAt === dependent.createdAt + spec.lifetimeSteps &&
      dependent.nextActionAt >= dependent.createdAt + spec.actionEverySteps &&
      dependent.nextUpkeepAt >= dependent.createdAt + spec.upkeep.everySteps &&
      dependent.id ===
        `dependent.${context.manifest.participants.findIndex((p) => p.actorId === dependent.ownerId) === 0 ? 'a' : 'b'}.${dependent.ordinal}.scout-rat` &&
      (!dependent.clock ||
        (dependent.clock.frozenFrom <= step &&
          dependent.clock.frozenFrom < dependent.clock.frozenUntil)),
    'dependent definition/identity/window',
  );
}

export function applyDependents(
  context: ReplayContext,
  prior: ReplayCheckpoint,
  state: DisplayState,
  changes: DependentChanges,
  record: Exclude<StreamRecord, { kind: 'initial' | 'terminal' }>,
  entities: Set<string>,
) {
  const dependents = (state.dependents ??= []);
  const priorDependents = prior.state?.dependents ?? [];
  requireReplay(
    new Set(changes.spawn.map((d) => d.id)).size === changes.spawn.length &&
      new Set(changes.update.map((d) => d.id)).size === changes.update.length &&
      new Set(changes.remove.map((d) => d.id)).size === changes.remove.length,
    'duplicate dependent transition',
  );
  for (const dependent of changes.spawn) {
    requireReplay(!entities.has(dependent.id), 'dependent spawn identity');
    validateDependent(context, dependent, record.kind === 'interval' ? record.toStep : record.step);
    const event = record.events.find(
      (candidate) => candidate.kind === 'dependent-create' && candidate.entityId === dependent.id,
    );
    requireReplay(
      event?.actorId === dependent.ownerId &&
        event.targetId === dependent.hostileOwnerId &&
        event.abilityId === dependent.abilityId &&
        event.dependent?.ordinal === dependent.ordinal &&
        event.dependent.nextActionAt === dependent.nextActionAt,
      'dependent create event binding',
    );
    entities.add(dependent.id);
    dependents.push(dependent);
  }
  for (const dependent of changes.update) {
    const index = dependents.findIndex((candidate) => candidate.id === dependent.id);
    const before = dependents[index];
    requireReplay(
      !!before &&
        same(
          {
            id: before.id,
            profile: before.profile,
            ownerId: before.ownerId,
            hostileOwnerId: before.hostileOwnerId,
            abilityId: before.abilityId,
            ordinal: before.ordinal,
            position: before.position,
            body: before.body,
            maxHp: before.maxHp,
            createdAt: before.createdAt,
            expiresAt: before.expiresAt,
          },
          {
            id: dependent.id,
            profile: dependent.profile,
            ownerId: dependent.ownerId,
            hostileOwnerId: dependent.hostileOwnerId,
            abilityId: dependent.abilityId,
            ordinal: dependent.ordinal,
            position: dependent.position,
            body: dependent.body,
            maxHp: dependent.maxHp,
            createdAt: dependent.createdAt,
            expiresAt: dependent.expiresAt,
          },
        ) &&
        dependent.nextActionAt >= before.nextActionAt &&
        dependent.nextUpkeepAt >= before.nextUpkeepAt,
      'dependent immutable/update contract',
    );
    validateDependent(context, dependent, record.kind === 'interval' ? record.toStep : record.step);
    dependents[index] = dependent;
  }
  for (const removal of changes.remove) {
    const existing = priorDependents.find((dependent) => dependent.id === removal.id);
    const event = record.events.find(
      (candidate) => candidate.kind === 'dependent-despawn' && candidate.entityId === removal.id,
    );
    requireReplay(
      !!existing &&
        event?.actorId === existing.ownerId &&
        event.targetId === existing.hostileOwnerId &&
        event.dependent?.reason === removal.reason,
      'dependent removal event binding',
    );
    state.dependents = state.dependents!.filter((dependent) => dependent.id !== removal.id);
  }
  for (const event of record.events.filter((candidate) => candidate.dependent)) {
    const dependent = [...priorDependents, ...(state.dependents ?? [])].find(
      (candidate) => candidate.id === event.entityId,
    );
    requireReplay(
      !!dependent &&
        event.actorId === dependent.ownerId &&
        event.targetId === dependent.hostileOwnerId &&
        event.abilityId === dependent.abilityId &&
        event.dependent?.ordinal === dependent.ordinal,
      'dependent event provenance',
    );
  }
  for (const event of record.events.filter(
    (candidate) => candidate.kind === 'damage' && candidate.entityId,
  )) {
    const dependent = [...priorDependents, ...(state.dependents ?? [])].find(
      (candidate) => candidate.id === event.entityId,
    );
    requireReplay(
      !!dependent &&
        event.actorId === dependent.ownerId &&
        event.targetId === dependent.hostileOwnerId,
      'dependent damage provenance',
    );
  }
}
