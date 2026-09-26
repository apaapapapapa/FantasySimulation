import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReplayPanel } from './ReplayPanel.tsx';
import { replayErrorText } from './load-message.ts';
import {
  exportLocalReplay,
  localReplaySource,
  readLocalFiles,
  type LocalReplay,
} from './local-source.ts';
import {
  deleteStoredReplay,
  listStoredReplays,
  loadStoredReplay,
  LocalStoreError,
  storeReplay,
  type StoredReplay,
} from './local-store.ts';

function storeText(error: unknown) {
  if (!(error instanceof LocalStoreError)) return replayErrorText(error);
  return {
    quota:
      'ブラウザーの保存容量が足りません。不要な保存を削除するか、書き出したファイルを保管してください',
    unavailable: 'このブラウザーでは端末内への保存を利用できません（プライベートモード等）',
    missing: '保存したリプレイが見つかりません。ブラウザーにより削除された可能性があります',
  }[error.kind];
}
function download(replay: LocalReplay) {
  const url = URL.createObjectURL(
    new Blob([exportLocalReplay(replay)], { type: 'application/x-tar' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${replay.manifest.id}.replay.tar`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * View replay files from this device without publishing them. Selected bytes stay in this
 * browser; the optional IndexedDB copy is a convenience, never the only backup.
 */
export function LocalReplays() {
  const [replay, setReplay] = useState<LocalReplay | null>(null);
  const [saved, setSaved] = useState<StoredReplay[] | null>(null);
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const source = useMemo(() => (replay ? localReplaySource(replay) : null), [replay]);
  const refresh = useCallback(async () => {
    try {
      setSaved(await listStoredReplays());
    } catch (error) {
      setSaved(null);
      setStatus(storeText(error));
    }
  }, []);
  useEffect(() => {
    let live = true;
    listStoredReplays().then(
      (rows) => live && setSaved(rows),
      (error: unknown) => live && setStatus(storeText(error)),
    );
    return () => {
      live = false;
    };
  }, []);
  // Only the latest selection may replace the shown replay.
  const selection = useRef(0);
  async function choose(files: FileList | null) {
    setError('');
    setStatus('');
    if (!files?.length) return;
    const current = ++selection.current;
    try {
      const opened = await readLocalFiles([...files]);
      if (current !== selection.current) return;
      setReplay(opened);
      if (keep) {
        try {
          await storeReplay(opened);
          setStatus('この端末に保存しました');
        } catch (error) {
          setStatus(`保存できませんでした: ${storeText(error)}`);
        }
        await refresh();
      }
    } catch (error) {
      if (current !== selection.current) return;
      setReplay(null);
      setError(replayErrorText(error));
    }
  }
  async function act(work: () => Promise<void>) {
    setError('');
    setStatus('');
    try {
      await work();
    } catch (error) {
      setError(storeText(error));
    }
  }
  return (
    <>
      <section className="panel" aria-label="ローカルファイル">
        <h2>ローカルファイルで観戦</h2>
        <p>
          選んだファイルはこのブラウザーの中だけで検証・再生し、送信や公開はしません。公開済みの試合一覧や正式なランキングには加わりません。
        </p>
        <label>
          リプレイのファイル（manifest.jsonとchunk/checkpointの.gzをまとめて選ぶ、または書き出した.tar）
          <input
            type="file"
            multiple
            accept=".json,.gz,.tar,application/json,application/gzip,application/x-tar"
            onChange={(e) => {
              void choose(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <label>
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          読み込んだリプレイをこの端末（ブラウザー）にも保存する
        </label>
        <p>
          端末内の保存は補助です。容量不足やブラウザーの判断で消えることがあるため、必要なリプレイは書き出したファイルで保管してください。
        </p>
        {error && (
          <p role="alert" className="message error">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="message">
            {status}
          </p>
        )}
        {replay && (
          <div className="actions">
            <button onClick={() => download(replay)}>表示中のリプレイを書き出す</button>
          </div>
        )}
        {saved && (
          <table aria-label="端末に保存したリプレイ">
            <thead>
              <tr>
                {['リプレイID', '結果', '記録済みstep', 'サイズ', '保存日時', '操作'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {saved.map((row) => (
                <tr key={row.key}>
                  <td>{row.replayId}</td>
                  <td>{row.outcome}</td>
                  <td>{row.lastVerifiedStep ?? '—'}</td>
                  <td>{row.bytes.toLocaleString()} bytes</td>
                  <td>{new Date(row.savedAt).toLocaleString()}</td>
                  <td className="actions">
                    <button
                      aria-label={`開く ${row.replayId}`}
                      onClick={() =>
                        void act(async () => setReplay(await loadStoredReplay(row.key)))
                      }
                    >
                      開く
                    </button>
                    <button
                      aria-label={`書き出す ${row.replayId}`}
                      onClick={() =>
                        void act(async () => download(await loadStoredReplay(row.key)))
                      }
                    >
                      書き出す
                    </button>
                    <button
                      aria-label={`削除 ${row.replayId}`}
                      onClick={() =>
                        void act(async () => {
                          await deleteStoredReplay(row.key);
                          setStatus('端末から削除しました');
                          await refresh();
                        })
                      }
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
              {!saved.length && (
                <tr>
                  <td colSpan={6}>端末に保存したリプレイはありません</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
      {source && replay && <ReplayPanel key={replay.key} source={source} local />}
    </>
  );
}
