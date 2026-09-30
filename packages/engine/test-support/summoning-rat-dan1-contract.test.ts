import { expect, it } from 'vite-plus/test';
import fixture from '../fixtures/spatial/summoning-rat-dan1.json' with { type: 'json' };

it('keeps the partial rat dan-one runtime separate from catalog availability', () => {
  expect(fixture.status).toBe('runtime-pending');
  expect(fixture.availableClaim).toBe(false);
  expect(fixture.catalogNodeId).toBe('skill.summoning.rat.1');
  expect(fixture.input.participants.map(({ slot }) => slot)).toEqual(['A', 'B']);
  expect(fixture.expected.participantCount).toBe(2);
  expect(fixture.expected.ownership).toEqual({
    alliedWith: 'A',
    hostileToOwnerOf: 'B',
    canTransfer: false,
    canNest: false,
    canWin: false,
  });
  expect(fixture.missingRuntimeMechanisms).toEqual([
    'dependent-targeting-and-hp-damage',
    'non-noop-dependent-drain-healing',
    'same-wave-owner-guard-revival-dependent-hp-settlement',
    'terminal-owner-defeat-verdict-numeric-fixture',
  ]);
  expect(fixture.runtimeEvidence).toEqual([
    'packages/engine/src/spatial/dependents.test.ts',
    'apps/api/src/jobs/dependent-persistence.test.ts',
    'apps/web/src/replay/dependent-display.test.ts',
  ]);
});

it('pins ordinal RNG, subject time, and command observation without hidden-state leakage', () => {
  expect(fixture.input.rngIdentity.tuple).toEqual([
    'seed',
    'owner-slot',
    'committed-ordinal',
    'entity-id',
    'purpose',
  ]);
  expect(fixture.input.rngIdentity.mustNotInclude).toEqual([
    'entity-enumeration-index',
    'command-order',
  ]);
  expect(fixture.input.clockProbe).toMatchObject({
    freezeSubject: true,
    expectedNextActionAt: 300,
    expectedLifetimeEndsAt: 1100,
    expectedUpkeepSteps: [300, 400],
  });
  expect(fixture.expected.clockProbe).toEqual({
    subjectActionClockPaused: true,
    lifetimeAdvanced: true,
    upkeepAdvanced: true,
  });
  expect(fixture.input.observedCommand.deliveredObservation.visibleEntityIds).toContain(
    fixture.input.observedCommand.command.targetEntityId,
  );
  expect(fixture.expected.command).toMatchObject({
    accepted: true,
    canonicalHiddenStateRead: false,
  });
});

it('keeps unresolved simultaneous settlement ordering explicit without fabricated numbers', () => {
  expect(fixture.expected.pendingSettlementOrder).toEqual([
    'collect-simultaneous-guard-and-drain',
    'resolve-revival',
    'commit-dependent-and-participant-hp',
    'despawn-dependents-of-terminally-defeated-owner',
    'compute-participant-win-or-draw',
  ]);
});

it('requires the same dependent records through storage and reversible 2D/3D replay', () => {
  expect(fixture.expected.records).toEqual([
    'dependent-create',
    'dependent-command',
    'dependent-act',
    'dependent-damage',
    'participant-revival',
    'dependent-despawn',
    'battle-result',
  ]);
  expect(fixture.expected.roundTripSurfaces).toEqual([
    'saved-manifest',
    'api',
    'worker',
    'sqlite',
    'replay',
    'viewer-2d',
    'viewer-3d',
  ]);
  expect(fixture.expected.replayOperations).toEqual(['forward', 'seek', 'reverse']);
  expect(fixture.expected.replayRule).toBe('consume-records-without-rerunning-ai');
  expect(fixture.expected.legacyOmission).toBe('preserve-existing-two-participant-behavior');
  expect(fixture.expected.rollback).toBe(
    'disable-new-execution-and-publication-without-rewriting-saved-data',
  );
});
