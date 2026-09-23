import {
  canonicalJson,
  compareIds,
  type ActorDelta,
  type ActorDisplay,
  type BattleEvent,
  type Budget,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { SpatialBudgetError } from './physics.ts';
export type EventInput = Pick<BattleEvent, 'kind' | 'step' | 'phase' | 'ruleId'> &
  Partial<Omit<BattleEvent, 'id' | 'sequence' | 'schemaVersion'>>;
const phaseOrder: Record<BattleEvent['phase'], number> = {
  boundary: 0,
  declaration: 1,
  launch: 2,
  contact: 3,
  resolution: 4,
  terminal: 5,
};
const encoder = new TextEncoder();
export const recordBytes = (record: unknown) => {
  try {
    return encoder.encode(canonicalJson(record)).byteLength + 1;
  } catch (error) {
    if (error instanceof Error && /^JSON (structure|byte) budget exceeded$/.test(error.message))
      throw new SpatialBudgetError('record-encoding');
    throw error;
  }
};
/** One bounded transaction. Failed intervals discard the journal and its uncommitted IDs. */
export class Journal {
  readonly events: BattleEvent[] = [];
  private bytes = 0;
  readonly sequence: number;
  readonly priorBytes: number;
  readonly budget: Budget;
  constructor(sequence: number, priorBytes: number, budget: Budget) {
    this.sequence = sequence;
    this.priorBytes = priorBytes;
    this.budget = budget;
  }
  emit(input: EventInput): BattleEvent {
    if (this.sequence + this.events.length >= this.budget.maxEvents || this.events.length >= 50000)
      throw new SpatialBudgetError('events');
    const index = this.sequence + this.events.length;
    const event: BattleEvent = {
      schemaVersion: 1,
      id: `e.${index}`,
      sequence: index,
      actorId: null,
      targetId: null,
      entityId: null,
      parentEventId: null,
      causes: [],
      abilityId: null,
      point: null,
      before: null,
      after: null,
      amount: null,
      damage: null,
      reason: '',
      subtimeMicros: 0,
      ...input,
    };
    this.bytes += recordBytes(event);
    if (
      this.bytes > this.budget.maxFrameBytes ||
      this.priorBytes + this.bytes > this.budget.maxBytes
    )
      throw new SpatialBudgetError('log-bytes');
    this.events.push(event);
    return event;
  }
  finish<T extends StreamRecord>(record: T): { record: T; bytes: number } {
    this.events.sort(
      (a, b) =>
        a.step - b.step ||
        phaseOrder[a.phase] - phaseOrder[b.phase] ||
        a.subtimeMicros - b.subtimeMicros ||
        a.sequence - b.sequence,
    );
    this.events.forEach((event, index) => {
      event.sequence = this.sequence + index;
    });
    const bytes = recordBytes(record);
    if (bytes > this.budget.maxFrameBytes || this.priorBytes + bytes > this.budget.maxBytes)
      throw new SpatialBudgetError('log-bytes');
    return { record, bytes };
  }
}
/** Replacement deltas are sufficient to restore display state without running the engine. */
export function displayChanges(
  before: readonly ActorDisplay[],
  after: readonly ActorDisplay[],
): ActorDelta[] {
  return after
    .flatMap((actor) => {
      const previous = before.find((a) => a.id === actor.id)!;
      const delta: ActorDelta = { id: actor.id };
      for (const key of [
        'position',
        'velocity',
        'facing',
        'grounded',
        'force',
        'reactions',
        'resources',
        'locomotion',
        'statuses',
        'action',
      ] as const)
        if (canonicalJson(previous[key] ?? null) !== canonicalJson(actor[key] ?? null))
          Object.assign(delta, { [key]: actor[key] });
      return Object.keys(delta).length > 1 ? [delta] : [];
    })
    .sort((a, b) => compareIds(a.id, b.id));
}
