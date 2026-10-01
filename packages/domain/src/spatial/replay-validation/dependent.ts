import type { ReplayContext } from './context.ts';
import type { ReplayCheckpoint } from '../replay.ts';
import type { DependentChanges, DependentDisplay, DisplayState, StreamRecord } from '../stream.ts';
import { requireReplay, same } from './common.ts';
import { dependentSeed, nextRandom } from '../random.ts';

const ownerAbility = (context: ReplayContext, dependent: DependentDisplay) =>
  context.actors
    .find((actor) => actor.participant.actorId === dependent.ownerId)
    ?.abilities.find((ability) => ability.id === dependent.abilityId);

const transitionStep = (record: Exclude<StreamRecord, { kind: 'initial' | 'terminal' }>) =>
  record.kind === 'interval' ? record.toStep : record.step;

const ownerStream = (context: ReplayContext, dependent: DependentDisplay) =>
  context.manifest.participants.find((participant) => participant.actorId === dependent.ownerId)
    ?.rngStream;

export function validateDependent(
  context: ReplayContext,
  dependent: DependentDisplay,
  step: number,
) {
  const ability = ownerAbility(context, dependent);
  const spec = ability?.definition.summon;
  const ownerIndex = context.manifest.participants.findIndex(
    (participant) => participant.actorId === dependent.ownerId,
  );
  requireReplay(
    !!spec &&
      ownerIndex >= 0 &&
      dependent.ownerId !== dependent.hostileOwnerId &&
      context.manifest.participants[ownerIndex === 0 ? 1 : 0]?.actorId ===
        dependent.hostileOwnerId &&
      spec.profile === dependent.profile &&
      same(spec.body, dependent.body) &&
      spec.hp === dependent.maxHp &&
      dependent.hp <= dependent.maxHp &&
      dependent.createdAt <= step &&
      step <= dependent.expiresAt &&
      dependent.expiresAt === dependent.createdAt + spec.lifetimeSteps &&
      dependent.nextActionAt >= dependent.createdAt + spec.actionEverySteps &&
      dependent.nextUpkeepAt >= dependent.createdAt + spec.upkeep.everySteps &&
      dependent.id === `dependent.${ownerIndex === 0 ? 'a' : 'b'}.${dependent.ordinal}.scout-rat` &&
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
  const resourceEvents = record.events.filter(
    (event) => event.kind === 'dependent-command' || event.ruleId === 'dependent.upkeep',
  );
  const resourcesBefore = (ownerId: string, sequence: number) => {
    let resources = prior.state?.actors.find((actor) => actor.id === ownerId)?.resources;
    for (const event of resourceEvents) {
      if (event.sequence >= sequence || event.actorId !== ownerId) continue;
      resources = event.after ?? resources;
    }
    return resources;
  };
  for (const event of resourceEvents)
    requireReplay(
      !!event.before &&
        !!event.after &&
        event.actorId !== null &&
        same(event.before, resourcesBefore(event.actorId, event.sequence)),
      'dependent owner resource chain',
    );
  for (const ownerId of new Set(resourceEvents.flatMap((event) => event.actorId ?? []))) {
    const final = resourceEvents.findLast((event) => event.actorId === ownerId);
    const followedByOwnerResourceEvent = record.events.some(
      (event) =>
        !!final &&
        event.sequence > final.sequence &&
        !!event.after &&
        (event.actorId === ownerId || event.targetId === ownerId),
    );
    if (!followedByOwnerResourceEvent) {
      const delta = record.changes.find((change) => change.id === ownerId);
      const recorded =
        delta?.resources ?? prior.state?.actors.find((actor) => actor.id === ownerId)?.resources;
      requireReplay(
        !!final?.after && same(final.after, recorded),
        'dependent owner resource result',
      );
    }
  }
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
    const spec = ownerAbility(context, dependent)?.definition.summon;
    const stream = ownerStream(context, dependent);
    requireReplay(
      !!spec &&
        stream !== undefined &&
        event?.actorId === dependent.ownerId &&
        event.targetId === dependent.hostileOwnerId &&
        event.abilityId === dependent.abilityId &&
        event.step === dependent.createdAt &&
        event.phase === 'launch' &&
        event.ruleId === 'dependent.spawn' &&
        event.dependent?.ordinal === dependent.ordinal &&
        event.dependent.nextActionAt === dependent.nextActionAt &&
        dependent.hp === dependent.maxHp &&
        dependent.nextActionAt === dependent.createdAt + spec.actionEverySteps &&
        dependent.nextUpkeepAt === dependent.createdAt + spec.upkeep.everySteps &&
        dependent.rngState ===
          dependentSeed(
            context.manifest.seed,
            stream,
            dependent.ordinal,
            dependent.id,
            'policy-target',
          ) &&
        !dependent.clock,
      'dependent create event binding',
    );
    entities.add(dependent.id);
    dependents.push(dependent);
  }
  for (const dependent of changes.update) {
    const index = dependents.findIndex((candidate) => candidate.id === dependent.id);
    const before = dependents[index];
    const spec = ownerAbility(context, dependent)?.definition.summon;
    if (!before || !spec) {
      requireReplay(false, 'dependent update reference/definition');
      continue;
    }
    requireReplay(
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
      ),
      'dependent immutable/update contract',
    );
    const step = transitionStep(record);
    const ownEvents = record.events.filter((event) => event.entityId === dependent.id);
    const activations = record.events.filter(
      (event) => event.timeStop?.state === 'activated' && event.targetId === dependent.ownerId,
    );
    const releases = record.events.filter(
      (event) =>
        event.timeStop?.state === 'release' && event.timeStop.controlId === before.clock?.controlId,
    );
    requireReplay(activations.length <= 1 && releases.length <= 1, 'dependent clock control count');
    let expectedClock = before.clock ? { ...before.clock } : undefined;
    let expectedActionAt = before.nextActionAt;
    if (before.clock && releases.length === 1) {
      expectedActionAt += releases[0]!.step - before.clock.frozenFrom;
      expectedClock = undefined;
    }
    if (!before.clock && activations.length === 1) {
      const activation = activations[0]!;
      expectedClock = {
        controlId: activation.timeStop!.controlId,
        frozenFrom: activation.step,
        frozenUntil: activation.step + activation.timeStop!.durationSteps,
      };
    }
    const frozenAtBoundary =
      !!before.clock &&
      releases.length === 0 &&
      before.clock.frozenFrom <= step &&
      step < before.clock.frozenUntil;
    const due = record.kind === 'boundary' && step >= expectedActionAt && !frozenAtBoundary;
    const commands = ownEvents.filter((event) => event.kind === 'dependent-command');
    const acts = ownEvents.filter((event) => event.kind === 'dependent-act');
    requireReplay(
      commands.length <= 1 && acts.length === commands.length && (!commands.length || due),
      'dependent command/act count',
    );
    let expectedRng = before.rngState;
    if (commands.length) {
      const command = commands[0]!;
      const act = acts[0]!;
      requireReplay(
        command.step === step &&
          command.step === expectedActionAt &&
          command.phase === 'boundary' &&
          command.ruleId === 'dependent.observed-command' &&
          command.reason === 'owner-delivered-enemy-observation' &&
          command.dependent?.nextActionAt === expectedActionAt &&
          !!command.before &&
          !!command.after &&
          same(command.before, resourcesBefore(dependent.ownerId, command.sequence)) &&
          command.before.mp - command.after.mp === spec!.commandCostMp &&
          command.before.hp === command.after.hp &&
          command.before.shield === command.after.shield &&
          command.before.stamina === command.after.stamina &&
          act.step === command.step &&
          act.phase === 'boundary' &&
          act.parentEventId === command.id &&
          act.ruleId === 'dependent.subject-clock' &&
          act.reason === 'stable-ordinal-policy' &&
          act.dependent?.nextActionAt === expectedActionAt + spec!.actionEverySteps,
        'dependent observed command timing',
      );
      expectedRng = nextRandom(expectedRng);
    }
    if (due) expectedActionAt += spec!.actionEverySteps;

    const upkeep = ownEvents.filter((event) => event.ruleId === 'dependent.upkeep');
    requireReplay(upkeep.length <= 1, 'dependent upkeep count');
    let expectedUpkeepAt = before.nextUpkeepAt;
    if (upkeep.length) {
      const cost = upkeep[0]!;
      requireReplay(
        record.kind === 'boundary' &&
          step >= expectedUpkeepAt &&
          cost.kind === 'cost' &&
          cost.step === step &&
          cost.phase === 'boundary' &&
          cost.actorId === dependent.ownerId &&
          cost.targetId === dependent.hostileOwnerId &&
          cost.abilityId === dependent.abilityId &&
          !!cost.before &&
          !!cost.after &&
          same(cost.before, resourcesBefore(dependent.ownerId, cost.sequence)) &&
          cost.before.mp - cost.after.mp === spec!.upkeep.mp &&
          cost.before.hp === cost.after.hp &&
          cost.before.shield === cost.after.shield &&
          cost.before.stamina === cost.after.stamina,
        'dependent upkeep timing/cost',
      );
      expectedUpkeepAt += spec!.upkeep.everySteps;
    }

    const heals = ownEvents.filter(
      (event) => event.kind === 'heal' && event.reason === 'same-wave-hp-loss-dependent-drain',
    );
    const expectedHp = Math.min(
      before.maxHp,
      before.hp + heals.reduce((total, event) => total + (event.amount ?? 0), 0),
    );
    requireReplay(
      dependent.hp === expectedHp &&
        dependent.rngState === expectedRng &&
        dependent.nextActionAt === expectedActionAt &&
        dependent.nextUpkeepAt === expectedUpkeepAt &&
        ((!dependent.clock && !expectedClock) ||
          (!!dependent.clock && !!expectedClock && same(dependent.clock, expectedClock))),
      'dependent mutable update contract',
    );
    validateDependent(context, dependent, record.kind === 'interval' ? record.toStep : record.step);
    dependents[index] = dependent;
  }
  for (const removal of changes.remove) {
    const existing = priorDependents.find((dependent) => dependent.id === removal.id);
    const event = record.events.find(
      (candidate) => candidate.kind === 'dependent-despawn' && candidate.entityId === removal.id,
    );
    const step = transitionStep(record);
    const spec = existing && ownerAbility(context, existing)?.definition.summon;
    const owner = existing && prior.state?.actors.find((actor) => actor.id === existing.ownerId);
    const ownerDelta = existing && record.changes.find((change) => change.id === existing.ownerId);
    const common =
      !!existing &&
      !!spec &&
      event?.actorId === existing.ownerId &&
      event.targetId === existing.hostileOwnerId &&
      event.abilityId === existing.abilityId &&
      event.entityId === existing.id &&
      event.ruleId === 'dependent.lifecycle' &&
      event.reason === removal.reason &&
      event.dependent?.reason === removal.reason &&
      event.step === step;
    const reasonValid =
      removal.reason === 'expired'
        ? event?.phase === 'boundary' && step === existing!.expiresAt
        : removal.reason === 'upkeep'
          ? event?.phase === 'boundary' &&
            step >= existing!.nextUpkeepAt &&
            (resourcesBefore(existing!.ownerId, event.sequence)?.mp ?? Number.MAX_SAFE_INTEGER) <
              spec!.upkeep.mp
          : removal.reason === 'owner-defeated'
            ? event?.phase === (record.kind === 'boundary' ? 'boundary' : 'resolution') &&
              (owner?.resources.hp === 0 || ownerDelta?.resources?.hp === 0)
            : false;
    requireReplay(common && reasonValid, 'dependent removal event binding');
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
    (candidate) => candidate.kind === 'dependent-command' || candidate.kind === 'dependent-act',
  ))
    requireReplay(
      changes.update.some((dependent) => dependent.id === event.entityId),
      'dependent event state transition',
    );
  for (const event of record.events.filter(
    (candidate) => candidate.kind === 'damage' && candidate.entityId,
  )) {
    const dependent = [...priorDependents, ...(state.dependents ?? [])].find(
      (candidate) => candidate.id === event.entityId,
    );
    requireReplay(
      !!dependent &&
        event.actorId === dependent.ownerId &&
        event.targetId === dependent.hostileOwnerId &&
        event.abilityId === dependent.abilityId &&
        event.parentEventId !== null &&
        record.events.some(
          (candidate) =>
            candidate.id === event.parentEventId &&
            candidate.kind === 'dependent-act' &&
            candidate.entityId === dependent.id,
        ) &&
        event.damage?.calculation?.basePower ===
          ownerAbility(context, dependent)?.definition.summon?.damage.amount,
      'dependent damage provenance',
    );
  }
}
