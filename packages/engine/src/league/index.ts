import {
  CURRENT_ENGINE_VERSION,
  DEFAULT_BUDGET,
  canonicalJson,
  compareIds,
  contentHash,
  parseJson,
  revisionHash,
  revisionIndex,
  revisionKey,
  requireRevision,
  LeagueDefinitionSchema,
  LeagueRevisionSchema,
  ManifestSchema,
  type LeagueDefinition,
  type LeagueRevision,
  type LeagueSlot,
  type Manifest,
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

export async function normalizeLeagueDefinition(input: unknown): Promise<LeagueDefinition> {
  const definition = parseJson(LeagueDefinitionSchema, input);
  const lookup = revisionIndex(definition.revisions);
  const rules = requireRevision(lookup, 'ruleset', definition.ruleset);
  requireExecutableRules(rules.definition);
  // Reject even unused corrupt definitions before reducing to the pinned closure.
  for (const revision of definition.revisions)
    if (revision.contentHash !== (await revisionHash(revision)))
      throw new Error(`Invalid league revision content: ${revision.id}`);
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
export async function* leagueMatches(input: LeagueRevision): AsyncGenerator<{
  slot: LeagueSlot;
  manifest: Manifest;
}> {
  const { definition } = await validateLeagueRevision(input);
  const builder = ManifestBuilder.from(definition.revisions);
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
            const battle = await builder.build({
              seed,
              participants,
              ruleset: definition.ruleset,
              scenario: field.scenario,
            });
            const coordinate = { characters, scenario: field.scenario, placement, trial };
            yield {
              slot: {
                ...coordinate,
                id: await contentHash({ ...coordinate, starts: field.starts }),
                seed,
                simulationHash: battle.simulationHash,
              },
              manifest: parseJson(ManifestSchema, battle.manifest),
            };
          }
        }
      }
    }
  }
}
