import phasing from '../../fixtures/spatial/phasing-pairs.json' with { type: 'json' };
import { expect, it } from 'vite-plus/test';
import {
  interferenceTable,
  InterferenceTableSchema,
  closureMechanics,
  EffectSchema,
  contentHash,
  revisionHash,
  type MechanicId,
} from '@fantasy/domain/spatial';
import baseline from '../../fixtures/spatial/interference-baseline.json' with { type: 'json' };
import coverage from '../../fixtures/spatial/interference-coverage.json' with { type: 'json' };
import corpus from '../../fixtures/spatial/corpus.json' with { type: 'json' };
import recovery from '../../fixtures/spatial/recovery-pairs.json' with { type: 'json' };
import objects from '../../fixtures/spatial/spatial-object-pairs.json' with { type: 'json' };
import teleport from '../../fixtures/spatial/teleport-pairs.json' with { type: 'json' };
import {
  LEGACY_INTERFERENCE_MECHANICS,
  interferencePairManifest,
} from '../../test-support/interference.ts';
import { STATUS_CONFLICT_RULES } from '../../test-support/interference-diagnostics.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { mechanicEligibility } from './mechanic-policy.ts';
import { reference } from './prepare.ts';
import { runBattle } from './run.ts';

function validateCoverage(input: typeof coverage) {
  const tests: Record<string, { file: string; name: string }> = corpus.tests;
  for (const [kind, id] of Object.entries(input.testIds).filter(
    (entry) => typeof entry[1] === 'string',
  )) {
    if (
      typeof id !== 'string' ||
      tests[id]?.file !==
        (kind === 'phasing'
          ? 'packages/engine/src/spatial/phasing-interference.test.ts'
          : kind === 'objects'
            ? 'packages/engine/src/spatial/spatial-object-interference.test.ts'
            : kind === 'teleport'
              ? 'packages/engine/src/spatial/teleport-interference.test.ts'
              : kind === 'recovery'
                ? 'packages/engine/src/spatial/recovery-interference.test.ts'
                : 'packages/engine/src/spatial/interference-matrix.test.ts')
    )
      throw new Error(`Missing executed ${kind} corpus binding`);
  }
  for (const rule of STATUS_CONFLICT_RULES) {
    const id = input.testIds.diagnostics[rule];
    if (
      tests[id]?.name !==
      `records the complete bounded causal set and preserves rollback for ${rule}`
    )
      throw new Error('Missing executed diagnostic corpus binding');
  }
  const fixtures = new Set([
    ...baseline.cases.map((c) => c.id),
    ...deflectionPairs.map(([left, right]) => `${left}/${right}`),
    ...recovery.cases.map((c) => c.id),
    ...teleport.cases.map((c) => c.id),
    ...objects.cases.map((c) => c.id),
    ...phasing.cases.map((c) => c.id),
    ...STATUS_CONFLICT_RULES,
    ...interferenceTable.mechanics.filter((m) => !m.implemented).map((m) => `reject.${m.id}`),
  ]);
  const cells = new Map(input.cells.map((cell) => [`${cell.row}/${cell.column}`, cell]));
  if (
    input.schemaVersion !== 1 ||
    cells.size !== input.cells.length ||
    cells.size !== interferenceTable.cells.length
  )
    throw new Error('Incomplete/duplicate coverage cells');
  for (const cell of interferenceTable.cells) {
    const fixture = cells.get(`${cell.row}/${cell.column}`);
    if (!fixture || fixture.cases.length !== cell.cases.length)
      throw new Error('Missing case fixture');
    for (const [index, clause] of cell.cases.entries()) {
      const mapped = fixture.cases[index]!;
      if (mapped.when !== clause.when || !fixtures.has(mapped.fixture))
        throw new Error('Missing expected fixture');
      if (clause.state === 'defined' && mapped.fixture !== `${cell.row}/${cell.column}`)
        throw new Error('Defined cell must exercise its own ordered pair');
      if (clause.state === 'unresolved' && mapped.fixture !== clause.ruleId)
        throw new Error('Diagnostic fixture must exercise the actual resolver rule');
      if (
        clause.state === 'rejected' &&
        ![cell.row, cell.column].some(
          (m) =>
            mapped.fixture === `reject.${m}` &&
            interferenceTable.mechanics.some((entry) => entry.id === m && !entry.implemented),
        )
      )
        throw new Error('Rejection fixture must deny a mechanic in this cell');
    }
  }
}

it('binds every explicit ordered cell to an executed behavior, diagnostic or rejection fixture', () => {
  expect(InterferenceTableSchema.parse(interferenceTable)).toEqual(interferenceTable);
  validateCoverage(coverage);
  for (const missing of ['cell', 'duplicate', 'fixture'] as const) {
    const table = InterferenceTableSchema.parse(interferenceTable);
    if (missing === 'cell') table.cells.pop();
    if (missing === 'duplicate') table.cells[0] = structuredClone(table.cells[1]!);
    if (missing !== 'fixture') expect(InterferenceTableSchema.safeParse(table).success).toBe(false);
    else {
      const damaged = structuredClone(coverage);
      damaged.cells[0]!.cases[0]!.fixture = 'absent';
      expect(() => validateCoverage(damaged)).toThrow('Missing expected fixture');
    }
  }
  expect(baseline.provenance.sourceSha).toBe('bc9928f83eccd26645db48ac846f8432861ce2ce');
  expect(baseline.mechanics).toEqual(LEGACY_INTERFERENCE_MECHANICS);
  expect(
    new Set(interferenceTable.mechanics.filter((m) => m.generation === 'legacy').map((m) => m.id)),
  ).toEqual(new Set(LEGACY_INTERFERENCE_MECHANICS));
  const missingBinding = structuredClone(coverage);
  missingBinding.testIds.pairs = 'absent';
  expect(() => validateCoverage(missingBinding)).toThrow('corpus binding');
});

it('preserves all 484 pre-P6 ordered-pair outcomes and event trajectory state physics hashes', async () => {
  const cases = new Map(baseline.cases.map((c) => [c.id, c]));
  expect(cases.size).toBe(484);
  let checked = 0;
  for (const left of LEGACY_INTERFERENCE_MECHANICS)
    for (const right of LEGACY_INTERFERENCE_MECHANICS) {
      const fixture = cases.get(`${left}/${right}`)!;
      expect(fixture, `${left}/${right}`).toBeDefined();
      const manifest = await interferencePairManifest(left, right);
      // Compare the immutable pre-P6 input under its original rules label without
      // executing that old ruleset. Only the rules label/name/version differs in v1.22.
      const old = manifest.revisions.find((r) => r.kind === 'ruleset')!;
      if (old.kind !== 'ruleset') throw new Error('Missing fixture rules');
      const historical = {
        ...old,
        id: 'standard-engagement-v1',
        definition: { ...old.definition, name: '標準3D', rulesVersion: 'spatial-v1.20' },
      };
      historical.contentHash = await revisionHash(historical);
      const { implementationDigest: _, ...input } = {
        ...manifest,
        engineVersion: 'spatial-v1.20',
        ruleset: reference(historical),
        revisions: manifest.revisions.map((r) => (r === old ? historical : r)),
      };
      expect(await contentHash(input), fixture.id).toBe(fixture.inputHash);
      const uses = new Set(closureMechanics(manifest.revisions).map((use) => use.mechanic));
      expect(uses.has(left) && uses.has(right), fixture.id).toBe(true);
      const { simulationHash: _hash, ...result } = (await runBattle(manifest)).result;
      expect(result, fixture.id).toEqual(fixture.expected);
      checked++;
    }
  expect(checked).toBe(cases.size);
}, 180000);

it('rejects every unimplemented or reserved matrix mechanic even with experimental permission', async () => {
  const manifest = await interferencePairManifest('damage', 'damage');
  const owner = manifest.revisions.find((r) => r.kind === 'ability')!;
  const rules = manifest.revisions.find((r) => r.kind === 'ruleset')!;
  for (const mechanic of interferenceTable.mechanics.filter((m) => !m.implemented)) {
    expect(EffectSchema.safeParse({ kind: mechanic.id }).success, mechanic.id).toBe(false);
    for (const allowed of [false, true]) {
      const result = mechanicEligibility(
        {
          ...rules.definition,
          ...(allowed ? { experimental: { mechanics: [mechanic.id as MechanicId] } } : {}),
        },
        [{ mechanic: mechanic.id, owner }],
      );
      expect(result, `reject.${mechanic.id}`).toMatchObject({
        executable: false,
        mechanic: mechanic.id,
        owner: { id: owner.id, revision: owner.revision, contentHash: owner.contentHash },
      });
    }
  }
});

const deflectionPairs = [
  ...(
    [
      ...LEGACY_INTERFERENCE_MECHANICS,
      'attribute-absorption',
      'drain',
      'teleport',
      'barrier',
      'area',
      'beam',
      'phasing',
    ] as const
  ).flatMap(
    (other) =>
      [
        [other, 'projectile-deflection'],
        ['projectile-deflection', other],
      ] as const,
  ),
  ['projectile-deflection', 'projectile-deflection'] as const,
];
it('executes every standard ordered deflection pair with explicit contact and ownership expectations', async () => {
  for (const [left, right] of deflectionPairs) {
    const input = await interferencePairManifest(left, right);
    const uses = new Set(closureMechanics(input.revisions).map((u) => u.mechanic));
    expect(uses.has(left) && uses.has(right), `${left}/${right}`).toBe(true);
    const result = await runBattle(input);
    const events = result.records.flatMap((r) => ('events' in r ? r.events : []));
    const deflections = events.filter((e) => e.kind === 'projectile-deflect');
    const other = left === 'projectile-deflection' ? right : left;
    const expected = [
      'contact',
      'motion',
      'stages',
      'silence',
      'reveal',
      'teleport',
      'barrier',
      'area',
      'beam',
    ].includes(other)
      ? 0
      : other === 'projectile-deflection'
        ? 2
        : 1;
    expect(deflections, `${left}/${right}`).toHaveLength(expected);
    for (const event of deflections) {
      expect(event.projectileDeflection).toMatchObject({
        ownerId: event.actorId,
        originalOwnerId: event.targetId,
        powerBps: 10000,
      });
      expect(
        events.some(
          (e) => e.kind === 'hit' && e.entityId === event.entityId && e.step < event.step,
        ),
        `${left}/${right}: no replaced impact`,
      ).toBe(false);
      expect(
        events.filter((e) => e.kind === 'projectile-deflect' && e.entityId === event.entityId),
      ).toHaveLength(1);
    }
    expect(result.result.outcome.kind, `${left}/${right}`).toBe('draw');
    if (other === 'attribute-absorption' || other === 'drain') {
      const { replay } = await recordedCheckpoints(input, result);
      const owner = left === 'projectile-deflection' ? 'left' : 'right';
      const actors = replay.checkpoint().state!.actors;
      expect(actors.find((a) => a.id === owner)!.resources).toMatchObject({ hp: 40, shield: 1 });
      expect(actors.find((a) => a.id !== owner)!.resources).toMatchObject({
        hp: other === 'attribute-absorption' ? 40 : 33,
        shield: other === 'attribute-absorption' ? 1 : 0,
      });
      const damage = events.filter((e) => e.kind === 'damage');
      expect(damage).toHaveLength(2);
      expect(damage.every((e) => e.targetId !== owner)).toBe(true);
      expect(events.some((e) => e.ruleId === 'damage.drain' || e.damage?.drain)).toBe(false);
      if (other === 'attribute-absorption')
        expect(damage.map((e) => e.damage?.absorption)).toEqual([
          { element: 'fire', converted: 4, healing: 4 },
          { element: 'fire', converted: 4, healing: 4 },
        ]);
    }
  }
});
