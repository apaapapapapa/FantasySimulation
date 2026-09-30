import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

type JsonRecord = Record<string, unknown>;

const contract = JSON.parse(
  readFileSync(
    new URL('../../fixtures/spatial/illusion-visual-runtime-contract.json', import.meta.url),
    'utf8',
  ),
) as JsonRecord;

const record = (value: unknown): JsonRecord => {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
};

const array = (value: unknown): unknown[] => {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
};

describe('pending visual illusion runtime contract', () => {
  it('pins one exact catalog coordinate and the common mechanisms it needs', () => {
    expect(contract.status).toBe('pending-runtime');
    expect(contract.feature).toBe('sensory-cue-visual-v1');
    expect(record(contract.skillCoordinate)).toEqual({
      pathId: 'illusion-curse',
      zodiac: 'rat',
      dan: 3,
      plannedFixtureId: 'fixture.skill.illusion-curse.rat.3',
    });
    expect(
      array(contract.requiredMechanisms).toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        'illusion-curse-definition-v1',
        'mental-eligibility-v1',
        'perceived-target-ai-v1',
        'sensory-cue-counter-v1',
        'sensory-cue-record-replay-v1',
        'sensory-cue-visual-v1',
      ].toSorted((a, b) => a.localeCompare(b)),
    );
    expect(record(contract.implementationBoundary)).toEqual({
      directTargetMentalInterference: 'out-of-scope-pending-review',
      approvedRuntimeNumbers: false,
      fixturePurpose: 'contract-input-only',
    });
  });

  it('keeps discovery distinct from cleanse and makes terminal transitions exactly once', () => {
    const cases = array(contract.lifecycleCases).map(record);
    const discovery = cases.find((entry) => entry.id === 'discover-then-cleanse')!;
    const states = array(discovery.expectedStates).map(record);
    expect(states.find((entry) => entry.step === 5)?.state).toBe('known-false');
    expect(states.find((entry) => entry.step === 6)?.state).toBe('absent');
    expect(discovery.exactlyOnceEvents).toEqual(['emit', 'deliver', 'discover', 'cleanse']);
    expect(discovery.forbiddenEvents).toContain('expire-after-cleanse');

    const expiry = cases.find((entry) => entry.id === 'natural-expiry')!;
    expect(expiry.exactlyOnceEvents).toEqual(['emit', 'deliver', 'expire']);
    expect(array(expiry.expectedStates).map(record).at(-1)).toEqual({ step: 9, state: 'absent' });
  });

  it('does not confuse mindlessness with inability to receive a visual cue', () => {
    const target = record(contract.nonMentalTargetCase);
    expect(record(target.observer)).toMatchObject({
      mentalEligibility: 'mindless',
      sensors: ['visual'],
    });
    expect(target.mentalEffect).toEqual({ admission: 'ineligible', reason: 'mindless-target' });
    expect(target.visualCue).toEqual({
      admission: 'eligible',
      reason: 'visual-sensor-present',
    });
  });

  it('limits false evidence to the affected observer cognition without creating an actor', () => {
    const ai = record(contract.aiNoninterference);
    expect(record(ai.controlComparison)).toEqual({
      beforeDeliveryThroughStep: 2,
      mustMatch: ['decision-candidates', 'selection', 'rng-cursor', 'resources'],
    });
    expect(record(ai.affectedObserver)).toEqual({
      trustedStateMayAimAt: 'perceivedOriginMm',
      knownFalseStateMustExcludeCue: true,
      absentStateMustExcludeCue: true,
    });
    expect(Object.values(record(ai.invariants))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(array(ai.forbiddenActorEvidence)).toContain('futureRng');
  });

  it('pins subjective views and engine-free save/replay navigation for both viewers', () => {
    const views = record(contract.observationViews);
    expect(record(views.observer)).toMatchObject({
      beforeDelivery: 'absent',
      afterDelivery: 'trusted',
      afterDiscovery: 'known-false',
      afterCleanse: 'absent',
    });
    expect(record(views.creator).falseCueIsTrustedTarget).toBe(false);

    const replay = record(contract.persistenceReplay);
    expect(replay.roundTrips).toEqual(['api', 'worker', 'database', 'artifact']);
    expect(replay.viewer2d).toEqual(replay.viewer3d);
    expect(record(replay.navigation)).toEqual({
      seekStep4: 'trusted',
      seekStep5: 'known-false',
      seekStep6: 'absent',
      reverseStep6To5: 'known-false',
      loopStep3Through7LeavesResidue: false,
    });
    expect(replay.replayRunsEngine).toBe(false);
    expect(replay.replayRunsAi).toBe(false);
    expect(array(replay.tamperMustReject)).toHaveLength(6);
  });
});
