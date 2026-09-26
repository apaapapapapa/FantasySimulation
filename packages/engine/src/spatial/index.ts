export * from './execution.ts';
export { implementation, profile, reference, revisionHash } from './prepare.ts';
export type { PreparedBattle } from './state.ts';
export type { SimulationEnd } from './simulate.ts';
export { ManifestBuilder, deriveParticipants, sealRevision } from './manifest-builder.ts';
export type { ManifestInput } from './manifest-builder.ts';
export {
  EngineInputError,
  executionEligibility,
  rulesExecutionEligibility,
  requireExecutable,
  requireExecutableRules,
  unsupportedExecutionReason,
} from './execution-policy.ts';
export type { EngineInputCode, ExecutionEligibility } from './execution-policy.ts';
export { requireMechanics } from './mechanic-policy.ts';
export {
  createLeagueRevision,
  validateLeagueRevision,
  validateStoredLeagueRevision,
  normalizeLeagueDefinition,
  normalizeStoredLeagueDefinition,
  leagueDefinitionHash,
  leagueTrialSeed,
  leagueMatches,
  leagueCoordinates,
} from '../league/index.ts';
export {
  aggregateLeague,
  aggregateStoredLeague,
  scoreLeagueCounts,
  compareLeagueFractions,
} from '../league/scoring.ts';
