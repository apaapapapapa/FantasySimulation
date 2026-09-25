import { expect, it } from 'vite-plus/test';
import type { LeagueAttempt, LeagueScoreInput } from '@fantasy/domain/spatial';
import { leagueFixture, plannedLeague } from '../../test-support/league.ts';
import { aggregateLeague, compareLeagueFractions, scoreLeagueCounts } from './scoring.ts';
import { sealRevision, reference } from '@fantasy/engine/spatial';

function example(): LeagueScoreInput {
  return {
    characters: ['a', 'b'],
    battlefields: [
      { scenario: 'flat', weight: { numerator: '3', denominator: '4' } },
      { scenario: 'indoor', weight: { numerator: '1', denominator: '4' } },
    ],
    cells: [
      { characters: ['a', 'b'], scenario: 'flat', planned: 2, wins: [1, 0], draws: 0 },
      { characters: ['a', 'b'], scenario: 'indoor', planned: 4, wins: [0, 0], draws: 1 },
    ],
  };
}

it('pins the Issue #1 interval 40.625–96.875 with unequal planned cell denominators', () => {
  const result = scoreLeagueCounts(example());
  expect(result).toMatchObject({
    status: 'provisional',
    planned: 6,
    resolved: 2,
    completion: { numerator: '1', denominator: '3' },
  });
  expect(result.rows[0]).toMatchObject({
    character: 'a',
    rank: null,
    displayOrder: 1,
    overall: {
      lower: { numerator: '325', denominator: '8' },
      upper: { numerator: '775', denominator: '8' },
      rateDenominator: 'planned-slots',
      winRate: { numerator: '1', denominator: '6' },
      drawRate: { numerator: '1', denominator: '6' },
      counts: { planned: 6, wins: 1, draws: 1, losses: 0, unresolved: 4 },
    },
  });
  expect(result.rows[0]!.scenarios[0]!.score.lower).toEqual({ numerator: '50', denominator: '1' });
});

it.each(['cycle', 'draw'] as const)('gives exactly equal formal ranks for %s', (kind) => {
  const input: LeagueScoreInput = {
    characters: ['c', 'a', 'b'],
    battlefields: [{ scenario: 'flat', weight: { numerator: '1', denominator: '1' } }],
    cells: [
      { characters: ['a', 'b'], scenario: 'flat', planned: 2, wins: [2, 0], draws: 0 },
      { characters: ['a', 'c'], scenario: 'flat', planned: 2, wins: [0, 2], draws: 0 },
      { characters: ['b', 'c'], scenario: 'flat', planned: 2, wins: [2, 0], draws: 0 },
    ],
  };
  if (kind === 'draw')
    for (const cell of input.cells) {
      cell.wins = [0, 0];
      cell.draws = 2;
    }
  const result = scoreLeagueCounts(input);
  expect(result.status).toBe('formal');
  expect(result.completion).toEqual({ numerator: '1', denominator: '1' });
  expect(result.rows.map((row) => [row.character, row.rank, row.overall.lower])).toEqual([
    ['a', 1, { numerator: '50', denominator: '1' }],
    ['b', 1, { numerator: '50', denominator: '1' }],
    ['c', 1, { numerator: '50', denominator: '1' }],
  ]);
  input.characters.reverse();
  input.cells.reverse();
  expect(scoreLeagueCounts(input)).toEqual(result);
});

it('applies exact one-fifth weights and keeps rounded display ties out of rank calculation', () => {
  const input = example();
  input.battlefields = Array.from({ length: 5 }, (_, i) => ({
    scenario: `field-${i}`,
    weight: { numerator: '1', denominator: '5' },
  }));
  input.cells = input.battlefields.map((field, i) => ({
    characters: ['a', 'b'],
    scenario: field.scenario,
    planned: 2,
    wins: i < 3 ? [2, 0] : [0, 2],
    draws: 0,
  }));
  expect(scoreLeagueCounts(input).rows.map((row) => [row.rank, row.overall.lower])).toEqual([
    [1, { numerator: '60', denominator: '1' }],
    [2, { numerator: '40', denominator: '1' }],
  ]);
  const near = example();
  near.battlefields[0]!.weight = { numerator: '50000000001', denominator: '100000000000' };
  near.battlefields[1]!.weight = { numerator: '49999999999', denominator: '100000000000' };
  near.cells[0]!.wins = [2, 0];
  near.cells[1]!.wins = [0, 4];
  near.cells[1]!.draws = 0;
  const rows = scoreLeagueCounts(near).rows;
  expect(rows.map((row) => row.rank)).toEqual([1, 2]);
  expect(compareLeagueFractions(rows[0]!.overall.lower, rows[1]!.overall.lower)).toBe(1);
  expect(
    compareLeagueFractions(
      { numerator: '2', denominator: '4' },
      { numerator: '1', denominator: '2' },
    ),
  ).toBe(0);
});

it.each(['missing', 'duplicate', 'overcount', 'negative', 'digits'] as const)(
  'rejects invalid scoring inputs: %s',
  (kind) => {
    const input = example();
    if (kind === 'missing') input.cells.pop();
    if (kind === 'duplicate') input.cells.push(input.cells[0]!);
    if (kind === 'overcount') input.cells[0]!.draws = 2;
    if (kind === 'negative') input.cells[0]!.wins[0] = -1;
    if (kind === 'digits') input.battlefields[0]!.weight.denominator = '1'.repeat(100);
    expect(() => scoreLeagueCounts(input)).toThrow();
  },
);

it.each(['unresolved', 'truncated', 'failed', 'cancelled'] as const)(
  'retains the denominator for %s and absent attempts',
  async (kind) => {
    const { league, matches } = await plannedLeague(await leagueFixture(2, 1));
    const slots = matches.map((match) => match.slot),
      first = slots[0]!;
    const incomplete: LeagueAttempt = {
      slotId: first.id,
      simulationHash: first.simulationHash,
      attempt: 1,
      outcome: { kind },
    };
    const empty = await aggregateLeague(league, slots, []);
    expect(await aggregateLeague(league, slots, [incomplete])).toEqual(empty);
    expect(empty.rows[0]).toMatchObject({
      rank: null,
      overall: {
        lower: { numerator: '0', denominator: '1' },
        upper: { numerator: '100', denominator: '1' },
        counts: { planned: 4, unresolved: 4 },
      },
    });
    await expect(aggregateLeague(league, slots.slice(1), [])).rejects.toThrow(/Missing planned/);
  },
);

it('counts a successful retry once, ignores duplicate delivery and rejects conflicting final results', async () => {
  const { league, matches } = await plannedLeague(await leagueFixture(2, 1));
  const slots = matches.map((match) => match.slot),
    first = slots[0]!;
  const failed: LeagueAttempt = {
    slotId: first.id,
    simulationHash: first.simulationHash,
    attempt: 1,
    outcome: { kind: 'failed' },
  };
  const won: LeagueAttempt = {
    ...failed,
    attempt: 2,
    outcome: {
      kind: 'win',
      winner: first.characters[0].id,
      resultHash: `sha256:${'1'.repeat(64)}`,
    },
  };
  const result = await aggregateLeague(league, slots, [failed, won, won]);
  expect(
    await aggregateLeague(
      league,
      slots,
      Array.from({ length: 9 }, () => won),
    ),
  ).toEqual(result);
  expect(result.rows[0]!.overall).toMatchObject({
    lower: { numerator: '25', denominator: '1' },
    counts: { planned: 4, wins: 1, unresolved: 3 },
  });
  expect(await aggregateLeague(league, slots.toReversed(), [won, failed])).toEqual(result);
  await expect(
    aggregateLeague(league, slots, [
      won,
      { ...won, attempt: 1, outcome: { kind: 'draw', resultHash: `sha256:${'2'.repeat(64)}` } },
    ]),
  ).rejects.toThrow(/Conflicting definitive/);
  await expect(
    aggregateLeague(league, slots, [{ ...won, simulationHash: `sha256:${'2'.repeat(64)}` }]),
  ).rejects.toThrow(/does not belong/);
  await expect(
    aggregateLeague(league, slots, [
      {
        ...won,
        outcome: { kind: 'win', winner: 'outsider', resultHash: `sha256:${'1'.repeat(64)}` },
      },
    ]),
  ).rejects.toThrow(/Winner/);
});

it('rejects authentic slots from another ruleset even when coordinates and seeds agree', async () => {
  const definition = await leagueFixture(2, 1);
  const first = await plannedLeague(definition);
  const rules = definition.revisions.find((r) => r.kind === 'ruleset')!;
  if (rules.kind !== 'ruleset') throw new Error('Missing rules');
  const other = await sealRevision('ruleset', 'other-league-rules', 1, {
    ...rules.definition,
    maxSteps: 21,
  });
  definition.ruleset = reference(other);
  definition.revisions.push(other);
  const second = await plannedLeague(definition);
  expect(second.matches.map((m) => m.slot.id)).toEqual(first.matches.map((m) => m.slot.id));
  await expect(
    aggregateLeague(
      second.league,
      first.matches.map((m) => m.slot),
      [],
    ),
  ).rejects.toThrow(/incompatible/);
});

it('represents valid coprime planned denominators beyond 96 decimal digits exactly', () => {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < 63; candidate++)
    if (primes.every((p) => candidate % p !== 0)) primes.push(candidate);
  const characters = Array.from({ length: 64 }, (_, i) => `actor-${String(i).padStart(2, '0')}`);
  const cells: LeagueScoreInput['cells'] = [];
  for (let a = 0; a < 64; a++)
    for (let b = a + 1; b < 64; b++)
      cells.push({
        characters: [characters[a]!, characters[b]!],
        scenario: 'flat',
        planned: a === 0 ? primes[b - 1]! : 1,
        wins: a === 0 ? [1, 0] : [0, 0],
        draws: 0,
      });
  const result = scoreLeagueCounts({
    characters,
    battlefields: [{ scenario: 'flat', weight: { numerator: '1', denominator: '1' } }],
    cells,
  });
  expect(result.planned).toBe(10535);
  expect(
    result.rows.find((row) => row.character === 'actor-00')!.overall.lower.denominator,
  ).toHaveLength(124);
});
