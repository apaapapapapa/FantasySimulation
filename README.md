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
グローバルVite+を使わない場合は固定版Node/pnpmで`pnpm install --frozen-lockfile`→`pnpm dev`。

初回起動でSQLite DB、Drizzle migration、サンプル13体を登録します。
既定の保存先は`data/fantasy.sqlite`と`data/replays`。変更時だけ[.env.example](.env.example)を
`.env`へコピーします。既存DBの移行前にはAPI停止・バックアップを行い、
[移行制約](docs/adr/0005-drizzle-kit.md)と[保存互換性の未完了事項](docs/adr/0010-battle-version-compatibility.md)を確認してください。

## 構成とコマンド

| 配置                         | 責務                                     |
| ---------------------------- | ---------------------------------------- |
| `apps/web`                   | React / Vite+の画面                      |
| `apps/api`                   | Fastify / Drizzle / SQLite、Workerと保存 |
| `packages/domain`            | Zodスキーマと共通型                      |
| `packages/engine`            | 決定性を持つ3D対戦 / Rapier              |
| `data/spatial`、`db/drizzle` | サンプルrevision、SQLとsnapshot          |

| コマンド                                        | 用途                                          |
| ----------------------------------------------- | --------------------------------------------- |
| `vp run verify`                                 | 静的検査・テスト・コーパス・負荷予算・ビルド  |
| `vp run check:quality`                          | 依存方向・決定性・重複・文書量・migration検査 |
| `vp test run <path>`                            | 関連テストだけ実行                            |
| `vp fmt`                                        | 整形                                          |
| `vp run demo:spatial`                           | 画面・DBなしでサンプル対戦                    |
| `vp run db:generate` / `db:migrate` / `db:seed` | SQL生成・適用・未登録ID追加                   |
| `node scripts/harness.ts context list`          | AI向けの作業別参照先                          |

## 詳細を読む場所

| 目的                          | 正本                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| 設定、API、バッチ、ビルド起動 | [ローカル利用](docs/development/local-usage.md)                                                  |
| AIの作業開始・変更規則        | [AGENTS.md](AGENTS.md)、[文脈の節約](docs/development/ai-context.md)                             |
| 戦闘仕様、観測AI              | [3Dルール](docs/rules/spatial-v1.md)、[AI設計](docs/adr/0009-observed-ai.md)                     |
| DB変更、保存互換性            | [Drizzle](docs/adr/0005-drizzle-kit.md)、[版更新](docs/adr/0010-battle-version-compatibility.md) |
| 検証とPR完了                  | [delivery skill](.agents/skills/fantasy-delivery/SKILL.md)、[証跡](.github/harness/README.md)    |
| 対戦の回帰・性能計測          | [simulation evidence](docs/development/simulation-evidence.md)                                   |
| CI・リリース                  | [CI](docs/development/ci.md)、[リリース](docs/development/release.md)                            |
| セキュリティ、依存更新        | [Security](docs/security.md)、[dependency updates](docs/dependency-updates.md)                   |

Linux CIは静的検査・ビルド・分割テスト・性能比較を並列実行し、同じ実行のテスト結果を共有します。
性能比較の各対戦は同じrunnerで5回測定します。実行条件は[CI](docs/development/ci.md)を参照してください。
mainのゲート成功後にsemantic-releaseが必要なタグとGitHub Releaseを作成します。

<!-- Temporary CI scope verification; this change will not be merged. -->
