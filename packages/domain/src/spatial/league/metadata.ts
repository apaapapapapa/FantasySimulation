import type { LeagueDefinition, LeagueRevision } from '../league.ts';
import type { PublicLeagueSnapshot } from './publication.ts';
import { revisionIndex, requireRevision, revisionHash } from '../revision-graph.ts';
import { contentHash } from '../canonical.ts';
import { rulesetClass, type LeagueClass } from '../mechanics.ts';

export function leagueDefinitionClass(definition: LeagueDefinition): LeagueClass {
  return rulesetClass(
    requireRevision(revisionIndex(definition.revisions), 'ruleset', definition.ruleset).definition,
  );
}
/** Checksummed classification shared by offline validation and the engine-free viewer. */
export async function assertLeagueMetadata(
  snapshot: PublicLeagueSnapshot,
  revision: LeagueRevision,
  ref?: {
    id: string;
    leagueHash: string;
    inputHash: string;
    leagueClass?: LeagueClass | undefined;
  },
) {
  const { leagueHash, ...body } = revision;
  const { definition, engineVersion, implementationDigest } = revision;
  const rules = requireRevision(revisionIndex(definition.revisions), 'ruleset', definition.ruleset);
  const leagueClass = rulesetClass(rules.definition);
  if (
    leagueHash !== (await contentHash(body)) ||
    revision.inputHash !==
      (await contentHash({ definition, engineVersion, implementationDigest })) ||
    rules.contentHash !== (await revisionHash(rules)) ||
    snapshot.leagueHash !== leagueHash ||
    snapshot.inputHash !== revision.inputHash ||
    snapshot.sourceSha !== revision.sourceSha ||
    snapshot.engineVersion !== engineVersion ||
    snapshot.implementationDigest !== implementationDigest ||
    snapshot.id !== definition.id ||
    snapshot.name !== definition.name ||
    snapshot.trials !== definition.trials ||
    snapshot.masterSeed !== definition.masterSeed ||
    (snapshot.leagueClass ?? 'standard') !== leagueClass ||
    (ref &&
      (ref.id !== definition.id ||
        ref.leagueHash !== leagueHash ||
        ref.inputHash !== revision.inputHash ||
        (ref.leagueClass ?? 'standard') !== leagueClass))
  )
    throw new Error('League snapshot definition identity/class mismatch');
  return leagueClass;
}
