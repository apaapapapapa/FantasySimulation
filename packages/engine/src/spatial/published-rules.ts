import { AI_RULES, type Revision } from '@fantasy/domain/spatial';

/** Immutable distributed definition; retained for reading, never historical engine execution. */
export const observedRules = {
  kind: 'ruleset',
  id: 'standard-observed-v1',
  revision: 1,
  schemaVersion: 1,
  contentHash: 'sha256:598bd6eece1645e20db3131537a10e4d4a6277bbfa268fb4d80919e80d6c8a71',
  definition: {
    name: '標準3D',
    rulesVersion: 'spatial-v1.11',
    ai: { ...AI_RULES },
    stepMs: 20,
    maxSteps: 6000,
    gravityMmPerSecond2: -9807,
    fallSafeSpeedMmPerSecond: 8000,
    fallDamagePerMeterPerSecond: 5,
    curveErrorMm: 1,
    bodyContact: 'symmetric-stop',
    aoeOcclusion: 'five-samples-equal-linear-v1',
    simultaneousConflict: 'unresolved',
  },
} satisfies Revision;

export const statusRules = {
  ...observedRules,
  id: 'standard-status-v1',
  contentHash: 'sha256:57b2217741561bbd192286a14502edf1a1a359d12a1a33885bf71d64ad01bdea',
  definition: { ...observedRules.definition, rulesVersion: 'spatial-v1.12' },
} satisfies Revision;
