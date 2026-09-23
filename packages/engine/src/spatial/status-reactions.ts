import {
  compareIds,
  type DeepReadonly,
  type Definition,
  type StatusReaction,
} from '@fantasy/domain/spatial';
import { permanentStatus } from './categories.ts';
import {
  UnresolvedRuleError,
  type StatusApplication,
  type StatusChange,
  type StatusCohort,
  type StatusRevision,
} from './status.ts';

type Status = DeepReadonly<Definition<'status'>>;
type DamageElement = StatusReaction['element'];
export type ElementContact = { id: string; element: DamageElement; legacyWater?: boolean };
/** An explicit response wins; legacy input is an adapter, never a second reaction. */
export function statusReactions(status: Status): readonly DeepReadonly<StatusReaction>[] {
  const reactions = status.reactions ?? [];
  return status.burning && !reactions.some((r) => r.element === 'water')
    ? [
        ...reactions,
        {
          element: 'water',
          response: { kind: status.burning.waterExtinguishable ? 'remove' : 'none' },
        },
      ]
    : reactions;
}
export function reactionDamageBps(
  statuses: readonly StatusCohort[],
  step: number,
  element: DamageElement,
) {
  return (
    10000 +
    statuses.reduce(
      (sum, s) =>
        sum +
        (s.startStep <= step && step < s.endStep
          ? ((statusReactions(s.revision.definition).find((r) => r.element === element)
              ?.damageTakenBps ?? 10000) -
              10000) *
            s.stacks
          : 0),
      0,
    )
  );
}
/** Plan against the old snapshot; newly transformed states never recurse into this contact. */
export function planStatusReactions(
  existing: readonly StatusCohort[],
  contacts: readonly ElementContact[],
  definitions: readonly StatusRevision[],
  step: number,
) {
  const statuses = existing.map((s) => ({ ...s, causes: [...s.causes] }));
  const dispels: StatusRevision[] = [],
    applications: StatusApplication[] = [],
    changes: StatusChange[] = [];
  const traces: {
    statusId: string;
    element: DamageElement;
    response: string;
    multiplier: number;
    causes: string[];
  }[] = [];
  const groups = new Map<StatusRevision, StatusCohort[]>();
  for (const s of statuses.filter((s) => s.startStep <= step && step < s.endStep)) {
    const key =
      [...groups.keys()].find(
        (r) =>
          r.id === s.revision.id &&
          r.revision === s.revision.revision &&
          r.contentHash === s.revision.contentHash,
      ) ?? s.revision;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [revision, cohorts] of [...groups].sort(
    ([a], [b]) => compareIds(a.id, b.id) || a.revision - b.revision,
  )) {
    const triggered = statusReactions(revision.definition).filter((r) =>
      contacts.some((c) => c.element === r.element),
    );
    if (!triggered.length) continue;
    const causes = [
      ...new Set(
        contacts.filter((c) => triggered.some((r) => r.element === c.element)).map((c) => c.id),
      ),
    ].sort(compareIds);
    const mutating = permanentStatus(revision.definition)
      ? triggered.filter((r) => r.response.kind !== 'remove' && r.response.kind !== 'transform')
      : triggered;
    for (const reaction of triggered) {
      const matches = contacts.filter((c) => c.element === reaction.element);
      if (
        !revision.definition.reactions?.some((r) => r.element === reaction.element) &&
        matches.every((c) => c.legacyWater)
      )
        continue;
      traces.push({
        statusId: revision.id,
        element: reaction.element,
        response: !mutating.includes(reaction) ? 'permanent-retained' : reaction.response.kind,
        multiplier: reaction.damageTakenBps ?? 10000,
        causes: [...new Set(matches.map((c) => c.id))].sort(compareIds),
      });
    }
    const remove = mutating.some((r) => r.response.kind === 'remove');
    const transforms = mutating.flatMap((r) =>
      r.response.kind === 'transform' ? [r.response.status] : [],
    );
    const destination = transforms[0];
    if (
      (remove && destination) ||
      transforms.some(
        (t) =>
          t.id !== destination!.id ||
          t.revision !== destination!.revision ||
          t.contentHash !== destination!.contentHash,
      )
    )
      throw new UnresolvedRuleError(
        'status.reaction-conflict',
        [revision.id, ...transforms.map((t) => t.id)],
        'Simultaneous reactions disagree about the resulting status',
      );
    if (remove || destination) dispels.push(revision);
    if (destination) {
      const replacement = definitions.find(
        (r) =>
          r.id === destination.id &&
          r.revision === destination.revision &&
          r.contentHash === destination.contentHash,
      );
      if (!replacement) throw new Error('Missing prepared reaction status reference');
      applications.push({ revision: replacement, cause: causes[0]!, causes });
    } else if (!remove) {
      const requested = mutating.reduce(
        (n, r) => n + (r.response.kind === 'strengthen' ? r.response.stacks : 0),
        0,
      );
      const added = Math.min(
        requested,
        Math.max(0, revision.definition.maxStacks - cohorts.reduce((n, s) => n + s.stacks, 0)),
      );
      if (added) {
        // Oldest cohort receives the added stacks; clocks are preserved independently of array order.
        const oldest = [...cohorts].sort((a, b) => a.startStep - b.startStep)[0]!;
        oldest.stacks += added;
        oldest.causes = [...new Set([...oldest.causes, ...causes])].sort(compareIds);
        changes.push({
          kind: 'refresh',
          revision,
          stacks: added,
          causes,
          reason: 'element-strengthen-preserve-period',
        });
      }
    }
  }
  return { statuses, dispels, applications, changes, traces };
}
