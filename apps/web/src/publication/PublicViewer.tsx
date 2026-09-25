import { useEffect, useMemo, useState } from 'react';
import type { PublicCatalog, PublicMatchPage, PublicReplaySet } from '@fantasy/domain/spatial';
import { publicHashName } from '@fantasy/domain/spatial';
import { publicLibrary } from '../replay/public-source.ts';
import { ReplayPanel } from '../replay/ReplayPanel.tsx';
import { replayErrorText as errorText } from '../replay/load-message.ts';
import { MatchTable } from './MatchTable.tsx';
import { matchLink, readMatchRoute } from './match-route.ts';
import { playbackLabels, reasonLabels } from './match-presentation.ts';

export function PublicViewer({ root }: { root: string }) {
  return <LibraryViewer key={root} root={root} />;
}
function LibraryViewer({ root }: { root: string }) {
  const library = useMemo(() => publicLibrary(root), [root]);
  const [route, setRoute] = useState(() => readMatchRoute(window.location.hash));
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);
  const [loadedSet, setLoadedSet] = useState<{ hash: string; value: PublicReplaySet } | null>(null);
  const [loadedPage, setLoadedPage] = useState<{ hash: string; value: PublicMatchPage } | null>(
    null,
  );
  const [error, setError] = useState('');
  const setHash = route.error ? undefined : (route.setHash ?? catalog?.sets[0]?.setHash);
  const set = loadedSet && loadedSet.hash === setHash ? loadedSet.value : null;
  const page =
    set && loadedPage && loadedPage.hash === setHash && loadedPage.value.index === route.page
      ? loadedPage.value
      : null;
  const row = page?.rows.find((row) => row.slotId === route.slotId);
  const source = useMemo(() => (row?.replay ? library.source(row) : null), [library, row]);
  useEffect(() => {
    const change = () => setRoute(readMatchRoute(window.location.hash));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setError('');
    void library
      .catalog(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setCatalog(next);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [library]);
  useEffect(() => {
    if (!catalog || !setHash) return;
    const controller = new AbortController();
    setError('');
    const ref = catalog.sets.find((ref) => ref.setHash === setHash);
    if (!ref) {
      setError('指定した試合集は公開一覧にありません');
      return;
    }
    void library
      .set(ref, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setLoadedSet({ hash: setHash, value });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [library, catalog, setHash]);
  useEffect(() => {
    if (!set || !setHash) return;
    const controller = new AbortController();
    setError('');
    void library
      .page(setHash, set, route.page, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setLoadedPage({ hash: setHash, value });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [library, set, setHash, route.page]);
  return (
    <main className="app-shell">
      <header>
        <p className="eyebrow">Fantasy Simulation · Replay Library</p>
        <h1>保存リプレイ一覧</h1>
        <p>保存された試合を選んで観戦できます。</p>
        {['localhost', '127.0.0.1', '[::1]'].includes(new URL(root).hostname) && (
          <p>ローカルのデータを表示しています。このURLは他の端末との共有には使えません。</p>
        )}
      </header>
      {(error || route.error) && (
        <p role="alert" className="message error">
          {route.error || error}
        </p>
      )}
      {catalog && (
        <label>
          試合集
          <select
            value={setHash ?? ''}
            onChange={(e) => {
              window.location.hash = matchLink(e.target.value, 0);
            }}
          >
            {!setHash && <option value="">試合集を選んでください</option>}
            {catalog.sets.map((ref) => (
              <option key={ref.setHash} value={ref.setHash}>
                {publicHashName(ref.setHash).slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
      )}
      {set && setHash && (
        <section className="panel" aria-label="試合の選択">
          <h2>試合一覧</h2>
          <p>
            全{set.totalRows}件 · 未完了{set.incompleteRows}件
          </p>
          <label>
            一覧ページ
            <select
              value={route.page}
              onChange={(e) => {
                window.location.hash = matchLink(setHash, Number(e.target.value));
              }}
            >
              {set.pages.map((ref) => (
                <option key={ref.pageHash} value={ref.index}>
                  {ref.index + 1} / {set.pages.length}
                </option>
              ))}
            </select>
          </label>
          {page ? (
            <MatchTable
              key={`${setHash}:${page.index}`}
              rows={page.rows}
              setHash={setHash}
              page={page.index}
            />
          ) : (
            <p role="status">一覧を読み込んでいます</p>
          )}
        </section>
      )}
      {route.slotId && page && !row && <p role="alert">指定した試合はこのページにありません</p>}
      {row && setHash && (
        <section className="panel" aria-label="選択した試合">
          <a href={matchLink(setHash, route.page)}>試合一覧へ戻る</a>
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
      )}
      {source && <ReplayPanel key={`${setHash}:${route.slotId}`} source={source} />}
    </main>
  );
}
