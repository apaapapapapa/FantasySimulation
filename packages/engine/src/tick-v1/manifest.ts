import {
  canonicalJson,
  deepFreeze,
  hashJson,
  TickBattleDraftSchema,
  validateTickManifest,
} from '@fantasy/domain/tick-v1';
import implementation from './implementation.json' with { type: 'json' };

export const TICK_ENGINE = Object.freeze({
  id: 'tick-v1' as const,
  version: '0.2.0' as const,
  implementationDigest: implementation.digest,
});

export const TICK_RULES = Object.freeze({
  id: 'tick-v1' as const,
  version: '0.2.0' as const,
  speedScale: 100 as const,
  maxDelayTicks: 1_000_000 as const,
  probabilityScale: 10_000 as const,
  certainHitVsCertainEvade: 'unresolved' as const,
});

/** Resolve revisions before calling this boundary. No mutable registry lookup occurs here. */
export async function createTickManifest(input: unknown) {
  canonicalJson(input);
  const draft = TickBattleDraftSchema.parse(input);
  return validateTickManifest({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    canonicalization: 'canonical-json-v1',
    engine: TICK_ENGINE,
    random: {
      algorithm: 'xorshift32-13-17-5-v1',
      streamDerivation: 'character-sha256-v1',
      seed: draft.seed,
    },
    participants: draft.participants,
    rules: draft.rules,
    scenario: draft.scenario,
  });
}

export async function prepareTickBattle(input: unknown) {
  const manifest = await validateTickManifest(input);
  if (manifest.engine.implementationDigest !== TICK_ENGINE.implementationDigest) {
    throw new Error('Engine implementation digest mismatch; load the matching archived engine');
  }
  return deepFreeze({ manifest, simulationHash: await hashJson(manifest) });
}
