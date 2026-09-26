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
  tests: readonly CapabilityTest[];
};
export type CapabilityTest = { path: string; name: string };
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

function effect(
  kind: Effect['kind'],
  test: string,
  name: string,
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
    tests: [{ path: test.startsWith('scripts/') ? test : engine + test, name }],
  };
}
function attack(
  kind: Definition<'ability'>['attack']['kind'],
  test: string,
  name: string,
): CapabilityCoverage {
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
    tests: [{ path: engine + test, name }],
  };
}

/** An ownership contract, not a claim that a function's existence proves its behavior.
 * Saved events/resources and the common replay viewer are the current display contract;
 * bespoke visual effects need their own assertions, not a new unconditional exemption.
 */
export const CAPABILITY_COVERAGE = {
  'effect:damage': effect(
    'damage',
    'effects.test.ts',
    'applies defense, resistance and a shared shield without allocating remainders by order',
  ),
  'effect:heal': effect(
    'heal',
    'effects.test.ts',
    'aggregates healing and damage before clamping, including HP already spent as a legal self-cost',
  ),
  'effect:shield': effect(
    'shield',
    'effects.test.ts',
    'combines shields granted in the same interval and preserves simultaneous lethal effects',
  ),
  'effect:apply-status': effect(
    'apply-status',
    'effects.test.ts',
    'activates new status modifiers at the next boundary and resolves simultaneous dispel against existing cohorts only',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
    true,
  ),
  'effect:dispel': effect(
    'dispel',
    'effects.test.ts',
    'dispels existing statuses by listed ID or shared category and keeps uncategorized ones',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
    true,
  ),
  'effect:water': effect(
    'water',
    'effects.test.ts',
    'water removes only existing extinguishable burning while simultaneous new burning remains',
    owner(engine + 'rules/status-reactions.ts', 'planStatusEffects'),
  ),
  'effect:reveal': effect(
    'reveal',
    'knowledge.test.ts',
    'reveals one permitted field only on activation, with ward, occlusion, delay and expiry',
    owner(engine + 'sim/combat-effects.ts', 'commitEffects'),
  ),
  'effect:force': effect(
    'force',
    'scripts/quality/capability-flow.test.ts',
    'connects an authored effect through simulation, durable storage, replay and visible diagnostics',
    owner(engine + 'sim/combat-effects.ts', 'commitEffects'),
  ),
  'attack:direct': attack(
    'direct',
    'simulate.test.ts',
    'allows an immediate committed heal to offset an HP cost that consumed the last HP',
  ),
  'attack:melee': attack(
    'melee',
    'attacks.test.ts',
    'detects a moving target crossing a thrust between endpoints and retains every body slide segment',
  ),
  'attack:hitscan': attack(
    'hitscan',
    'attacks.test.ts',
    'stops an instantaneous thick shot at a thin transparent wall before the target',
  ),
  'attack:projectile': attack(
    'projectile',
    'projectiles.test.ts',
    'hits once per projectile at high speed and records spawn, clipped path, impact and removal',
  ),
  'attack:arc': attack(
    'arc',
    'blades.test.ts',
    'hits an interior shaft crossing that neither endpoint nor the tip path touches',
  ),
  'attack:radial': attack(
    'radial',
    'blades.test.ts',
    'executes a staged radial sweep once per target and restores recorded blade geometry',
  ),
} satisfies Record<CapabilityId, CapabilityCoverage>;
