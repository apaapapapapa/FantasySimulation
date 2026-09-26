import {
  CURRENT_ENGINE_VERSION,
  type Definition,
  type StoredManifest,
  type MechanicId,
  type MechanicUse,
} from '@fantasy/domain/spatial/execution';
import implementation from './implementation.json' with { type: 'json' };

export type EngineInputCode =
  | 'unsupported-engine'
  | 'unsupported-ai'
  | 'unsupported-identity'
  | 'unsupported-rules'
  | 'unsupported-mechanic'
  | 'revision-content'
  | 'actor-seed'
  | 'spawn-bounds';
export class EngineInputError extends Error {
  readonly code: EngineInputCode;
  readonly mechanic?: MechanicId;
  readonly owner?: MechanicUse['owner'];
  constructor(
    code: EngineInputCode,
    message: string,
    context?: { mechanic: MechanicId; owner: MechanicUse['owner'] },
  ) {
    super(message);
    this.name = 'EngineInputError';
    this.code = code;
    if (context) {
      this.mechanic = context.mechanic;
      this.owner = context.owner;
    }
  }
}
export type ExecutionEligibility =
  | { executable: true }
  | { executable: false; code: EngineInputCode; reason: string };
export function rulesExecutionEligibility(rules: Definition<'ruleset'>): ExecutionEligibility {
  return rules.rulesVersion === CURRENT_ENGINE_VERSION && rules.ai
    ? { executable: true }
    : {
        executable: false,
        code: 'unsupported-rules',
        reason: `Unsupported rules version: saved ${rules.rulesVersion}, current ${CURRENT_ENGINE_VERSION}; select a current rules revision with an AI profile`,
      };
}
/** Admission, retry and execution share this read-only check; no historical engine is loaded. */
export function executionEligibility(manifest: StoredManifest): ExecutionEligibility {
  if (manifest.engineVersion !== CURRENT_ENGINE_VERSION)
    return {
      executable: false,
      code: 'unsupported-engine',
      reason: `Unsupported engine version: saved ${manifest.engineVersion}, current ${CURRENT_ENGINE_VERSION}`,
    };
  if (manifest.aiProfile !== 'observed-utility-v1')
    return {
      executable: false,
      code: 'unsupported-ai',
      reason: `Unsupported AI profile: ${manifest.aiProfile ?? 'legacy'}`,
    };
  if (
    manifest.implementationDigest !== implementation.digest ||
    manifest.wasmHash !== implementation.wasm ||
    manifest.angleTableHash !== implementation.table
  )
    return {
      executable: false,
      code: 'unsupported-identity',
      reason: 'Unsupported engine/physics implementation identity',
    };
  return { executable: true };
}
export function requireExecutable(eligibility: ExecutionEligibility) {
  if (!eligibility.executable) throw new EngineInputError(eligibility.code, eligibility.reason);
}
export function unsupportedExecutionReason(manifest: StoredManifest): string | null {
  const eligibility = executionEligibility(manifest);
  return eligibility.executable ? null : eligibility.reason;
}

export function requireExecutableRules(
  rules: Definition<'ruleset'>,
): asserts rules is Definition<'ruleset'> & { ai: NonNullable<Definition<'ruleset'>['ai']> } {
  requireExecutable(rulesExecutionEligibility(rules));
}
