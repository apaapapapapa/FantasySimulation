import type { Effect, Definition } from '@fantasy/domain/spatial';

export const CAPABILITY_ROLES = [
  'resolution',
  'assessment',
  'observation',
  'replay',
  'display',
] as const;
export type CapabilityRole = (typeof CAPABILITY_ROLES)[number];
export type CapabilityOwner = { path: string; symbol: string; member?: string };
export type CapabilityResponsibility =
  | { status: 'implemented'; owner: CapabilityOwner }
  | {
      status: 'delegated';
      owner: CapabilityOwner;
      delegate: CapabilityOwner;
      reason: string;
    }
  | { status: 'unsupported'; reason: string };
export type CapabilityCoverage = {
  roles: Record<CapabilityRole, CapabilityResponsibility>;
  tests: readonly string[];
};
type CapabilityId =
  | `effect:${Effect['kind']}`
  | `attack:${Definition<'ability'>['attack']['kind']}`;
const engine = 'packages/engine/src/spatial/';
const owner = (path: string, symbol: string, member?: string): CapabilityOwner => ({
  path,
  symbol,
  ...(member === undefined ? {} : { member }),
});
const implemented = (at: CapabilityOwner): CapabilityResponsibility => ({
  status: 'implemented',
  owner: at,
});
const delegated = (
  at: CapabilityOwner,
  to: CapabilityOwner,
  reason: string,
): CapabilityResponsibility => ({ status: 'delegated', owner: at, delegate: to, reason });
const replay = owner('packages/domain/src/spatial/replay-validation/event.ts', 'validateEvents');
const display = owner('apps/web/src/replay/EventEntries.tsx', 'EventEntries');
const observation = owner(engine + 'ai/perception.ts', 'perceive');
const flow = 'scripts/quality/capability-flow.test.ts';

function effect(
  kind: Effect['kind'],
  test: string,
  deferred?: CapabilityOwner,
  assessedTogether = false,
): CapabilityCoverage {
  const resolveAt = owner(engine + 'rules/effects.ts', 'effectHandlers', kind);
  const assessAt = owner(engine + 'ai/assessment.ts', 'effectAssessments', kind);
  return {
    roles: {
      resolution: deferred
        ? delegated(resolveAt, deferred, 'Resolved at the shared transaction/observation boundary')
        : implemented(resolveAt),
      assessment: assessedTogether
        ? delegated(
            assessAt,
            owner(engine + 'ai/status-assessment.ts', 'assessStatusEffects'),
            'Status effects are evaluated together, not counted twice',
          )
        : implemented(assessAt),
      observation: implemented(observation),
      replay: implemented(replay),
      display: implemented(display),
    },
    tests: [engine + test, 'apps/api/src/replay/replay-storage.test.ts', flow],
  };
}
function attack(kind: Definition<'ability'>['attack']['kind'], test: string): CapabilityCoverage {
  const assessAt = owner(engine + 'ai/shape-assessment.ts', 'shapeHandlers', kind);
  return {
    roles: {
      resolution: implemented(owner(engine + 'sim/attack-release.ts', 'releaseHandlers', kind)),
      assessment:
        kind === 'arc' || kind === 'radial'
          ? implemented(assessAt)
          : delegated(
              assessAt,
              owner(engine + 'ai/assessment.ts', 'assessAbility'),
              'Unit shape multiplier; ordinary range/motion/utility remain in the common assessor',
            ),
      observation: implemented(observation),
      replay: implemented(replay),
      display: implemented(display),
    },
    tests: [engine + test, 'e2e/static/viewer.spec.ts', flow],
  };
}

/** An ownership contract, not a claim that a function's existence proves its behavior.
 * Saved events/resources and the common replay viewer are the current display contract;
 * bespoke visual effects need their own assertions, not a new unconditional exemption.
 */
export const CAPABILITY_COVERAGE = {
  'effect:damage': effect('damage', 'damage-integration.test.ts'),
  'effect:heal': effect('heal', 'effects.test.ts'),
  'effect:shield': effect('shield', 'effects.test.ts'),
  'effect:apply-status': effect(
    'apply-status',
    'status-integration.test.ts',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
    true,
  ),
  'effect:dispel': effect(
    'dispel',
    'status-generalization.test.ts',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
    true,
  ),
  'effect:water': effect(
    'water',
    'status-integration.test.ts',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
  ),
  'effect:reveal': effect(
    'reveal',
    'knowledge.test.ts',
    owner(engine + 'sim/combat-effects.ts', 'commitEffects'),
  ),
  'effect:force': effect(
    'force',
    'forced-movement.test.ts',
    owner(engine + 'sim/combat-effects.ts', 'commitEffects'),
  ),
  'attack:direct': attack('direct', 'effects.test.ts'),
  'attack:melee': attack('melee', 'attacks.test.ts'),
  'attack:hitscan': attack('hitscan', 'attacks.test.ts'),
  'attack:projectile': attack('projectile', 'projectiles.test.ts'),
  'attack:arc': attack('arc', 'blades.test.ts'),
  'attack:radial': attack('radial', 'blades.test.ts'),
} satisfies Record<CapabilityId, CapabilityCoverage>;
