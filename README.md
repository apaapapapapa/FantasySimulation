# FantasySimulation

能力・装備・戦闘AIを定義し、seed付きの3D対戦を実行する開発基盤です。
公開revision・下書きAPI、非同期ジョブ、圧縮リプレイ保存、headlessバッチを利用できます。
画面は接続状態の表示までで、編集・対戦・観戦UIは後続開発です。
認証のないローカル開発用です。公開運用には認証とデプロイ設計が必要です。

## 開始

Gitと[Vite+](https://viteplus.dev/guide/)を用意して実行します。

```sh
git clone https://github.com/apaapapapapa/FantasySimulation.git
cd FantasySimulation
vp install --frozen-lockfile
vp run dev
```

画面は <http://127.0.0.1:5173>、API確認は <http://127.0.0.1:3001/api/health>。
`Ctrl+C`で停止します。`vp dev`は画面だけのため、両方の起動には`vp run dev`を使います。
Nodeは[.node-version](.node-version)、pnpmと依存版は[package.json](package.json)が正本です。

初回起動でDrizzle migrationとサンプル15体を登録します。
保存先は`data/fantasy.sqlite`と`data/replays`。設定は[.env.example](.env.example)、
既存DBの移行前は[移行制約](docs/adr/0005-drizzle-kit.md)を確認してください。

## コマンド

- `vp run verify`: 静的検査・テスト・コーパス・負荷予算・ビルド
- `vp run check:quality`: 依存方向・決定性・重複・文書量・migration検査
- `vp test run <path>` / `vp fmt`: 関連テスト / 整形
- `vp run test:e2e`: [使い捨てDBとChromiumの画面検証](docs/development/e2e.md)
- `vp run demo:spatial`: 画面・DBなしの対戦
- `vp run db:generate` / `db:migrate` / `db:seed`: SQL生成・適用・未登録ID追加
- `node scripts/harness.ts context list`: 作業別参照先

## 詳細

- [ローカル利用・API・バッチ](docs/development/local-usage.md)
- [開発規則](AGENTS.md)・[文脈の節約](docs/development/ai-context.md)
- [3Dルール](docs/rules/spatial-v1.md)・[観測AI](docs/adr/0009-observed-ai.md)
- [Drizzle](docs/adr/0005-drizzle-kit.md)・[保存互換性](docs/adr/0010-battle-version-compatibility.md)
- [検証とPR完了](.agents/skills/fantasy-delivery/SKILL.md)・[証跡](.github/harness/README.md)
- [回帰・性能計測](docs/development/simulation-evidence.md)
- [Linux CI](docs/development/ci.md)・[リリース](docs/development/release.md)
- [Security](docs/security.md)・[依存更新](docs/dependency-updates.md)
