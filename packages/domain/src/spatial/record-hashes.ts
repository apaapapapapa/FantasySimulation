import { canonicalJson } from './canonical.ts';
import { encodeNumericState } from './numeric.ts';
import type { BattleEvent } from './records.ts';
import type { StreamRecord } from './stream.ts';

export const eventHashLine = (event: BattleEvent): string =>
  `${canonicalJson(encodeNumericState(event))}\n`;
export const trajectoryHashLine = (record: StreamRecord): string => {
  const { events: _, ...display } = 'events' in record ? record : { ...record, events: [] };
  return `${canonicalJson(encodeNumericState(display))}\n`;
};
