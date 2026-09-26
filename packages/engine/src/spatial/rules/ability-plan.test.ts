import { expect, it } from 'vite-plus/test';
import { sampleManifest } from '@fantasy/samples';
import { abilityEffects, RevisionSchema } from '@fantasy/domain/spatial';
import { prepareBattle } from '../prepare.ts';
import { abilityPlan, prepareAbility, authoredStages } from './ability-plan.ts';

async function singleAbility() {
  const manifest = await sampleManifest();
  return manifest.revisions.find((r) => r.kind === 'ability')!;
}

it('normalizes a single attack without authoring stages or changing its saved definition', async () => {
  const source = await singleAbility();
  const saved = structuredClone(source);
  const prepared = prepareAbility(source);
  expect(source).toEqual(saved);
  expect(prepared.definition).toEqual(source.definition);
  expect(prepared.execution.kind).toBe('single');
  expect(prepared.execution.stages).toHaveLength(1);
  expect(prepared.execution.effects).toEqual(source.definition.effects);
  expect(Object.isFrozen(prepared.execution)).toBe(true);
  expect(prepared.definition).not.toBe(source.definition);
  expect(abilityPlan(prepared)).toBe(prepared.execution);
  expect(() => authoredStages(prepared)).toThrow('authored stage');
  expect(RevisionSchema.safeParse(prepared).success).toBe(false);
});

it('preserves authored clocks, cost presence and first-stage effect multiplicity', async () => {
  const source = await singleAbility();
  const first = {
    id: 'first',
    offsetSteps: 0,
    durationSteps: 1,
    attack: source.definition.attack,
    effects: source.definition.effects,
  };
  source.definition.stages = [
    first,
    { ...first, id: 'second', offsetSteps: 7, cost: { hp: 0, mp: 0 } },
  ];
  const prepared = prepareAbility(source);
  expect(prepared.execution.kind).toBe('staged');
  expect(authoredStages(prepared)).toEqual(source.definition.stages);
  expect(authoredStages(prepared)[0]!.cost).toBeUndefined();
  expect(authoredStages(prepared)[1]!.cost).toEqual({ hp: 0, mp: 0 });
  expect(prepared.execution.effects).toEqual(abilityEffects(source.definition));
  expect(prepared.execution.effects.length).toBe(2 * source.definition.effects.length);
});

it('does not reuse an execution plan after projecting a different stage definition', async () => {
  const source = await singleAbility();
  const prepared = prepareAbility(source);
  const projected = {
    ...prepared,
    definition: { ...prepared.definition, effects: [{ kind: 'heal' as const, amount: 7 }] },
  };
  expect(abilityPlan(projected)).not.toBe(prepared.execution);
  expect(abilityPlan(projected).effects).toEqual([{ kind: 'heal', amount: 7 }]);
  expect(abilityPlan(prepared).effects).toEqual(source.definition.effects);
});

it('separates startup/reaction plans and keeps prepared metadata out of saved manifests', async () => {
  const source = await singleAbility();
  expect(prepareAbility({
    ...source,
    definition: { ...source.definition, trigger: 'battle-start' },
  }).execution.kind).toBe('startup');
  const reaction = prepareAbility({
    ...source,
    definition: {
      ...source.definition,
      trigger: 'before-hit',
      reaction: { response: { kind: 'parry', scope: 'all' } },
    },
  });
  expect(reaction.execution.kind).toBe('reaction');
  const manifest = await sampleManifest();
  const battle = await prepareBattle(manifest);
  expect(battle.manifest.revisions.some((revision) => 'execution' in revision)).toBe(false);
  for (const actor of battle.actors)
    for (const ability of actor.abilities) {
      expect('execution' in ability).toBe(true);
      expect(abilityPlan(ability).source).toBe(ability.definition);
    }
});
