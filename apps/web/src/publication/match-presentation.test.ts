import { expect, it } from 'vite-plus/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { selectionGenerations } from '../../../../e2e/selection-fixtures.ts';
import { matchDuration, matchResult, reasonLabels, playbackLabels } from './match-presentation.ts';
import { MatchTable } from './MatchTable.tsx';

it('shows the winning character/slot and game time without turning unresolved outcomes into draws', () => {
  const row = structuredClone(selectionGenerations[0]!.rows[0]!);
  row.result = { steps: 30, outcome: { kind: 'win', winner: row.participants[1].actorId } };
  expect(matchResult(row)).toBe(
    `勝者: ${row.participants[1].character.name} (${row.participants[1].actorId})`,
  );
  expect(matchDuration(row)).toBe('30 step / 0.60秒');
  row.result.outcome = { kind: 'truncated', resource: 'events', reason: 'fixture budget' };
  expect(matchResult(row)).toBe('打ち切り・勝敗未確定');
  row.result = null;
  expect(matchResult(row)).toBe('未確定');
  expect(matchDuration(row)).toBe('終了stepなし');
});

it('renders exact participant revisions, placements, identity links and playback reasons in the table', () => {
  const generation = selectionGenerations[0]!;
  const row = generation.rows[0]!;
  const html = renderToStaticMarkup(
    createElement(MatchTable, { rows: [row], setHash: generation.setHash, page: 0 }),
  );
  for (const participant of row.participants) {
    expect(html).toContain(participant.character.id);
    expect(html).toContain(`r${participant.character.revision}`);
    expect(html).toContain(`参加枠 ${participant.actorId}`);
    expect(html).toContain(
      `${participant.position.x}, ${participant.position.y}, ${participant.position.z}`,
    );
  }
  expect(html).toContain(row.slotId.slice(7));
  expect(html).toContain(reasonLabels[row.reason]);
  expect(html).toContain(playbackLabels[row.playback]);
  expect(html).toContain('順位表ではありません');
});
