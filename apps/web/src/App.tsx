import { useEffect, useState } from 'react';
import {
  BattleRecordSchema,
  CharacterSchema,
  RulesetSchema,
  type BattleRecord,
  type Character,
  type Ruleset,
} from '@fantasy/domain';
import { errorMessage, jsonBody, requestJson } from './api.ts';

export function App() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [battles, setBattles] = useState<BattleRecord[]>([]);
  const [rules, setRules] = useState<Ruleset | null>(null);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [editor, setEditor] = useState('');
  const [selected, setSelected] = useState<BattleRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      requestJson('/api/characters', CharacterSchema.array(), options),
      requestJson('/api/battles', BattleRecordSchema.array(), options),
      requestJson('/api/rules', RulesetSchema, options),
    ])
      .then(([loadedCharacters, loadedBattles, loadedRules]) => {
        if (controller.signal.aborted) return;
        setCharacters(loadedCharacters);
        setBattles(loadedBattles);
        setRules(loadedRules);
        setLeftId(loadedCharacters[0]?.id ?? '');
        setRightId(loadedCharacters[1]?.id ?? '');
        setEditor(JSON.stringify(loadedCharacters[0] ?? {}, null, 2));
        setSelected(loadedBattles[0] ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function saveCharacter() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const input: unknown = JSON.parse(editor);
      const parsed = CharacterSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`JSONを確認してください: ${issue?.path.join('.')} ${issue?.message}`);
      }
      const saved = await requestJson('/api/characters', CharacterSchema, jsonBody(parsed.data));
      setCharacters((current) =>
        [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      );
      setEditor(JSON.stringify(saved, null, 2));
      setNotice(`${saved.name}を保存しました。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runBattle() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const record = await requestJson(
        '/api/battles',
        BattleRecordSchema,
        jsonBody({ leftId, rightId }),
      );
      setSelected(record);
      setBattles((current) => [record, ...current].slice(0, 50));
      setNotice('対戦が完了し、履歴を保存しました。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <a href="/" className="brand">
          <span className="brand-icon" aria-hidden="true">
            ✦
          </span>{' '}
          FANTASY SIMULATION
        </a>
        <span className="badge">DEVELOPMENT / 01</span>
      </header>
      <section className="hero">
        <p className="eyebrow">THE SIMULATION WORKSHOP</p>
        <h1>
          世界をつくり、
          <br />
          勝負を試す。
        </h1>
        <p className="intro">
          キャラクターの設定を、再現できる対戦へ。
          <br />
          武器・魔術・特殊能力をJSONで定義する、シミュレーションの実験室。
        </p>
        <div className="metrics">
          <div>
            <strong>{characters.length.toString().padStart(2, '0')}</strong>
            <span>キャラクター</span>
          </div>
          <div>
            <strong>{battles.length.toString().padStart(2, '0')}</strong>
            <span>直近の対戦 / 最大50件</span>
          </div>
          <div>
            <strong>{rules ? `v${rules.version}` : '—'}</strong>
            <span>試験ルール</span>
          </div>
        </div>
      </section>

      {loading && <p role="status">開発環境に接続しています…</p>}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="message" role="status">
          {notice}
        </p>
      )}

      <div className="workspace">
        <div className="column">
          <section className="panel">
            <div className="section-heading">
              <span className="eyebrow">01 / CHARACTERS</span>
              <h2>キャラクター</h2>
            </div>
            <div className="characters">
              {characters.map((character, index) => (
                <article className="character" key={character.id}>
                  <div className="character-top">
                    <span className="character-number">
                      {(index + 1).toString().padStart(2, '0')}
                    </span>
                    <h3>{character.name}</h3>
                  </div>
                  <p>{character.description}</p>
                  <dl className="stats">
                    <div>
                      <dt>HP</dt>
                      <dd>{character.stats.maxHp}</dd>
                    </div>
                    <div>
                      <dt>攻撃</dt>
                      <dd>{character.stats.attack}</dd>
                    </div>
                    <div>
                      <dt>防御</dt>
                      <dd>{character.stats.defense}</dd>
                    </div>
                    <div>
                      <dt>速度</dt>
                      <dd>{character.stats.speed}</dd>
                    </div>
                  </dl>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setEditor(JSON.stringify(character, null, 2))}
                  >
                    設定を編集
                  </button>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <span className="eyebrow">02 / CHARACTER JSON</span>
              <h2>設定を追加・更新</h2>
            </div>
            <p className="muted" id="editor-help">
              新しいIDで追加、同じIDで上書きします。保存済みの対戦履歴は当時の設定を保持します。
            </p>
            <label htmlFor="character-json">キャラクター定義</label>
            <textarea
              id="character-json"
              aria-describedby="editor-help"
              value={editor}
              onChange={(event) => setEditor(event.target.value)}
              spellCheck={false}
              disabled={loading || busy}
            />
            <button
              className="secondary"
              disabled={loading || busy || !editor}
              onClick={() => void saveCharacter()}
            >
              JSONを検証して保存
            </button>
          </section>
        </div>
        <div className="column">
          <section className="panel arena">
            <div className="section-heading">
              <span className="eyebrow">03 / BATTLE ARENA</span>
              <h2>対戦をシミュレート</h2>
            </div>
            <div className="matchup">
              <label>
                キャラクター A
                <select
                  value={leftId}
                  disabled={loading || busy}
                  onChange={(event) => setLeftId(event.target.value)}
                >
                  <option value="" disabled>
                    選択してください
                  </option>
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="versus" aria-hidden="true">
                VS
              </span>
              <label>
                キャラクター B
                <select
                  value={rightId}
                  disabled={loading || busy}
                  onChange={(event) => setRightId(event.target.value)}
                >
                  <option value="" disabled>
                    選択してください
                  </option>
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="primary"
              disabled={loading || busy || !leftId || !rightId || leftId === rightId}
              onClick={() => void runBattle()}
            >
              {busy ? '処理中…' : '対戦を実行'}
              <span aria-hidden="true"> →</span>
            </button>
            <p className="muted rule-note">
              速度順に行動し、最大{rules?.maxRounds ?? '—'}
              ラウンドで判定。現在は武器・魔術・耐性・再生を扱う試験ルールです。
            </p>
          </section>
          <section className="panel">
            <div className="section-heading">
              <span className="eyebrow">04 / BATTLE LOG</span>
              <h2>対戦結果</h2>
            </div>
            {selected ? (
              <BattleDetails record={selected} />
            ) : (
              <div className="empty">
                <span aria-hidden="true">◇</span>
                <p>最初の対戦をはじめましょう。</p>
                <small>結果と行動ログをここに表示します。</small>
              </div>
            )}
          </section>
          {battles.length > 0 && (
            <section className="panel history">
              <div className="section-heading">
                <span className="eyebrow">HISTORY</span>
                <h2>保存済みの対戦</h2>
              </div>
              <ul>
                {battles.map((battle) => (
                  <li key={battle.id}>
                    <button
                      className="history-item"
                      aria-pressed={selected?.id === battle.id}
                      onClick={() => setSelected(battle)}
                    >
                      <span>
                        {battle.participants.map((character) => character.name).join(' / ')}
                      </span>
                      <small>{new Date(battle.createdAt).toLocaleString('ja-JP')}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <footer>
        Fantasy Simulation <span>React · TypeScript · Node.js · SQLite / Powered by Vite+</span>
      </footer>
    </main>
  );
}

function BattleDetails({ record }: { record: BattleRecord }) {
  const { result, participants } = record;
  const nameOf = (id: string) => participants.find((character) => character.id === id)?.name ?? id;
  return (
    <>
      <div className="result">
        <span className="eyebrow">{result.winnerId ? 'WINNER' : 'DRAW'}</span>
        <h3>{result.winnerId ? nameOf(result.winnerId) : '引き分け'}</h3>
        <p>
          {result.rounds}ラウンド / ルール v{result.rulesVersion}
          {result.reason === 'round-limit' ? ' / 上限到達' : ''}
        </p>
      </div>
      <ol className="event-log">
        {result.events.map((event, index) => (
          <li key={index}>
            <span className="round">R{event.round.toString().padStart(2, '0')}</span>
            <span>
              {event.kind === 'attack'
                ? `${nameOf(event.actorId)}の${event.actionName} → ${nameOf(event.targetId)}に${event.damage}ダメージ（残りHP ${event.remainingHp}）`
                : `${nameOf(event.actorId)}がHPを${event.recoveredHp}回復（残りHP ${event.remainingHp}）`}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
