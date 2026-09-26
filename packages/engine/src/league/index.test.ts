import { expect, it } from 'vite-plus/test';
import {
  actorSeed,
  contentHash,
  leagueSlotCount,
  LeagueDefinitionSchema,
} from '@fantasy/domain/spatial';
import { observedRules } from '@fantasy/samples';
import { leagueFixture, leagueSource, plannedLeague } from '../../test-support/league.ts';
import {
  createLeagueRevision,
  leagueTrialSeed,
  normalizeLeagueDefinition,
  normalizeStoredLeagueDefinition,
  leagueDefinitionHash,
  validateLeagueRevision,
  validateStoredLeagueRevision,
} from './index.ts';
import { revisionHash } from '@fantasy/domain/spatial';

it.each(['checksum', 'input-hash', 'definition-order', 'rules-version'] as const)(
  'rejects saved league identity corruption: %s',
  async (fault) => {
    const saved = await createLeagueRevision(await leagueFixture(), leagueSource);
    if (fault === 'checksum') saved.sourceSha = 'e'.repeat(40);
    if (fault === 'input-hash') saved.inputHash = 'sha256:' + 'f'.repeat(64);
    if (fault === 'definition-order') saved.definition.characters.reverse();
    if (fault === 'rules-version') saved.engineVersion = 'unrelated-engine';
    if (fault !== 'checksum') {
      if (fault !== 'input-hash') {
        const { definition, engineVersion, implementationDigest } = saved;
        saved.inputHash = await contentHash({ definition, engineVersion, implementationDigest });
      }
      const { leagueHash: _, ...body } = saved;
      saved.leagueHash = await contentHash(body);
    }
    await expect(validateStoredLeagueRevision(saved)).rejects.toThrow('checksum or definition');
  },
);

it('compares validated historical definitions without current-engine eligibility or identity', async () => {
  const input = await leagueFixture();
  const before = await leagueDefinitionHash(input);
  const reordered = {
    ...input,
    characters: [...input.characters].reverse(),
    revisions: [...input.revisions].reverse(),
  };
  expect(await leagueDefinitionHash(reordered)).toBe(before);
  for (const edit of [
    { ...input, masterSeed: input.masterSeed + 1 },
    { ...input, id: 'next-milestone' },
    { ...input, trials: input.trials + 1 },
    {
      ...input,
      retryBudget: { ...input.retryBudget, maxEvents: input.retryBudget.maxEvents! + 1 },
    },
  ])
    expect(await leagueDefinitionHash(edit)).not.toBe(before);
  const old = {
    ...input,
    ruleset: {
      id: observedRules.id,
      revision: observedRules.revision,
      contentHash: observedRules.contentHash,
    },
    revisions: [...input.revisions, observedRules],
  };
  expect((await normalizeStoredLeagueDefinition(old)).ruleset).toEqual(old.ruleset);
  await expect(createLeagueRevision(old, leagueSource)).rejects.toMatchObject({
    code: 'unsupported-rules',
  });
  const extra = structuredClone(input.revisions.find((r) => r.kind === 'character')!);
  extra.id = 'unused-with-missing-policy';
  extra.definition.policy = { ...extra.definition.policy, id: 'missing-unused-policy' };
  extra.contentHash = await revisionHash(extra);
  await expect(
    leagueDefinitionHash({ ...input, revisions: [...input.revisions, extra] }),
  ).rejects.toMatchObject({ code: 'missing-revision' });
});

it('normalizes participant, scenario, revision and JSON key order without changing slots or manifests', async () => {
  const input = await leagueFixture();
  const original = await plannedLeague(input);
  input.characters.reverse();
  input.battlefields.reverse();
  input.revisions.reverse();
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
  expect(await plannedLeague(reordered)).toEqual(original);
  expect(original.matches).toHaveLength(24);
  expect(new Set(original.matches.map((m) => m.slot.id)).size).toBe(24);
  expect(new Set(original.matches.map((m) => m.slot.simulationHash)).size).toBe(24);
});

it('adds a participant without changing existing pair slots, seeds or manifests', async () => {
  const input = await leagueFixture(3);
  const before = await plannedLeague({ ...input, characters: input.characters.slice(0, 2) });
  const after = await plannedLeague(input);
  expect(after.league.leagueHash).not.toBe(before.league.leagueHash);
  const retained = after.matches.filter((match) =>
    before.matches.some((m) => m.slot.id === match.slot.id),
  );
  expect(retained).toEqual(before.matches);
  for (const trial of [0, 1])
    expect(
      new Set(after.matches.filter((m) => m.slot.trial === trial).map((m) => m.slot.seed)).size,
    ).toBe(1);
});

it('exchanges participant slots, positions and facing while streams remain attached to actors', async () => {
  const { matches } = await plannedLeague(await leagueFixture(2, 1));
  const normal = matches[0]!,
    swapped = matches[2]!;
  expect(swapped.manifest.participants.map((p) => p.rngStream)).toEqual([1, 0]);
  expect(swapped.slot.simulationHash).not.toBe(normal.slot.simulationHash);
  for (const index of [0, 1] as const) {
    const actor = normal.manifest.participants[index];
    const moved = swapped.manifest.participants[1 - index]!;
    expect(moved).toMatchObject({
      actorId: actor.actorId,
      character: actor.character,
      rngStream: actor.rngStream,
      rngSeed: actor.rngSeed,
    });
    expect(moved.position).toEqual(normal.manifest.participants[1 - index]!.position);
    expect(moved.rngSeed).toBe(actorSeed(swapped.slot.seed, moved.rngStream));
  }
});

it('counts 7,600 slots before expanding manifests and excludes zero weight scenarios', async () => {
  const input = await leagueFixture(20, 5);
  input.trials = 4;
  expect(leagueSlotCount(LeagueDefinitionSchema.parse(input))).toBe(7600);
  const small = await leagueFixture(2, 2);
  small.battlefields[0]!.weight = { numerator: '1', denominator: '1' };
  small.battlefields[1]!.weight = { numerator: '0', denominator: '1' };
  expect((await plannedLeague(small)).matches).toHaveLength(4);
});

it.each(['duplicate', 'weight', 'unknown', 'capacity', 'budget'] as const)(
  'rejects invalid definition: %s',
  async (kind) => {
    const input = await leagueFixture();
    if (kind === 'duplicate') input.characters.push(input.characters[0]!);
    if (kind === 'weight') input.battlefields[0]!.weight.numerator = '0';
    if (kind === 'unknown') Object.assign(input, { latest: true });
    if (kind === 'capacity') {
      input.characters = (await leagueFixture(64)).characters;
      input.trials = 64;
    }
    if (kind === 'budget') input.retryBudget.maxEvents = 1;
    await expect(createLeagueRevision(input, leagueSource)).rejects.toThrow();
  },
);

it('rejects unsupported rules, unpinned dependencies, modified content and altered hashes', async () => {
  const input = await leagueFixture();
  const old = { ...input, ruleset: observedRules, revisions: [...input.revisions, observedRules] };
  old.ruleset = { ...observedRules };
  await expect(
    createLeagueRevision(
      {
        ...old,
        ruleset: {
          id: observedRules.id,
          revision: observedRules.revision,
          contentHash: observedRules.contentHash,
        },
      },
      leagueSource,
    ),
  ).rejects.toMatchObject({ code: 'unsupported-rules' });
  const missing = structuredClone(input);
  missing.revisions = missing.revisions.filter((r) => r.kind !== 'policy');
  await expect(createLeagueRevision(missing, leagueSource)).rejects.toMatchObject({
    code: 'missing-revision',
  });
  const corrupt = structuredClone(input);
  corrupt.revisions[0]!.definition.name = 'changed without revision hash';
  await expect(createLeagueRevision(corrupt, leagueSource)).rejects.toThrow(/content/);
  const league = await createLeagueRevision(input, leagueSource);
  await expect(validateLeagueRevision({ ...league, sourceSha: '2'.repeat(40) })).rejects.toThrow(
    /checksum/,
  );
});

it('compares effective retry budgets including omitted optional defaults', async () => {
  const input = await leagueFixture();
  delete input.budget.maxForces;
  input.retryBudget.maxForces = 1;
  expect(LeagueDefinitionSchema.safeParse(input).success).toBe(false);
  await expect(normalizeLeagueDefinition(input)).rejects.toThrow(/maxForces/);
  delete input.retryBudget.maxForces;
  const normalized = await normalizeLeagueDefinition(input);
  expect(normalized.budget.maxForces).toBe(64);
  expect(normalized.retryBudget.maxForces).toBe(64);
  input.budget.maxForces = 1;
  expect(LeagueDefinitionSchema.safeParse(input).success).toBe(true);
});

it('separates unchanged-input detection from source-bound publication identity', async () => {
  const input = await leagueFixture();
  const first = await createLeagueRevision(input, leagueSource);
  const second = await createLeagueRevision(input, '2'.repeat(40));
  expect(second.inputHash).toBe(first.inputHash);
  expect(second.leagueHash).not.toBe(first.leagueHash);
  await expect(leagueTrialSeed(-1, 0)).rejects.toThrow();
});

it('pins league-trial-v1 vectors independently of pair and battlefield identity', async () => {
  expect(await Promise.all([0, 1, 2, 3].map((trial) => leagueTrialSeed(42, trial)))).toEqual([
    450254693, 3117309440, 3024773195, 4179239927,
  ]);
  const input = await leagueFixture();
  input.battlefields[0]!.weight.numerator = 'invalid';
  expect(LeagueDefinitionSchema.safeParse(input).success).toBe(false);
});
