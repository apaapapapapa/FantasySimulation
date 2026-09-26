import {
  canonicalJson,
  compareIds,
  INTERFERENCE_LIMITS,
  InterferencesSchema,
  type Interference,
  type InterferenceCause,
} from '@fantasy/domain/spatial/execution';
import { UnresolvedRuleError } from '../rules/status.ts';
import { SpatialBudgetError } from '../world/physics.ts';
import type { EffectContext } from './effect-context.ts';

const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value)).length;
const unique = <T>(values: readonly T[]) =>
  [...new Map(values.map((v) => [canonicalJson(v), v])).entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([, v]) => v);
export function boundedInterferences(entries: Interference[]) {
  const check = (resource: keyof typeof INTERFERENCE_LIMITS, observed: number, cause: string) => {
    const limit = INTERFERENCE_LIMITS[resource];
    if (observed > limit)
      throw new SpatialBudgetError(`interference-${resource}`, undefined, {
        observed,
        limit,
        cause,
      });
  };
  check('entries', entries.length, entries[0]?.ruleId ?? 'interference.context');
  for (const entry of entries) {
    check('actors', entry.actors.length, entry.ruleId);
    check('causes', entry.causes.length, entry.ruleId);
    check('revisions', entry.revisions.length, entry.ruleId);
  }
  check('bytes', bytes(entries), entries[0]?.ruleId ?? 'interference.context');
  return InterferencesSchema.parse(entries);
}

/** Capture only the failing causal set while its provisional journal still exists. */
export function recordInterference(
  error: unknown,
  context: EffectContext,
  actorId?: string,
): never {
  if (!(error instanceof UnresolvedRuleError) || !context.battle.rules.interferenceDiagnostics)
    throw error;
  const { battle, journal, step } = context;
  const targetId = actorId ?? error.actorId;
  if (!targetId || !error.detail?.causes.length)
    throw new Error('Missing interference causal context');
  const point =
    context.interferencePoint ?? (context.phase === 'boundary' ? 'boundary' : 'status-commit');
  const actors = new Set([targetId]);
  const revisions: Interference['revisions'] = error.detail.statuses.map((r) => ({
    kind: 'status',
    id: r.id,
    revision: r.revision,
    contentHash: r.contentHash,
  }));
  const causes: InterferenceCause[] = [...new Set(error.detail.causes)].map((id) => {
    const event = journal.events.find((e) => e.id === id);
    if (!event) return { kind: 'event', eventId: id };
    if (event.actorId) actors.add(event.actorId);
    const ability = event.abilityId
      ? battle.actors
          .find((a) => a.participant.actorId === event.actorId)
          ?.abilities.find((a) => a.id === event.abilityId)
      : null;
    if (event.abilityId && !ability) throw new Error('Missing interference ability');
    const ref = ability
      ? { id: ability.id, revision: ability.revision, contentHash: ability.contentHash }
      : null;
    if (ref) revisions.push({ ...ref, kind: 'ability' });
    return {
      kind: 'attempt',
      step,
      point:
        event.reaction?.point ??
        (point === 'startup' ? 'startup' : event.phase === 'boundary' ? 'boundary' : 'contact'),
      wave: event.reaction?.wave ?? (event.phase === 'boundary' ? null : (event.wave ?? 0)),
      actorId: event.actorId,
      ability: ref,
      ordinal: journal.events.indexOf(event),
    };
  });
  error.interferences = boundedInterferences([
    {
      step,
      point,
      wave: null,
      actors: [...actors].sort(compareIds),
      causes: unique(causes),
      revisions: unique(revisions),
      ruleId: error.ruleId,
    },
  ]);
  throw error;
}
