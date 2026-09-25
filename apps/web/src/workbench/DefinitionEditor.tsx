import { jsonText } from '../api-client.ts';
import { useDefinitionEditor } from './useDefinitionEditor.ts';
export function DefinitionEditor({ onPublished }: { onPublished(): void }) {
  const {
    kind,
    setKind,
    page,
    cursor,
    setCursor,
    setReload,
    base,
    setBase,
    draft,
    setDraft,
    id,
    setId,
    definition,
    setDefinition,
    busy,
    message,
    setMessage,
    error,
    setError,
    valid,
    setValid,
    historyRevision,
    setHistoryRevision,
    recent,
    resumeId,
    setResumeId,
    resume,
    select,
    work,
    save,
    validate,
    publish,
    history,
  } = useDefinitionEditor(onPublished);
  return (
    <section className="panel" aria-label="設定の編集">
      <h2>キャラクター・能力の編集</h2>
      <fieldset disabled={busy}>
        <details>
          <summary>保存した下書きを再開</summary>
          <label>
            再開する下書きID
            <input value={resumeId} onChange={(e) => setResumeId(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!resumeId}
            onClick={() => void work(() => resume(resumeId))}
          >
            IDから再開
          </button>
          <ul aria-label="最近保存した下書き">
            {recent.map((value) => (
              <li key={value}>
                <button type="button" onClick={() => void work(() => resume(value))}>
                  {value}
                </button>
              </li>
            ))}
          </ul>
        </details>
        {draft && <output aria-label="保存済み下書きID">{draft.id}</output>}
        <label>
          設定の種類
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
              setCursor(null);
              setBase(null);
              setDraft(null);
              setId('');
              setDefinition('{}');
              setValid(false);
              setError('');
            }}
          >
            <option value="character">キャラクター</option>
            <option value="ability">能力</option>
          </select>
        </label>
        <ul className="revision-list">
          {page.items.map((revision) => (
            <li key={`${revision.id}:${revision.revision}`}>
              <button
                type="button"
                className="secondary"
                onClick={() => select(revision)}
                aria-pressed={base?.id === revision.id}
              >
                {revision.definition.name} · {revision.id} · r{revision.revision}
              </button>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" disabled={!cursor} onClick={() => setCursor(null)}>
            最初のページ
          </button>
          <button
            type="button"
            disabled={!page.nextCursor}
            onClick={() => setCursor(page.nextCursor)}
          >
            次のページ
          </button>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            一覧を更新
          </button>
        </div>
        <label>
          設定ID
          <input
            value={id}
            disabled={base !== null || draft !== null}
            onChange={(e) => {
              setId(e.target.value);
              setValid(false);
            }}
          />
        </label>
        <button
          type="button"
          disabled={!base}
          onClick={() => {
            setId(`${base!.id}.copy`);
            setBase(null);
            setDraft(null);
            setValid(false);
            setMessage('新しいIDを入力して保存してください。');
          }}
        >
          新規IDで複製
        </button>
        <label>
          定義JSON
          <textarea
            value={definition}
            spellCheck={false}
            onChange={(e) => {
              setDefinition(e.target.value);
              setValid(false);
            }}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              void work(async () => {
                await save();
              })
            }
          >
            下書きを保存
          </button>
          <button
            type="button"
            onClick={() =>
              void work(async () => {
                await validate();
              })
            }
          >
            保存して検証
          </button>
          <button
            type="button"
            disabled={!draft || !valid}
            onClick={() =>
              void work(async () => {
                await publish();
              })
            }
          >
            新revisionを公開
          </button>
        </div>
        {base && (
          <details>
            <summary>公開revisionとの比較</summary>
            <p>
              編集元 r{base.revision} / 現在のJSON{' '}
              {definition === jsonText(base.definition) ? '変更なし' : '変更あり'}
            </p>
            <pre>{jsonText(base.definition)}</pre>
            <label>
              参照するrevision
              <input
                type="number"
                min="1"
                max={base.revision}
                value={historyRevision}
                onChange={(e) => setHistoryRevision(Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void work(async () => {
                  await history();
                })
              }
            >
              公開済みrevisionを参照
            </button>
          </details>
        )}
      </fieldset>
      <pre className="message" role="status" aria-label="編集の状態">
        {message}
      </pre>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
    </section>
  );
}
