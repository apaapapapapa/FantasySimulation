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
import { api, apiRevisionPage, errorText, jsonText, reference } from '../api-client.ts';

import { recentIdentities, rememberIdentity } from './recent-identities.ts';

export function useDefinitionEditor(onPublished: () => void) {
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
  const [recent, setRecent] = useState(() => recentIdentities('drafts'));
  const [resumeId, setResumeId] = useState('');

  function remember(saved: Draft) {
    setResumeId(saved.id);
    setRecent((previous) => rememberIdentity('drafts', saved.id, previous));
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
    void apiRevisionPage(kind, cursor, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setPage(next);
      })
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
  async function validate() {
    const saved = await save();
    const checked = await api(`drafts/${saved.id}/validate`, ValidationSchema, {
      method: 'POST',
    });
    setValid(checked.valid);
    setMessage(checked.valid ? '検証に成功しました' : '検証に失敗しました');
    setError(checked.issues.join('\n'));
  }
  async function publish() {
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
  }
  async function history() {
    if (!base) return;
    const previous = await api(
      `revisions/${kind}/${encodeURIComponent(base.id)}/${historyRevision}`,
      RevisionSchema,
    );
    setMessage(jsonText(previous));
  }
  return {
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
  };
}
