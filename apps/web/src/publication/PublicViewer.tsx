import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublicCatalog, PublicMatchPage, PublicReplaySet } from '@fantasy/domain/spatial';
import { publicHashName } from '@fantasy/domain/spatial';
import { publicLibrary, type PublicLibrary } from '../replay/public-source.ts';
import { replayErrorText as errorText } from '../replay/load-message.ts';
import { MatchTable } from './MatchTable.tsx';
import { matchLink, readMatchRoute } from './match-route.ts';
import { SelectedMatch } from './SelectedMatch.tsx';
import { LeagueViewer } from './LeagueViewer.tsx';
import { leagueLink } from './league-route.ts';
import { usePublicData } from './use-public-data.ts';
import { LocalReplays } from '../replay/LocalReplays.tsx';
import { PageHeader, PageFooter } from '../components/PageHeader.tsx';

/** A separate route: files from this device never mix with published matches or rankings. */
export const LOCAL_ROUTE = '#/local';

export function PublicViewer({ root }: { root: string }) {
  return <LibraryViewer key={root} root={root} />;
}
function LibraryViewer({ root }: { root: string }) {
  const library = useMemo(
    () =>
      publicLibrary(
        root,
        fetch,
        new URLSearchParams(window.location.search).get('publication-metrics') === '1'
          ? (value) => console.info('FANTASY_PUBLICATION_READ ' + JSON.stringify(value))
          : undefined,
      ),
    [root],
  );
  const [hash, setHash] = useState(window.location.hash);
  const read = useCallback((signal: AbortSignal) => library.catalog(signal), [library]);
  const loaded = usePublicData(read);
  const catalog = loaded?.value;
  const local = hash === LOCAL_ROUTE;
  const league =
    !local &&
    (hash.startsWith('#/leagues/') || ((!hash || hash === '#/') && !!catalog?.leagues?.length));
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return (
    <main className="app-shell" id="app-top">
      <PageHeader
        title={local ? 'ローカルファイルの観戦' : league ? 'リーグ結果' : '保存リプレイ一覧'}
        eyebrow={
          local
            ? 'YOUR PERSONAL ARCHIVE'
            : league
              ? 'THE LEAGUE CHRONICLES'
              : 'EVERY BATTLE, A STORY'
        }
        description="戦略が交わる、その瞬間を。記録された戦いと、それぞれの軌跡をたどる。"
        mode="public"
      >
        {['localhost', '127.0.0.1', '[::1]'].includes(new URL(root).hostname) && (
          <p>ローカルのデータを表示しています。このURLは他の端末との共有には使えません。</p>
        )}
        {catalog && (
          <nav className="archive-nav" aria-label="公開データ">
            {catalog.leagues?.map((ref) => (
              <a
                key={ref.id}
                href={leagueLink(ref.hash)}
                aria-current={
                  league &&
                  (hash.includes(publicHashName(ref.hash)) ||
                    ((!hash || hash === '#/') && ref === catalog.leagues?.[0]))
                    ? 'page'
                    : undefined
                }
              >
                {ref.id}
                {ref.leagueClass === 'experimental' ? '（実験）' : ''}
              </a>
            ))}
            {catalog.sets[0] && (
              <a
                href={matchLink(catalog.sets[0].setHash, 0)}
                aria-current={!local && !league ? 'page' : undefined}
              >
                保存リプレイ一覧
              </a>
            )}
          </nav>
        )}
        <p className="local-file-link">
          <a href={LOCAL_ROUTE}>手元のリプレイファイルを開く（公開しない）</a>
        </p>
      </PageHeader>
      {loaded?.error && !local && (
        <p role="alert" className="message error">
          {loaded.error}
        </p>
      )}
      {local ? <LocalReplays /> : !loaded && <p role="status">公開一覧を読み込んでいます</p>}
      {catalog &&
        !local &&
        (league ? (
          <LeagueViewer library={library} catalog={catalog} hash={hash || '#/'} />
        ) : (
          <MatchViewer library={library} catalog={catalog} hash={hash} />
        ))}
      <PageFooter />
    </main>
  );
}
function MatchViewer({
  library,
  catalog,
  hash,
}: {
  library: PublicLibrary;
  catalog: PublicCatalog;
  hash: string;
}) {
  const route = readMatchRoute(hash);
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
      .set(ref, catalog.schemaVersion, controller.signal)
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
    <>
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
        <SelectedMatch
          library={library}
          row={row}
          back={matchLink(setHash, route.page)}
          step={route.step}
          stepLink={(step) => matchLink(setHash, route.page, row.slotId, step)}
        />
      )}
    </>
  );
}
