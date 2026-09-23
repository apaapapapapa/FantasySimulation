import { useEffect, useState } from 'react';
import {
  DraftSchema,
  DraftInputSchema,
  DraftPatchSchema,
  PublishResponseSchema,
  RevisionPageSchema,
  RevisionSchema,
  ValidationSchema,
  IdSchema,
  type Draft,
  type Revision,
} from '@fantasy/domain/spatial';
import { api, errorText, jsonText, reference } from '../api-client.ts';

const recentKey = 'fantasy.recent-drafts';
function recentDrafts(): string[] {
  try {
    return IdSchema.array()
      .max(20)
      .parse(JSON.parse(localStorage.getItem(recentKey) ?? '[]'));
  } catch {
    return [];
  }
}

export function DefinitionEditor({ onPublished }: { onPublished(): void }) {
  const [kind, setKind] = useState<'character' | 'ability'>('character');
  const [page, setPage] = useState<ReturnType<typeof RevisionPageSchema.parse>>({
    items: [],
    nextCursor: null,
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [base, setBase] = useState<Revision | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [id, setId] = useState('');
  const [definition, setDefinition] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('公開済みの設定を選んで編集できます。');
  const [error, setError] = useState('');
  const [valid, setValid] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(1);
  const [recent, setRecent] = useState(recentDrafts);
  const [resumeId, setResumeId] = useState('');

  function remember(saved: Draft) {
    setResumeId(saved.id);
    setRecent((previous) => {
      const next = [saved.id, ...previous.filter((id) => id !== saved.id)].slice(0, 20);
      try {
        localStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        // The displayed ID still allows retrieval when browser storage is unavailable.
      }
      return next;
    });
  }
  async function resume(value: string) {
    const saved = await api(`drafts/${encodeURIComponent(IdSchema.parse(value))}`, DraftSchema);
    if (saved.kind !== 'character' && saved.kind !== 'ability')
      throw new Error('この画面ではキャラクターと能力の下書きを編集できます');
    const ref = saved.published ?? saved.base;
    const original = ref
      ? await api(
          `revisions/${saved.kind}/${encodeURIComponent(ref.id)}/${ref.revision}`,
          RevisionSchema,
        )
      : null;
    setKind(saved.kind);
    setCursor(null);
    setBase(original);
    setDraft(saved);
    setId(saved.definitionId);
    setDefinition(jsonText(saved.definition));
    setHistoryRevision(original?.revision ?? 1);
    setValid(false);
    remember(saved);
    setMessage(`下書きを再開しました（版 ${saved.version}）`);
  }

  useEffect(() => {
    const controller = new AbortController();
    setPage({ items: [], nextCursor: null });
    void api(
      `revisions/${kind}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      RevisionPageSchema,
      { signal: controller.signal },
    )
      .then(setPage)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [kind, cursor, reload]);

  function select(revision: Revision) {
    setBase(revision);
    setDraft(null);
    setId(revision.id);
    setDefinition(jsonText(revision.definition));
    setHistoryRevision(revision.revision);
    setValid(false);
    setError('');
    setMessage(`revision ${revision.revision} を編集中。公開済みの版は保持されます。`);
  }
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setValid(false);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const value: unknown = JSON.parse(definition);
    const saved = draft
      ? await api(`drafts/${draft.id}`, DraftSchema, {
          method: 'PATCH',
          body: DraftPatchSchema.parse({ expectedVersion: draft.version, definition: value }),
        })
      : await api('drafts', DraftSchema, {
          method: 'POST',
          body: DraftInputSchema.parse({
            kind,
            definitionId: id,
            base: base ? reference(base) : null,
            definition: value,
          }),
        });
    setDraft(saved);
    remember(saved);
    setValid(false);
    setMessage(`下書きを保存しました（版 ${saved.version}）`);
    return saved;
  }
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
                const saved = await save();
                const checked = await api(`drafts/${saved.id}/validate`, ValidationSchema, {
                  method: 'POST',
                });
                setValid(checked.valid);
                setMessage(checked.valid ? '検証に成功しました' : '検証に失敗しました');
                setError(checked.issues.join('\n'));
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
                const published = await api(`drafts/${draft!.id}/publish`, PublishResponseSchema, {
                  method: 'POST',
                  body: { expectedVersion: draft!.version },
                });
                select(published.revision);
                setDraft(published.draft);
                remember(published.draft);
                setMessage(`revision ${published.revision.revision} を公開しました`);
                setReload((n) => n + 1);
                onPublished();
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
                  const previous = await api(
                    `revisions/${kind}/${encodeURIComponent(base.id)}/${historyRevision}`,
                    RevisionSchema,
                  );
                  setMessage(jsonText(previous));
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
