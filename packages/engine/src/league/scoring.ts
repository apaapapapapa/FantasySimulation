import {
  canonicalJson,
  compareIds,
  LeagueAttemptSchema,
  LeagueScoreInputSchema,
  LeagueSlotSchema,
  LeagueStandingsSchema,
  MAX_LEAGUE_SLOTS,
  type LeagueCell,
  type LeagueDefinition,
  type LeagueRevision,
  type LeagueScore,
  type LeagueStandings,
  type LeagueScoreInput,
  type LeagueSlot,
  type LeagueAttempt,
} from '@fantasy/domain/spatial';
import { fraction, type Fraction } from '../spatial/rules/effects.ts';
import {
  leagueMatches,
  leagueCoordinates,
  validateLeagueRevision,
  validateStoredLeagueRevision,
} from './index.ts';

export function compareLeagueFractions(a: Fraction, b: Fraction): number {
  const difference =
    BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
const add = (a: Fraction, b: Fraction) =>
  fraction(
    BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
const multiply = (a: Fraction, b: Fraction) =>
  fraction(
    BigInt(a.numerator) * BigInt(b.numerator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
const zero = () => fraction(0n, 1n);
const cellKey = (characters: readonly string[], scenario: string) =>
  `${characters.join('/')}/${scenario}`;

function score(
  cells: LeagueCell[],
  character: string,
  weight: (cell: LeagueCell) => Fraction,
): LeagueScore {
  const counts = { planned: 0, wins: 0, draws: 0, losses: 0, unresolved: 0 };
  let lower = zero(),
    upper = zero();
  for (const cell of cells) {
    const side = cell.characters[0] === character ? 0 : 1;
    const wins = cell.wins[side],
      losses = cell.wins[1 - side]!;
    const unresolved = cell.planned - wins - losses - cell.draws;
    counts.planned += cell.planned;
    counts.wins += wins;
    counts.losses += losses;
    counts.draws += cell.draws;
    counts.unresolved += unresolved;
    lower = add(
      lower,
      multiply(fraction(BigInt(2 * wins + cell.draws), BigInt(2 * cell.planned)), weight(cell)),
    );
    upper = add(
      upper,
      multiply(
        fraction(BigInt(2 * wins + cell.draws + 2 * unresolved), BigInt(2 * cell.planned)),
        weight(cell),
      ),
    );
  }
  return {
    lower: multiply(lower, fraction(100n, 1n)),
    upper: multiply(upper, fraction(100n, 1n)),
    completion: fraction(BigInt(counts.planned - counts.unresolved), BigInt(counts.planned)),
    winRate: fraction(BigInt(counts.wins), BigInt(counts.planned)),
    drawRate: fraction(BigInt(counts.draws), BigInt(counts.planned)),
    lossRate: fraction(BigInt(counts.losses), BigInt(counts.planned)),
    rateDenominator: 'planned-slots',
    counts,
  };
}

/** Counts must cover every planned opponent/scenario, including wholly unexecuted cells. */
export function scoreLeagueCounts(input: LeagueScoreInput): LeagueStandings {
  const { characters, battlefields, cells } = LeagueScoreInputSchema.parse(input);
  characters.sort(compareIds);
  battlefields.sort((a, b) => compareIds(a.scenario, b.scenario));
  if (
    new Set(characters).size !== characters.length ||
    new Set(battlefields.map((field) => field.scenario)).size !== battlefields.length
  )
    throw new Error('Duplicate scoring participant or battlefield');
  let totalWeight = zero();
  const weights = new Map(
    battlefields.map((field) => {
      totalWeight = add(totalWeight, field.weight);
      return [field.scenario, field.weight];
    }),
  );
  if (compareLeagueFractions(totalWeight, fraction(1n, 1n)) !== 0)
    throw new Error('Scoring weights must sum to one');
  const active = battlefields.filter((field) => BigInt(field.weight.numerator) > 0n);
  const expected = new Set<string>();
  for (let i = 0; i < characters.length; i++)
    for (let j = i + 1; j < characters.length; j++)
      for (const field of active)
        expected.add(cellKey([characters[i]!, characters[j]!], field.scenario));
  let planned = 0,
    resolved = 0;
  for (const cell of cells) {
    if (!expected.delete(cellKey(cell.characters, cell.scenario)))
      throw new Error('Unknown or duplicate scoring cell');
    planned += cell.planned;
    resolved += cell.wins[0] + cell.wins[1] + cell.draws;
  }
  if (expected.size || planned > MAX_LEAGUE_SLOTS)
    throw new Error('Incomplete or excessive scoring plan');
  const opponentWeight = fraction(1n, BigInt(characters.length - 1));
  const rows = characters
    .map((character) => {
      const own = cells.filter((cell) => cell.characters.includes(character));
      return {
        character,
        rank: null as number | null,
        displayOrder: 1,
        overall: score(own, character, (cell) =>
          multiply(weights.get(cell.scenario)!, opponentWeight),
        ),
        scenarios: active.map((field) => ({
          scenario: field.scenario,
          score: score(
            own.filter((cell) => cell.scenario === field.scenario),
            character,
            () => opponentWeight,
          ),
        })),
        opponents: characters
          .filter((opponent) => opponent !== character)
          .map((opponent) => ({
            character: opponent,
            score: score(
              own.filter((cell) => cell.characters.includes(opponent)),
              character,
              (cell) => weights.get(cell.scenario)!,
            ),
          })),
      };
    })
    .sort(
      (a, b) =>
        -compareLeagueFractions(a.overall.lower, b.overall.lower) ||
        compareIds(a.character, b.character),
    );
  for (const [index, row] of rows.entries()) {
    row.displayOrder = index + 1;
    if (resolved === planned)
      row.rank =
        index > 0 && compareLeagueFractions(row.overall.lower, rows[index - 1]!.overall.lower) === 0
          ? rows[index - 1]!.rank
          : index + 1;
  }
  return LeagueStandingsSchema.parse({
    schemaVersion: 1,
    scoringVersion: 'league-score-v1',
    status: resolved === planned ? 'formal' : 'provisional',
    order: 'lower-score-then-id',
    planned,
    resolved,
    completion: fraction(BigInt(resolved), BigInt(planned)),
    rows,
  });
}

function definitive(outcome: LeagueAttempt['outcome']) {
  return outcome.kind === 'win' || outcome.kind === 'draw';
}
function selectAttempts(slots: Map<string, LeagueSlot>, input: readonly LeagueAttempt[]) {
  // Transport bound is independent of the two unique attempt numbers allowed per slot.
  if (input.length > MAX_LEAGUE_SLOTS * 4) throw new Error('Excessive league delivery list');
  const seen = new Map<string, string>(),
    selected = new Map<string, LeagueAttempt>();
  for (const value of input) {
    const attempt = LeagueAttemptSchema.parse(value),
      slot = slots.get(attempt.slotId);
    if (!slot || slot.simulationHash !== attempt.simulationHash)
      throw new Error('Attempt does not belong to planned slot');
    if (attempt.outcome.kind === 'win') {
      const winner = attempt.outcome.winner;
      if (!slot.characters.some((character) => character.id === winner))
        throw new Error('Winner does not belong to match');
    }
    const key = `${attempt.slotId}/${attempt.attempt}`,
      bytes = canonicalJson(attempt);
    if (seen.has(key) && seen.get(key) !== bytes) throw new Error('Conflicting attempt record');
    seen.set(key, bytes);
    const previous = selected.get(attempt.slotId);
    if (
      previous &&
      definitive(previous.outcome) &&
      definitive(attempt.outcome) &&
      canonicalJson(previous.outcome) !== canonicalJson(attempt.outcome)
    )
      throw new Error('Conflicting definitive league result');
    if (
      !previous ||
      (!definitive(previous.outcome) &&
        (definitive(attempt.outcome) || attempt.attempt > previous.attempt))
    )
      selected.set(attempt.slotId, attempt);
  }
  return selected;
}

function plannedCells(definition: LeagueDefinition) {
  const cells = new Map<string, LeagueCell>();
  for (let a = 0; a < definition.characters.length; a++)
    for (let b = a + 1; b < definition.characters.length; b++)
      for (const field of definition.battlefields)
        if (field.weight.numerator !== '0') {
          const characters: [string, string] = [
            definition.characters[a]!.id,
            definition.characters[b]!.id,
          ];
          cells.set(cellKey(characters, field.scenario.id), {
            characters,
            scenario: field.scenario.id,
            planned: 0,
            wins: [0, 0],
            draws: 0,
          });
        }
  return cells;
}

/** The caller verifies bundle checksums before turning receipts into scoring attempts. */
export async function aggregateLeague(
  league: LeagueRevision,
  input: readonly LeagueSlot[],
  attempts: readonly LeagueAttempt[],
): Promise<LeagueStandings> {
  return aggregate(league, input, attempts, false);
}

/** The caller authenticates saved slot hashes against their plans and recorded bundles. */
export async function aggregateStoredLeague(
  league: LeagueRevision,
  input: readonly LeagueSlot[],
  attempts: readonly LeagueAttempt[],
): Promise<LeagueStandings> {
  return aggregate(league, input, attempts, true);
}

async function aggregate(
  league: LeagueRevision,
  input: readonly LeagueSlot[],
  attempts: readonly LeagueAttempt[],
  stored: boolean,
): Promise<LeagueStandings> {
  const { definition } = await (stored ? validateStoredLeagueRevision : validateLeagueRevision)(
    league,
  );
  if (input.length > MAX_LEAGUE_SLOTS) throw new Error('Excessive planned slots');
  const slots = new Map<string, LeagueSlot>(),
    cells = plannedCells(definition);
  const expected = new Map<string, string>();
  if (stored) {
    for await (const match of leagueCoordinates(definition))
      expected.set(match.slot.id, canonicalJson(match.slot));
  } else {
    for await (const match of leagueMatches(league))
      expected.set(match.slot.id, canonicalJson(match.slot));
  }
  for (const value of input) {
    const slot = LeagueSlotSchema.parse(value);
    const { simulationHash: _hash, ...coordinate } = slot;
    if (expected.get(slot.id) !== canonicalJson(stored ? coordinate : slot))
      throw new Error('Unknown, duplicate or incompatible league slot');
    expected.delete(slot.id);
    const { characters, scenario } = slot;
    const cell = cells.get(
      cellKey(
        characters.map((character) => character.id),
        scenario.id,
      ),
    );
    if (!cell) throw new Error('Unplanned league pairing');
    cell.planned++;
    slots.set(slot.id, slot);
  }
  if (
    [...cells.values()].some(
      (cell) => cell.planned !== definition.trials * definition.placements.length,
    )
  )
    throw new Error('Missing planned slots; unresolved matches must remain in the denominator');
  for (const attempt of selectAttempts(slots, attempts).values()) {
    const slot = slots.get(attempt.slotId)!;
    const cell = cells.get(
      cellKey(
        slot.characters.map((character) => character.id),
        slot.scenario.id,
      ),
    )!;
    if (attempt.outcome.kind === 'draw') cell.draws++;
    else if (attempt.outcome.kind === 'win')
      cell.wins[attempt.outcome.winner === cell.characters[0] ? 0 : 1]++;
  }
  return scoreLeagueCounts({
    characters: definition.characters.map((character) => character.id),
    battlefields: definition.battlefields.map((field) => ({
      scenario: field.scenario.id,
      weight: field.weight,
    })),
    cells: [...cells.values()],
  });
}
