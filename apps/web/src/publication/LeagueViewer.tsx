import { useCallback, useState } from 'react';
import type {
  PublicCatalog,
  PublicLeagueSnapshot,
  PublicLeagueDetail,
} from '@fantasy/domain/spatial';
import type { PublicLibrary } from '../replay/public-source.ts';
import { leagueLink, readLeagueRoute, type LeagueRoute } from './league-route.ts';
import { leagueSnapshot, leagueDetail } from './league-source.ts';
import { leagueInterval, leaguePercent } from './league-presentation.ts';
import { LeagueTable } from './LeagueTable.tsx';
import { LeaguePair } from './LeaguePair.tsx';
import { usePublicData } from './use-public-data.ts';

export function LeagueViewer({
  library,
  catalog,
  hash,
}: {
  library: PublicLibrary;
  catalog: PublicCatalog;
  hash: string;
}) {
  const route = readLeagueRoute(
    hash === '#/' && catalog.leagues?.[0] ? leagueLink(catalog.leagues[0].hash) : hash,
  );
  return route ? (
    <LeagueDocument key={route.snapshot} library={library} catalog={catalog} route={route} />
  ) : (
    <p role="alert">リーグURLの形式が不正です</p>
  );
}
function LeagueDocument({
  library,
  catalog,
  route,
}: {
  library: PublicLibrary;
  catalog: PublicCatalog;
  route: LeagueRoute;
}) {
  const read = useCallback(
    (signal: AbortSignal) => leagueSnapshot(library, route.snapshot, signal),
    [library, route.snapshot],
  );
  const data = usePublicData(read);
  if (data?.error)
    return (
      <p role="alert" className="message error">
        {data.error}
      </p>
    );
  const snapshot = data?.value;
  if (!snapshot) return <p role="status">リーグを読み込んでいます</p>;
  return (
    <>
      <section className="panel" aria-label="リーグ概要">
        <h2>{snapshot.name}</h2>
        <p>
          {snapshot.characters.length}体 · {snapshot.battlefields.length}戦場 · seed{' '}
          {snapshot.trials}試行 · 通常/交換配置
        </p>
        <p>
          {snapshot.standings.resolved.toLocaleString()} /{' '}
          {snapshot.standings.planned.toLocaleString()}枠が確定（
          {leaguePercent(snapshot.standings.completion)}）
        </p>
        <p>
          得点は今回の条件と有限の試行による結果です。すべての条件での勝率や必勝を示すものではありません。
        </p>
        <details>
          <summary>リーグの保存記録</summary>
          <p>
            リーグrevision: <code aria-label="リーグrevision">{snapshot.leagueHash}</code>
          </p>
          <p>
            snapshot: <code>{route.snapshot}</code>
          </p>
          <p>
            source: <code>{snapshot.sourceSha}</code>
          </p>
        </details>
        <a href={leagueLink(route.snapshot)}>このリーグの順位表</a>
      </section>
      {route.character ? (
        <CharacterDetail
          key={route.character}
          library={library}
          catalog={catalog}
          snapshot={snapshot}
          route={route}
        />
      ) : (
        <LeagueOverview library={library} snapshot={snapshot} hash={route.snapshot} />
      )}
    </>
  );
}
function LeagueOverview({
  library,
  snapshot,
  hash,
}: {
  library: PublicLibrary;
  snapshot: PublicLeagueSnapshot;
  hash: string;
}) {
  const [tab, setTab] = useState<'ranking' | 'fields' | 'matrix'>('ranking');
  return (
    <>
      <div className="actions" aria-label="リーグ表示">
        {(['ranking', 'fields', 'matrix'] as const).map((value, i) => (
          <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
            {['順位表', '戦場別得点', '相性表'][i]}
          </button>
        ))}
      </div>
      {tab === 'ranking' ? (
        <LeagueTable snapshot={snapshot} hash={hash} />
      ) : (
        <LeagueDetails
          library={library}
          snapshot={snapshot}
          hash={hash}
          matrix={tab === 'matrix'}
        />
      )}
    </>
  );
}
function LeagueDetails({
  library,
  snapshot,
  hash,
  matrix,
}: {
  library: PublicLibrary;
  snapshot: PublicLeagueSnapshot;
  hash: string;
  matrix: boolean;
}) {
  const read = useCallback(
    (signal: AbortSignal) =>
      Promise.all(snapshot.characters.map((c) => leagueDetail(library, snapshot, c.id, signal))),
    [library, snapshot],
  );
  const data = usePublicData(read);
  if (data?.error) return <p role="alert">{data.error}</p>;
  if (!data?.value) return <p role="status">詳細を読み込んでいます</p>;
  const label = matrix ? '相性表' : '戦場別得点';
  const fields = snapshot.battlefields.filter((field) => BigInt(field.weight.numerator) > 0n);
  return (
    <section className="panel" aria-label={label}>
      <h2>{label}</h2>
      <p>
        {matrix
          ? '行のキャラクターから見た得点です。セルを選ぶと、戦場・配置・seedごとの試合一覧を開きます。'
          : '各戦場で、相手ごとの得点を均等に平均しています。'}
      </p>
      <p>未確定の枠も分母に含めます。横にスクロールして全列を確認できます。</p>
      <table className="league-matrix" aria-label={label}>
        <thead>
          <tr>
            <th>キャラクター</th>
            {matrix
              ? snapshot.characters.map((c) => <th key={c.id}>{c.name}</th>)
              : fields.map((f) => (
                  <th key={f.scenario.id}>
                    {f.scenario.name}
                    <small>
                      重み {f.weight.numerator}/{f.weight.denominator}
                    </small>
                  </th>
                ))}
          </tr>
        </thead>
        <tbody>
          {data.value.map((detail) => (
            <tr key={detail.standing.character}>
              <th scope="row">
                {snapshot.characters.find((c) => c.id === detail.standing.character)!.name}
              </th>
              {matrix
                ? snapshot.characters.map((c) => {
                    const score = detail.standing.opponents.find(
                      (o) => o.character === c.id,
                    )?.score;
                    return (
                      <td key={c.id}>
                        {score ? (
                          <a
                            href={leagueLink(hash, detail.standing.character, c.id)}
                            aria-label={`${detail.standing.character} 対 ${c.id} の試合`}
                          >
                            {leagueInterval(score)}
                            <small>確定 {leaguePercent(score.completion)}</small>
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    );
                  })
                : fields.map((f) => (
                    <td key={f.scenario.id}>
                      {leagueInterval(
                        detail.standing.scenarios.find((s) => s.scenario === f.scenario.id)!.score,
                      )}
                    </td>
                  ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function CharacterDetail({
  library,
  catalog,
  snapshot,
  route,
}: {
  library: PublicLibrary;
  catalog: PublicCatalog;
  snapshot: PublicLeagueSnapshot;
  route: LeagueRoute;
}) {
  const read = useCallback(
    (signal: AbortSignal) => leagueDetail(library, snapshot, route.character!, signal),
    [library, snapshot, route.character],
  );
  const data = usePublicData(read);
  if (data?.error) return <p role="alert">{data.error}</p>;
  const detail = data?.value;
  if (!detail) return <p role="status">キャラクターの結果を読み込んでいます</p>;
  return route.opponent ? (
    <LeaguePair
      key={`${route.opponent}:${route.page}`}
      library={library}
      catalog={catalog}
      snapshot={snapshot}
      detail={detail}
      route={route}
    />
  ) : (
    <CharacterScores snapshot={snapshot} detail={detail} hash={route.snapshot} />
  );
}
function CharacterScores({
  snapshot,
  detail,
  hash,
}: {
  snapshot: PublicLeagueSnapshot;
  detail: PublicLeagueDetail;
  hash: string;
}) {
  return (
    <section className="panel" aria-label="キャラクター別結果">
      <h2>{snapshot.characters.find((c) => c.id === detail.standing.character)!.name}</h2>
      <p>
        総合 {leagueInterval(detail.standing.overall)} · 確定{' '}
        {leaguePercent(detail.standing.overall.completion)}
      </p>
      <h3>戦場別得点</h3>
      <dl>
        {detail.standing.scenarios.map((s) => (
          <div key={s.scenario}>
            <dt>
              {snapshot.battlefields.find((f) => f.scenario.id === s.scenario)!.scenario.name}
            </dt>
            <dd>{leagueInterval(s.score)}</dd>
          </div>
        ))}
      </dl>
      <h3>相手別の試合</h3>
      <ul>
        {detail.standing.opponents.map((o) => (
          <li key={o.character}>
            <a href={leagueLink(hash, detail.standing.character, o.character)}>
              {snapshot.characters.find((c) => c.id === o.character)!.name}:{' '}
              {leagueInterval(o.score)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
