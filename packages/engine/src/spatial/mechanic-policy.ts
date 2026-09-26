import {
  closureMechanics,
  mechanicRegistry,
  interferenceCell,
  type Revision,
  type MechanicUse,
  type Definition,
  type MechanicId,
} from '@fantasy/domain/spatial/execution';
import { EngineInputError } from './execution-policy.ts';

export type MechanicEligibility =
  | { executable: true }
  | {
      executable: false;
      mechanic: MechanicId;
      owner: MechanicUse['owner'];
      reason: string;
    };
/** Pure admission, independent of runtime conditions, actors' knowledge and scheduling. */
export function mechanicEligibility(
  rules: Definition<'ruleset'>,
  uses: readonly MechanicUse[],
): MechanicEligibility {
  const allowed = new Set(rules.experimental?.mechanics ?? []);
  for (const use of uses) {
    const mechanic = mechanicRegistry.get(use.mechanic);
    const reason =
      !mechanic?.implemented || mechanic.class === 'reserved'
        ? 'mechanic is not implemented or is reserved'
        : (!mechanic.standardReady || mechanic.class === 'experimental') &&
            !allowed.has(use.mechanic)
          ? 'ruleset does not permit this experimental mechanic'
          : null;
    if (reason) return { executable: false, ...use, reason };
  }
  const distinct = [...new Map(uses.map((use) => [use.mechanic, use])).values()];
  for (const left of distinct)
    for (const right of distinct) {
      const cell = interferenceCell(left.mechanic, right.mechanic);
      const reject = cell.cases.find((c) => c.state === 'rejected');
      if (reject?.state === 'rejected')
        return { executable: false, ...left, reason: reject.reason };
    }
  return { executable: true };
}
export function requireMechanics(
  rules: Extract<Revision, { kind: 'ruleset' }>,
  closure: readonly Revision[],
) {
  for (const mechanic of rules.definition.experimental?.mechanics ?? [])
    if (mechanicRegistry.get(mechanic)?.class === 'reserved')
      throw new EngineInputError(
        'unsupported-mechanic',
        `Reserved mechanic ${mechanic}; ruleset ${rules.id}@${rules.revision} ${rules.contentHash}`,
        {
          mechanic,
          owner: {
            kind: rules.kind,
            id: rules.id,
            revision: rules.revision,
            contentHash: rules.contentHash,
          },
        },
      );
  const eligibility = mechanicEligibility(rules.definition, closureMechanics(closure));
  if (!eligibility.executable) {
    const { mechanic, owner, reason } = eligibility;
    throw new EngineInputError(
      'unsupported-mechanic',
      `${mechanic}: ${reason}; ${owner.kind} ${owner.id}@${owner.revision} ${owner.contentHash}`,
      { mechanic, owner },
    );
  }
}
