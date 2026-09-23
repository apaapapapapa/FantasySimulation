import { useEffect, useMemo, useState } from 'react';
import { DefinitionEditor } from './workbench/DefinitionEditor.tsx';
import { BattlePanel } from './workbench/BattlePanel.tsx';
import { ReplayPanel } from './replay/ReplayPanel.tsx';
import { apiReplaySource } from './replay/api-source.ts';
export function App() {
  const [status, setStatus] = useState('接続を確認しています');
  const [revisionTick, setRevisionTick] = useState(0);
  const [replayId, setReplayId] = useState<string | null>(null);
  const replaySource = useMemo(() => (replayId ? apiReplaySource(replayId) : null), [replayId]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API unavailable');
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || !('status' in value) || value.status !== 'ok')
          throw new Error('Unexpected response');
        setStatus('APIに接続しました');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('APIに接続できません');
      });
    return () => controller.abort();
  }, []);
  return (
    <main className="app-shell">
      <header>
        <p className="eyebrow">Fantasy Simulation</p>
        <h1>3D対戦の開発環境</h1>
      </header>
      <section className="panel">
        <p role="status" aria-label="API接続">
          {status}
        </p>
        <p>設定を下書きとして検証し、新しいrevisionを公開して対戦できます。</p>
      </section>
      <div className="workspace">
        <DefinitionEditor onPublished={() => setRevisionTick((n) => n + 1)} />
        <BattlePanel revisionTick={revisionTick} onReplay={setReplayId} />
      </div>
      {replaySource && <ReplayPanel source={replaySource} />}
    </main>
  );
}
