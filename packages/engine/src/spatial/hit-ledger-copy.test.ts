import { describe, expect, it } from 'vite-plus/test';
import type { StageContact } from '@fantasy/domain/spatial/execution';
import { HitLedger } from './rules/hit-ledger.ts';

const stage: StageContact = {
  actionId: 'action.1',
  stageId: 'stage.1',
  stageIndex: 0,
  emitterId: 0,
  hitGroupId: 'group.1',
};
const rule = { group: 'group.1', maxHits: 3, minIntervalSteps: 2, requireSeparation: true };

describe('copy-on-write transaction hit history', () => {
  it('keeps an empty fork isolated from later parent writes', () => {
    const parent = new HitLedger(),
      fork = parent.clone();
    parent.contact(stage, rule, 'target', 0);
    expect(fork.snapshot()).toEqual([]);
    fork.contact(stage, rule, 'other', 4);
    expect(parent.snapshot().map((entry) => entry.targetId)).toEqual(['target']);
  });
  it('isolates contact, occupancy, rejection bookkeeping and pruning in either direction', () => {
    const parent = new HitLedger();
    parent.contact(stage, rule, 'target', 0);
    const fork = parent.clone(),
      untouched = fork.clone();
    fork.occupy(stage, 'target', 1);
    expect(parent.contact(stage, rule, 'target', 2)).toEqual({
      accepted: true,
      hits: 2,
      reason: null,
    });
    expect(fork.contact(stage, rule, 'target', 2)).toEqual({
      accepted: false,
      hits: 1,
      reason: 'hit-separation',
    });
    expect(untouched.snapshot()[0]).toMatchObject({ hits: 1, lastHit: 0, lastContact: 0 });
    parent.prune(new Set());
    expect(parent.snapshot()).toEqual([]);
    expect(fork.snapshot()[0]).toMatchObject({ hits: 1, lastHit: 0, lastContact: 2 });
    fork.prune(new Set());
    expect(untouched.snapshot()).toHaveLength(1);
  });
  it('prunes multiple shared entries without skipping them and returns detached snapshots', () => {
    const ledger = new HitLedger();
    for (const actionId of ['keep', 'drop-a', 'drop-b'])
      ledger.contact({ ...stage, actionId }, rule, 'target', 0);
    const fork = ledger.clone();
    fork.prune(new Set(['keep']));
    expect(fork.snapshot().map((entry) => entry.contact.actionId)).toEqual(['keep']);
    expect(ledger.snapshot()).toHaveLength(3);
    const exported = fork.snapshot();
    exported[0]!.hits = 100;
    exported[0]!.contact.actionId = 'changed';
    expect(fork.snapshot()[0]).toMatchObject({ hits: 1, contact: { actionId: 'keep' } });
  });
});
