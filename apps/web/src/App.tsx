import { useEffect, useState } from 'react';
export function App() {
  const [status, setStatus] = useState('接続を確認しています');
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
        <p role="status">{status}</p>
        <p>
          キャラクターの登録と対戦実行はAPI・CLIから利用します。編集画面と3D観戦は次の開発段階で追加します。
        </p>
      </section>
    </main>
  );
}
