import {
  compareIds,
  type DeepReadonly,
  type Stage,
  type StageContact,
} from '@fantasy/domain/spatial/execution';

type Entry = {
  contact: StageContact;
  targetId: string;
  hits: number;
  lastHit: number;
  lastContact: number;
};
/** A new stage gets a new key; emitters in one group share contacts, including zero damage. */
export class HitLedger {
  private readonly entries = new Map<string, Entry>();
  clone() {
    const copy = new HitLedger();
    for (const [key, value] of this.entries) copy.entries.set(key, { ...value });
    return copy;
  }
  contact(contact: StageContact, rule: DeepReadonly<Stage['hit']>, targetId: string, step: number) {
    const key = JSON.stringify([contact.actionId, contact.stageId, contact.hitGroupId, targetId]);
    const prior = this.entries.get(key);
    const reason = !prior
      ? null
      : prior.hits >= (rule?.maxHits ?? 1)
        ? 'hit-limit'
        : step - prior.lastHit < (rule?.minIntervalSteps ?? 1)
          ? 'hit-interval'
          : rule?.requireSeparation && step - prior.lastContact <= 1
            ? 'hit-separation'
            : null;
    const accepted = reason === null;
    const entry = {
      contact,
      targetId,
      hits: (prior?.hits ?? 0) + Number(accepted),
      lastHit: accepted ? step : prior!.lastHit,
      lastContact: step,
    };
    this.entries.set(key, entry);
    return { accepted, hits: entry.hits, reason };
  }
  occupy(contact: StageContact, targetId: string, step: number) {
    const key = JSON.stringify([contact.actionId, contact.stageId, contact.hitGroupId, targetId]);
    const prior = this.entries.get(key);
    if (prior) this.entries.set(key, { ...prior, lastContact: step });
  }
  prune(actions: ReadonlySet<string>) {
    for (const [key, entry] of this.entries)
      if (!actions.has(entry.contact.actionId)) this.entries.delete(key);
  }
  snapshot() {
    return [...this.entries]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([, entry]) => ({ ...entry, contact: { ...entry.contact } }));
  }
}
