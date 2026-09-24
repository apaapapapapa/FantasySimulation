import {
  AI_RULES,
  AppearancePriorsSchema,
  LEGACY_APPEARANCE_PRIORS,
  type Revision,
} from '@fantasy/domain/spatial';

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

export const locomotionRules = {
  ...observedRules,
  id: 'standard-locomotion-v1',
  contentHash: 'sha256:e26b82bd5e29c922a35d6593612a9b9a71789ab4d619849fadf641b2442685ba',
  definition: { ...observedRules.definition, rulesVersion: 'spatial-v1.13' },
} satisfies Revision;

export const generalAiRules = {
  ...observedRules,
  id: 'standard-general-ai-v1',
  contentHash: 'sha256:3ca4c7ddbe757d26ccf9d096051e1c930940596e2e15eac46847e1557f9cdb76',
  definition: {
    ...observedRules.definition,
    rulesVersion: 'spatial-v1.14',
    ai: { ...AI_RULES, appearancePriors: AppearancePriorsSchema.parse(LEGACY_APPEARANCE_PRIORS) },
  },
} satisfies Revision;

export const simultaneousRules = {
  ...generalAiRules,
  id: 'standard-simultaneous-v1',
  contentHash: 'sha256:8c2a6cbe79e621af4ad3d3715c3f64ec6beb5a7ebaa80f5dc4140cf310117125',
  definition: {
    ...generalAiRules.definition,
    rulesVersion: 'spatial-v1.15',
    ai: { ...generalAiRules.definition.ai, slots: 'simultaneous-v1' },
  },
} satisfies Revision;

export const stagedRules = {
  ...simultaneousRules,
  id: 'standard-stages-v1',
  contentHash: 'sha256:2875785275782dce27db4839ed4f1aacd1533d5b85b419b78698bff96110f868',
  definition: { ...simultaneousRules.definition, rulesVersion: 'spatial-v1.16' },
} satisfies Revision;

export const motionRules = {
  ...simultaneousRules,
  id: 'standard-motion-v1',
  contentHash: 'sha256:20df97189317e59ee7ac872dd894d0f2a6b2a00cb7035cc64a62ba0d9c6b41dd',
  definition: { ...simultaneousRules.definition, rulesVersion: 'spatial-v1.17' },
} satisfies Revision;

export const reactionsRules = {
  ...simultaneousRules,
  id: 'standard-reactions-v1',
  contentHash: 'sha256:bbfc0d71596600236d6f391dadeb4b32b77808c4d02458be9df8652851ce35f6',
  definition: { ...simultaneousRules.definition, rulesVersion: 'spatial-v1.18' },
} satisfies Revision;
