import { expect, it, vi } from 'vite-plus/test';
import {
  ExperimentalRulesSchema,
  rulesetClass,
  closureMechanics,
  InterferenceTableSchema,
  interferenceTable,
  AbilitySchema,
  StatusSchema,
  StageSchema,
  AdjustmentTargetSchema,
  type Revision,
  mechanicRegistry,
} from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import { leagueFixture } from '@fantasy/samples/testing';
import { experimentalRules } from '@fantasy/samples/testing';
import { reactionConflictManifest } from '../../test-support/interference-diagnostics.ts';
import { prepareBattle } from './prepare.ts';
import { createLeagueRevision } from '../league/index.ts';
import { interferencePairManifest } from '../../test-support/interference.ts';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import { reference } from './prepare.ts';

it('checks experimental eligibility in dormant equipment-granted stages before execution', async () => {
  const input = await interferencePairManifest('stages', 'damage');
  const base = input.revisions.find((r) => r.kind === 'ability' && r.id === 'pair-action-0')!;
  if (base.kind !== 'ability') throw new Error('Stage fixture');
  const staged = await sealRevision('ability', base.id, 1, {
    ...base.definition,
    condition: { kind: 'visible', value: false },
    stages: base.definition.stages!.map((s, index) =>
      index === 0
        ? s
        : {
            ...s,
            startCondition: { kind: 'visible', value: false },
            effects: [
              ...s.effects,
              {
                kind: 'force',
                profile: 'linear-v1',
                direction: 'away',
                speedMmPerSecond: 1000,
                durationSteps: 1,
              },
            ],
          },
    ),
  });
  const gear = await sealRevision('equipment', 'dormant-gear', 1, {
    name: 'Dormant stages',
    originalText: '',
    attackBonus: 0,
    defenseBonus: 0,
    abilities: [reference(staged)],
  });
  const character = input.revisions.find(
    (r) => r.kind === 'character' && r.id === input.participants[0].character.id,
  )!;
  if (character.kind !== 'character') throw new Error('Character fixture');
  const owner = await sealRevision('character', character.id, 1, {
    ...character.definition,
    abilities: character.definition.abilities.filter((a) => a.id !== base.id),
    equipment: [reference(gear)],
  });
  input.revisions = input.revisions.filter((r) => r !== base && r !== character);
  input.revisions.push(staged, gear, owner);
  input.participants[0].character = reference(owner);
  const registry = new Map(mechanicRegistry);
  // Simulate a future implemented experimental registry entry, without accepting a future payload.
  const lookup = vi.spyOn(mechanicRegistry, 'get').mockImplementation((id) => {
    const entry = registry.get(id);
    return entry && id === 'force'
      ? { ...entry, standardReady: false, class: 'experimental' }
      : entry;
  });
  try {
    await expect(ManifestBuilder.from(input.revisions).build(input)).rejects.toMatchObject({
      code: 'unsupported-mechanic',
      mechanic: 'force',
      owner: { kind: 'ability', id: staged.id, contentHash: staged.contentHash },
    });
    const opted = await experimentalRules(input, ['force']);
    await expect(ManifestBuilder.from(opted.revisions).build(opted)).resolves.toHaveProperty(
      'simulationHash',
    );
  } finally {
    lookup.mockRestore();
  }
});

it('requires canonical explicit experimental permissions without implementing unrecognized payloads', async () => {
  for (const mechanics of [[], ['damage', 'damage'], ['heal', 'damage'], ['unknown']])
    expect(ExperimentalRulesSchema.safeParse({ mechanics }).success).toBe(false);
  expect(
    ExperimentalRulesSchema.safeParse({ mechanics: ['damage'], unexpected: true }).success,
  ).toBe(false);
  const normal = await sampleManifest(10);
  const standardRules = normal.revisions.find((r) => r.kind === 'ruleset')!;
  expect(rulesetClass(standardRules.definition)).toBe('standard');
  const experimental = await experimentalRules(structuredClone(normal));
  const prepared = await prepareBattle(experimental);
  expect(rulesetClass(prepared.rules)).toBe('experimental');
  const denied = await experimentalRules(await sampleManifest(10), ['existence-erasure']);
  await expect(prepareBattle(denied)).rejects.toMatchObject({
    code: 'unsupported-mechanic',
    mechanic: 'existence-erasure',
    owner: {
      kind: 'ruleset',
      id: 'experimental-fixture',
      revision: 1,
      contentHash: denied.ruleset.contentHash,
    },
  });
  await expect(
    createLeagueRevision(
      await experimentalRules(await leagueFixture(2, 1), ['foresight']),
      '1'.repeat(40),
    ),
  ).rejects.toMatchObject({ code: 'unsupported-mechanic', mechanic: 'foresight' });
});

it('fails promotion of a new standard mechanic with unresolved accepted pairs', () => {
  const table = InterferenceTableSchema.parse(interferenceTable);
  table.mechanics.find((m) => m.id === 'damage')!.generation = 'p6';
  const cell = table.cells.find((c) => c.row === 'damage' && c.column === 'heal')!;
  cell.cases = [
    {
      when: 'status.existing-conflict',
      state: 'unresolved',
      ruleId: 'status.existing-conflict',
      summary: 'Undecided',
    },
    { when: 'otherwise', state: 'defined', ruleId: 'legacy.wave-status-commit', summary: 'Legacy' },
  ];
  expect(InterferenceTableSchema.safeParse(table).success).toBe(false);
  cell.cases = [
    { when: 'always', state: 'independent', reason: 'Explicitly independent in this fixture' },
  ];
  expect(InterferenceTableSchema.safeParse(table).success).toBe(true);
});

it('inventories accepted mechanic-bearing schema fields and visits dormant and transformed closure owners', async () => {
  expect(Object.keys(AbilitySchema.shape).sort()).toEqual(
    [
      'aimErrorMilliDegrees',
      'attack',
      'castSteps',
      'categories',
      'condition',
      'cooldownSteps',
      'costs',
      'effects',
      'name',
      'originalText',
      'rangeMm',
      'reaction',
      'recoverySteps',
      'stages',
      'target',
      'trigger',
      'movementWhileCasting',
    ].sort(),
  );
  expect(Object.keys(StatusSchema.shape).sort()).toEqual(
    [
      'adjustments',
      'burning',
      'categories',
      'durationSteps',
      'flightStaminaPerSecond',
      'maxStacks',
      'modifiers',
      'name',
      'originalText',
      'periodic',
      'reactions',
      'stackKey',
      'stacking',
      'visibility',
    ].sort(),
  );
  expect(Object.keys(StageSchema.shape).sort()).toEqual(
    [
      'attack',
      'durationSteps',
      'effects',
      'hit',
      'id',
      'selfMotion',
      'offsetSteps',
      'cost',
      'startCondition',
      'interruptWhen',
      'interruptOnDamage',
    ].sort(),
  );
  expect(AdjustmentTargetSchema.options).toEqual([
    'attack',
    'defense',
    'magicPower',
    'magicDefense',
    'speed',
    'damageDealt',
    'damageTaken',
    'resistance',
    'absorption',
    'hpRecovery',
    'staminaRecovery',
    'perceptionRange',
    'perceptionFov',
    'action',
    'movement',
    'vision',
    'visibility',
  ]);
  const input = await reactionConflictManifest();
  const ability = input.revisions.find((r) => r.kind === 'ability')!;
  const dormant = structuredClone(ability);
  dormant.definition.condition = { kind: 'visible', value: false };
  dormant.definition.effects = [
    { kind: 'unclassified' },
  ] as unknown as typeof dormant.definition.effects;
  expect(() => closureMechanics([dormant])).toThrow('Unclassified effect variant');
  const uses = closureMechanics(input.revisions);
  const startup = input.revisions.find((r) => r.id === 'initial-grant-1')!;
  expect(uses).toContainEqual({
    mechanic: 'apply-status',
    owner: {
      kind: startup.kind,
      id: startup.id,
      revision: startup.revision,
      contentHash: startup.contentHash,
    },
  });
  const transformed = input.revisions.find((r) => r.id === 'fire-form')!;
  const changed = structuredClone(transformed) as Extract<Revision, { kind: 'status' }>;
  changed.definition.modifiers.silenced = true;
  expect(closureMechanics([changed])).toContainEqual({
    mechanic: 'silence',
    owner: {
      kind: changed.kind,
      id: changed.id,
      revision: changed.revision,
      contentHash: changed.contentHash,
    },
  });
});
