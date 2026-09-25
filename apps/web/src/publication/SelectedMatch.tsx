import { useMemo } from 'react';
import type { PublicMatchRow } from '@fantasy/domain/spatial';
import type { PublicLibrary } from '../replay/public-source.ts';
import { ReplayPanel } from '../replay/ReplayPanel.tsx';
import { playbackLabels, reasonLabels } from './match-presentation.ts';

export function SelectedMatch({
  library,
  row,
  back,
}: {
  library: PublicLibrary;
  row: PublicMatchRow;
  back: string;
}) {
  const source = useMemo(() => (row.replay ? library.source(row) : null), [library, row]);
  return (
    <>
      <section className="panel" aria-label="選択した試合">
        <a href={back}>試合一覧へ戻る</a>
        <p>
          {row.state} · {reasonLabels[row.reason]} · {playbackLabels[row.playback]}
        </p>
        <p>
          予定枠: <code aria-label="選択した予定枠">{row.slotId}</code>
        </p>
        {row.replay && (
          <details>
            <summary>この試合の保存記録</summary>
            <dl>
              <dt>bundle</dt>
              <dd>
                <code aria-label="選択したbundle">{row.replay.objectHash}</code>
              </dd>
              <dt>result</dt>
              <dd>
                <code aria-label="選択したresult">{row.replay.resultId}</code>
              </dd>
              <dt>attempt</dt>
              <dd>
                <code aria-label="選択したattempt">{row.replay.attemptId}</code>
              </dd>
            </dl>
          </details>
        )}
      </section>
      {source && <ReplayPanel key={`${row.slotId}:${row.replay!.objectHash}`} source={source} />}
    </>
  );
}
