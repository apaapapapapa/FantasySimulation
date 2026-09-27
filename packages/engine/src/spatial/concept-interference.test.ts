import { expect, it } from 'vite-plus/test';
import { closureMechanics } from '@fantasy/domain/spatial';
import pairs from '../../fixtures/spatial/concept-pairs.json' with { type: 'json' };
import {
  interferencePairManifest,
  type ConceptInterferenceMechanic,
} from '../../test-support/interference.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';

it('executes all 420 ordered concept pairs with bounded clocks protection evasion and reading expectations', async () => {
  expect(pairs.pairs).toHaveLength(420);
  for (const [left, right] of pairs.pairs) {
    const name = `${left}/${right}`;
    const input = await interferencePairManifest(
      left as ConceptInterferenceMechanic,
      right as ConceptInterferenceMechanic,
    );
    const used = new Set(closureMechanics(input.revisions).map((use) => use.mechanic));
    expect(
      used.has(left as ConceptInterferenceMechanic) &&
        used.has(right as ConceptInterferenceMechanic),
      name,
    ).toBe(true);
    const run = await runBattle(input);
    expect(['win', 'draw'], name).toContain(run.result.outcome.kind);
    try {
      await recordedCheckpoints(input, run);
    } catch (error) {
      throw new Error(name, { cause: error });
    }
    const events = battleEvents(run.records);
    for (const activated of events.filter((event) => event.timeStop?.state === 'activated')) {
      const released = events.find(
        (event) =>
          event.timeStop?.state === 'release' &&
          event.timeStop.controlId === activated.timeStop!.controlId,
      )!;
      expect(released, name).toBeDefined();
      expect(released.step - activated.step, name).toBeLessThanOrEqual(4);
      expect(
        events.filter(
          (event) =>
            event.damage &&
            event.targetId === activated.targetId &&
            event.step > activated.step &&
            event.step < released.step,
        ),
        name,
      ).toEqual([]);
    }
    for (const reading of events.flatMap((event) =>
      event.cognition?.kind === 'knowledge' ? (event.cognition.readings ?? []) : [],
    )) {
      expect(reading.availableAt, name).toBeGreaterThanOrEqual(reading.sampledAt);
      expect(reading.expiresAt, name).toBeGreaterThan(reading.availableAt);
      if (reading.field === 'health')
        expect(reading.range.high - reading.range.low, name).toBeLessThanOrEqual(1000);
    }
    for (const [index, mechanic] of [left, right].entries()) {
      const id = index === 0 ? 'left' : 'right';
      if (mechanic === 'immortality') {
        const protects = events.filter((event) => event.actorId === id && event.immortality);
        expect(protects, name).toHaveLength(1);
        expect(protects[0], name).toMatchObject({
          step: 0,
          before: { hp: 40 },
          after: { hp: 1, shield: 0 },
          immortality: { use: 1 },
        });
      }
    }
    for (const event of events.filter((event) => event.defeat?.applied)) {
      expect(event.after!.hp, name).toBe(0);
      expect(event.damage, name).toBeNull();
      expect(
        events.some(
          (credit) => credit.ruleId === 'damage.drain' && credit.parentEventId === event.id,
        ),
        name,
      ).toBe(false);
    }
    for (const event of events.filter((event) => event.evasion)) {
      expect(event.evasion!.statuses.length, name).toBeGreaterThan(0);
      expect(
        events.some(
          (effect) =>
            effect.targetId === event.actorId &&
            effect.parentEventId === event.parentEventId &&
            (effect.damage || effect.defeat),
        ),
        name,
      ).toBe(false);
    }
    if (left === 'instant-death' && right === 'instant-death')
      expect(run.result.outcome, name).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
  }
}, 90000);
