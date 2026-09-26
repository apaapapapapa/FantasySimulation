import {
  CURRENT_ENGINE_VERSION,
  DEFAULT_BUDGET,
  compareIds,
  revisionHash,
  revisionIndex,
  revisionKey,
  requireRevision,
  resolveClosure,
  LeagueDefinitionSchema,
  canonicalJson,
  contentHash,
  parseJson,
  LeagueRevisionSchema,
  ManifestSchema,
  type LeagueDefinition,
  type LeagueRevision,
  type LeagueSlot,
  type Manifest,
  MAX_LEAGUE_SLOTS,
} from '@fantasy/domain/spatial';
import { ManifestBuilder } from '../spatial/manifest-builder.ts';
import { implementation } from '../spatial/prepare.ts';
import { requireExecutableRules } from '../spatial/execution-policy.ts';
import { fraction } from '../spatial/rules/effects.ts';

/** A new league input version; battle/actor-stream-v1 semantics are unchanged. */
export async function leagueTrialSeed(masterSeed: number, trial: number): Promise<number> {
  if (
    !Number.isInteger(masterSeed) ||
    masterSeed < 0 ||
    masterSeed > 0xffff_ffff ||
    !Number.isInteger(trial) ||
    trial < 0 ||
    trial > 63
  )
    throw new Error('Invalid league seed input');
  const hash = await contentHash({
    version: 'league-trial-v1',
    masterSeed,
    trial,
    purpose: 'battle',
  });
  return Number.parseInt(hash.slice(7, 15), 16);
}

/** Structural validation only: historical pinned definitions are never executed here. */
export async function normalizeStoredLeagueDefinition(input: unknown): Promise<LeagueDefinition> {
  const definition = parseJson(LeagueDefinitionSchema, input);
  const lookup = revisionIndex(definition.revisions);
  const rules = requireRevision(lookup, 'ruleset', definition.ruleset);
  // Reject even unused corrupt definitions before reducing to the pinned closure.
  for (const revision of definition.revisions)
    if (revision.contentHash !== (await revisionHash(revision)))
      throw new Error(`Invalid league revision content: ${revision.id}`);
  resolveClosure(definition.revisions, lookup, 4096);
  definition.characters.sort((a, b) => compareIds(a.id, b.id));
  definition.battlefields.sort((a, b) => compareIds(a.scenario.id, b.scenario.id));
  for (const field of definition.battlefields)
    field.weight = fraction(BigInt(field.weight.numerator), BigInt(field.weight.denominator));
  const builder = ManifestBuilder.from(definition.revisions);
  definition.revisions = builder
    .closure(
      [
        ...definition.characters.map((ref) => requireRevision(lookup, 'character', ref)),
        rules,
        ...definition.battlefields.map((field) =>
          requireRevision(lookup, 'scenario', field.scenario),
        ),
      ],
      4096,
    )
    .sort((a, b) => compareIds(revisionKey(a), revisionKey(b)));
  definition.budget = { ...DEFAULT_BUDGET, ...definition.budget };
  definition.retryBudget = { ...DEFAULT_BUDGET, ...definition.retryBudget };
  return definition;
}

export async function normalizeLeagueDefinition(input: unknown): Promise<LeagueDefinition> {
  const definition = await normalizeStoredLeagueDefinition(input);
  const rules = requireRevision(revisionIndex(definition.revisions), 'ruleset', definition.ruleset);
  requireExecutableRules(rules.definition);
  return definition;
}

/** Comparison metadata, never a simulation or result-cache identity. */
export async function leagueDefinitionHash(input: unknown): Promise<string> {
  return contentHash(await normalizeStoredLeagueDefinition(input));
}

export async function createLeagueRevision(
  input: unknown,
  sourceSha: string,
): Promise<LeagueRevision> {
  const definition = await normalizeLeagueDefinition(input);
  const identity = {
    definition,
    engineVersion: CURRENT_ENGINE_VERSION,
    implementationDigest: implementation.digest,
  };
  const body = {
    schemaVersion: 1 as const,
    ...identity,
    sourceSha,
    inputHash: await contentHash(identity),
  };
  return parseJson(LeagueRevisionSchema, { ...body, leagueHash: await contentHash(body) });
}

export async function validateLeagueRevision(input: unknown): Promise<LeagueRevision> {
  const revision = parseJson(LeagueRevisionSchema, input);
  const rebuilt = await createLeagueRevision(revision.definition, revision.sourceSha);
  if (canonicalJson(revision) !== canonicalJson(rebuilt))
    throw new Error('League revision checksum or execution identity mismatch');
  return rebuilt;
}

/** Bounded iteration avoids retaining every expanded manifest in memory. */
export async function* leagueMatches(
  input: LeagueRevision,
  range: { offset: number; limit: number } = { offset: 0, limit: MAX_LEAGUE_SLOTS },
): AsyncGenerator<{
  slot: LeagueSlot;
  manifest: Manifest;
}> {
  const { definition } = await validateLeagueRevision(input);
  if (
    !Number.isInteger(range.offset) ||
    range.offset < 0 ||
    range.offset > MAX_LEAGUE_SLOTS ||
    !Number.isInteger(range.limit) ||
    range.limit < 1 ||
    range.limit > MAX_LEAGUE_SLOTS
  )
    throw new Error('Invalid league match range');
  let ordinal = 0;
  const builder = ManifestBuilder.from(definition.revisions);
  for await (const planned of leagueCoordinates(definition)) {
    if (ordinal++ < range.offset) continue;
    if (ordinal > range.offset + range.limit) return;
    const battle = await builder.build(planned.spec);
    yield {
      slot: { ...planned.slot, simulationHash: battle.simulationHash },
      manifest: parseJson(ManifestSchema, battle.manifest),
    };
  }
}

/** Versioned schedule metadata only: safe for validating saved league records without execution. */
export async function* leagueCoordinates(definition: LeagueDefinition) {
  const seeds = await Promise.all(
    Array.from({ length: definition.trials }, (_, trial) =>
      leagueTrialSeed(definition.masterSeed, trial),
    ),
  );
  if (new Set(seeds).size !== seeds.length) throw new Error('League trial seed collision');
  for (let a = 0; a < definition.characters.length; a++) {
    for (let b = a + 1; b < definition.characters.length; b++) {
      const characters: LeagueSlot['characters'] = [
        definition.characters[a]!,
        definition.characters[b]!,
      ];
      for (const field of definition.battlefields) {
        if (field.weight.numerator === '0') continue;
        for (const placement of definition.placements) {
          for (let trial = 0; trial < seeds.length; trial++) {
            const seed = seeds[trial]!;
            const participants = ManifestBuilder.participants(seed, [
              {
                actorId: 'league-a',
                character: characters[0],
                ...field.starts[placement === 'normal' ? 0 : 1],
              },
              {
                actorId: 'league-b',
                character: characters[1],
                ...field.starts[placement === 'normal' ? 1 : 0],
              },
            ]);
            if (placement === 'swapped') participants.reverse();
            const spec = {
              seed,
              participants,
              ruleset: definition.ruleset,
              scenario: field.scenario,
            };
            const coordinate = { characters, scenario: field.scenario, placement, trial };
            yield {
              slot: {
                ...coordinate,
                id: await contentHash({ ...coordinate, starts: field.starts }),
                seed,
              },
              spec,
            };
          }
        }
      }
    }
  }
}
