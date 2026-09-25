import { PublicMatchRowSchema, publicHashName } from '@fantasy/domain/spatial';
import provenance from '../apps/web/test-fixtures/selection/provenance.json' with { type: 'json' };
import { publicFixtures } from './publication-fixtures.ts';

export const selectionFiles = publicFixtures(process.cwd(), 'selection');
export const selectionGenerations = provenance.generations.map((generation) => ({
  kind: generation.kind,
  setHash: generation.setHash,
  rows: generation.rows.map((row) => PublicMatchRowSchema.parse(row)),
}));
export function selectionUrl(setHash: string, slotId?: string) {
  return `/FantasySimulation/#/sets/${publicHashName(setHash)}/pages/0${slotId ? `/matches/${publicHashName(slotId)}` : ''}`;
}
