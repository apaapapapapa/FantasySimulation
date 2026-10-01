import { describe, expect, it } from 'vite-plus/test';
import contractJson from '../../fixtures/spatial/environmental-hologram-runtime-contract.json' with { type: 'json' };

const contract = contractJson;

describe('pending environmental hologram runtime contract', () => {
  it('keeps sensor-only delivery distinct from the cognitive sensory cue', () => {
    expect(contract.status).toBe('pending-runtime');
    expect(contract.purpose).toBe('design-and-evidence-boundary-only');
    expect(contract.existingMechanism).toEqual({
      effect: 'sensory-cue',
      scope: 'cognitive-observer-mind',
      nonCognitiveAdmission: 'rejected',
      maySatisfyThisContract: false,
    });
    expect(contract.requiredRuntimeBoundary).toMatchObject({
      proposedEffect: 'environmental-hologram',
      scope: 'visual-sensor-observers',
      mentalEligibilityRequired: false,
      canonicalCombatActor: false,
      stateOwner: 'observer-sensor-view-not-mind-state',
      requiresNewSchemaFeature: true,
    });
  });

  it('requires sensor eligibility rather than mental eligibility', () => {
    const observers = contract.acceptanceObservers;
    expect(observers.find(({ id }) => id === 'mindless-visual')).toMatchObject({
      mentalEligibility: 'non-cognitive',
      sensors: ['visual'],
      expectedObservation: 'hologram-visible',
    });
    expect(observers.find(({ id }) => id === 'cognitive-no-visual')).toMatchObject({
      mentalEligibility: 'cognitive',
      sensors: [],
      expectedObservation: 'hologram-absent',
    });
  });

  it('binds promotion to actual runtime state event replay display and seek evidence', () => {
    const evidence = contract.requiredEvidence;
    expect(Object.keys(evidence).toSorted()).toEqual(
      ['observerAi', 'persistence', 'replay', 'seek', 'viewer2d3d'].toSorted(),
    );
    const gate = contract.implementationGate;
    expect(gate).toMatchObject({
      approvedRuntimeNumbers: false,
      catalogAvailabilityAllowed: false,
      expectationOnlyPromotionAllowed: false,
    });
    expect(gate.requiredBeforePromotion).toEqual([
      'actual engine state assertions',
      'actual event assertions',
      'actual persisted replay assertions',
      'actual 2D and 3D render assertions',
      'actual forward reverse and loop seek assertions',
      'independent review',
    ]);
  });

  it('reserves shared engine schema and issue 189 budget files', () => {
    expect(contract.ownershipBoundary).toEqual({
      commonEngineAndSchema: 'defer-until-dependent-summon-merge',
      publicationBudgetSchema: 'issue-189-owned-do-not-edit',
      leagueBudget: 'issue-189-owned-do-not-edit',
    });
  });
});
