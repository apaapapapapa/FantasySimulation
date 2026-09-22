# FantasySimulation

キャラクターの設定を追加し、仮想対戦とランキングへ発展させるための開発基盤です。
現在は、JSON編集 → 検証 → SQLite保存 → サンプル対戦 → 履歴表示まで動作します。
P2〜P3はIssue #1の3D設計へ移行中です。旧実装の互換維持は行いません。
[計算基盤ADR](./docs/adr/0002-spatial-engine.md)に対象範囲・数値条件・性能目標を記録しています。
`vp run bench:spatial`でRapier試作の6000step計測、`vp test`で固定hashと幾何境界を検証できます。
`node scripts/spatial-demo.ts`で新しい3D近接対戦を画面・DBなしで実行できます。
この段階の対戦ループは近接/即時射撃/自己効果までで、飛翔体とAPIの置換は後続の実装です。

## 技術構成

| 部分             | 採用技術                            | 配置                  |
| ---------------- | ----------------------------------- | --------------------- |
| 開発ツール       | Vite+ 0.3.3 / pnpm 11.19.0          | ルート設定            |
| 画面             | React 19 / TypeScript strict        | `apps/web`            |
| API              | Node.js 24.19.0 / Fastify 5         | `apps/api`            |
| 対戦エンジン     | TypeScriptの純粋関数                | `packages/engine`     |
| 共通型・JSON検証 | TypeScript / Zod 4                  | `packages/domain`     |
| データベース     | SQLite / Node.js標準の`node:sqlite` | `data/fantasy.sqlite` |
| サンプル設定     | JSON                                | `data/characters`     |
| DB変更履歴       | SQLマイグレーション                 | `db/migrations`       |
| 将来の分析       | 必要になった段階でPythonを追加      | `analysis`            |

Vite+に含まれるVite、Vitest、Oxlint、Oxfmt、tsdown、タスクランナーを利用します。
`vite`はVite+のコアにエイリアスし、VitestもVite+内蔵版に固定しています。
内部の2パッケージはTypeScriptソースを直接共有し、APIビルド時にはバンドルします。

## 開始手順

Gitと[Vite+](https://viteplus.dev/guide/)を用意してください。
Vite+の初回インストールはWindows PowerShellで`irm https://vite.plus/ps1 | iex`、
macOS / Linuxでは`curl -fsSL https://vite.plus | bash`です。インストール後にターミナルを開き直します。

```sh
git clone https://github.com/apaapapapapa/FantasySimulation.git
cd FantasySimulation
vp install --frozen-lockfile
vp run dev
```

- 画面: <http://127.0.0.1:5173>
- APIの動作確認: <http://127.0.0.1:3001/api/health>
- 停止: `Ctrl+C`

Node.jsは`.node-version`、pnpmは`package.json`に固定しています。
APIと画面の両方を起動するコマンドは**`vp run dev`**です。
`vp dev`はVite+組み込みの画面用コマンドで、APIの同時起動は行いません。

グローバルのVite+を使わない場合も、Node.js 24.19.0とpnpm 11.19.0を用意すれば
`pnpm install --frozen-lockfile` → `pnpm dev`で同じ環境を起動できます。
各スクリプトはプロジェクト内のVite+を使います。

初回起動時にDBを作成し、マイグレーションとサンプル2人の登録を行います。
通常の開発に別のDBサーバーやDocker、Pythonのインストールは不要です。
現在のDB世代は`db/schema.json`に宣言します。世代情報がない旧DBや別世代のDBは起動時に拒否します。
開発用には`vp run db:reset ./data/fantasy-new.sqlite --confirm-generation local-v1`で
新しいファイルを作り、`DATABASE_PATH`を切り替えてください。既存ファイルは置換しません。
[DB世代とresetの方針](docs/adr/0003-schema-generations.md)を参照してください。

## 設定

既定値のままで起動できます。変更する場合だけ、ルートの`.env.example`を`.env`にコピーしてください。

```dotenv
API_HOST=127.0.0.1
API_PORT=3001
DATABASE_PATH=./data/fantasy.sqlite
```

`DATABASE_PATH`の相対パスはリポジトリのルートを基準に解決します。
画面の`/api`リクエストはViteのプロキシからAPIへ送信されます。
`.env`の`API_PORT`を変更したら、開発サーバーを再起動してください。
ローカル利用を前提としており、認証は未実装です。APIは既定でループバックにのみ待ち受けます。

## 開発コマンド

すべてリポジトリのルートで実行します。ローカルCLIの場合、先頭の`vp`を`pnpm exec vp`に置き換えられます。

| コマンド                                                   | 内容                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `vp run dev`                                               | 画面とAPIを並行起動、コード変更を反映                        |
| `vp check`                                                 | フォーマット、lint、型を使った静的検査                       |
| `vp run typecheck`                                         | TypeScriptコンパイラによる全ソースの検査                     |
| `vp fmt`                                                   | フォーマット修正                                             |
| `vp test`                                                  | 共通スキーマ、エンジン、API・SQLite結合テスト                |
| `vp test watch`                                            | テストの継続実行                                             |
| `vp run build`                                             | 画面とAPIのビルド                                            |
| `vp run verify`                                            | チェック・型検査・テスト・ビルドを一括実行                   |
| `vp run db:migrate`                                        | SQLマイグレーションを適用                                    |
| `vp run check:quality`                                     | 依存方向・決定性・ソース形式・migration安全性を検査          |
| `vp run db:reset <new-file> --confirm-generation local-v1` | 既存DBを残して新しい開発用DBを初期化                         |
| `vp run db:seed`                                           | JSONサンプルの未登録IDのみ追加                               |
| `vp run demo:tick`                                         | 新tickエンジンの固定manifestを実行し、結果・ログ・hashを表示 |
| `vp run engine:check`                                      | エンジン実装digestと現在のソースの整合性を検査               |

`pnpm check`、`pnpm test`、`pnpm build`、`pnpm verify`も利用できます。
GitHub ActionsはLinux・Windowsで固定バージョンの依存関係をインストールし、同じ検証を実行します。

ビルド成果物は`apps/web/dist`と`apps/api/dist`です。確認するには、ビルド後に別々のターミナルで実行します。

```sh
vp run --filter @fantasy/api start
```

```sh
vp run --filter @fantasy/web preview
```

プレビュー画面は<http://127.0.0.1:4173>です。
APIは起動時にルートの`db/migrations`と`data/characters`を参照するため、リポジトリ内で実行してください。
外部への公開・デプロイ設定は、この初期環境には含めていません。

## 自動リリース

`main`へのpush後、GitHub ActionsのLinux・Windows両方の検証が成功すると、
semantic-releaseが前回のリリース以降のコミットを解析します。
リリース対象の変更があれば、`vX.Y.Z`タグと変更履歴付きの
[GitHub Release](https://github.com/apaapapapapa/FantasySimulation/releases)を作成します。
PRの検証ではリリースしません。`main`の実行中のリリースは、後続のpushで中断しません。

コミットとPRタイトルは[Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/)形式にします。

| コミット例                                             | 次のバージョン                    |
| ------------------------------------------------------ | --------------------------------- |
| `fix: 同時撃破時の判定を修正`                          | パッチ（例: `1.0.0` → `1.0.1`）   |
| `perf(engine): 対戦ログ生成を高速化`                   | パッチ                            |
| `feat: ランキングを追加`                               | マイナー（例: `1.0.0` → `1.1.0`） |
| `feat(api)!: 対戦APIの入力形式を変更`                  | メジャー（例: `1.0.0` → `2.0.0`） |
| `docs:` / `chore:` / `ci:` / `test:` / `refactor:`など | 単独ではリリースしない            |

破壊的変更は、種類にかかわらず`!`または本文の`BREAKING CHANGE: 説明`で示します。
複数の変更がある場合は最も大きい更新幅を採用します。
Squash mergeでは、最終コミットのタイトルと破壊的変更の本文を確認してください。
PRタイトルだけを整えても、最終コミットに残らなければ解析されません。

過去のリリースタグがない場合、初回のリリース対象変更から`v1.0.0`を作成します。
アプリ全体の公開版はGitタグとGitHub Releasesで管理し、`package.json`の開発用バージョンは自動更新しません。
対戦の`rulesVersion`・`engineVersion`・実装digestは別の識別情報であり、従来どおり明示的に管理します。
この処理はnpmへの公開、Web/APIのデプロイ、リポジトリへの変更履歴コミットは行いません。

通常は追加のSecret設定は不要です。リリースジョブに限って`contents: write`を付与し、
GitHub Actions標準の`GITHUB_TOKEN`を使います。Issue/PRへの自動コメントとラベル変更は無効にしています。
ブランチ・タグの保護ルールを追加する場合は、Actionsによる`v*`タグ作成との整合性を確認してください。

リリースの再試行は、Actions → CI → Run workflowで`main`を選びます。両OSの検証から実行します。
ローカルで解析結果を確認する場合は、書き込み権限を確認できる`GITHUB_TOKEN`を環境変数に設定し、
最新の`main`とタグを取得した上で`pnpm release:dry-run`を実行してください。
dry-runでも認証・push権限は検証しますが、タグとReleaseは作成しません。
タグ作成後・Release作成前に失敗した場合、再実行だけではReleaseが復元されないことがあります。
その場合はCIログとタグのコミットを確認し、該当タグのGitHub Releaseを補完してください。

## キャラクターを追加する

画面の「設定を追加・更新」でサンプルJSONを編集し、「JSONを検証して保存」を押します。
新しい`id`なら追加、既存の`id`なら更新です。JSONの型や未対応の能力は保存時に検証します。
IDには英小文字・数字・ハイフンが使えます。定義の正本は`packages/domain/src/index.ts`です。

ファイルとして共有する初期データは`data/characters/*.json`に追加して、`vp run db:seed`を実行します。
シードは既存IDを上書きしません。JSONファイルを変更しても、登録済みキャラクターには自動反映されません。
登録済みデータの更新には画面または`POST /api/characters`を使います。

| API                    | 用途                                                     |
| ---------------------- | -------------------------------------------------------- |
| `GET /api/health`      | 起動確認                                                 |
| `GET /api/rules`       | 現在のルール設定                                         |
| `GET /api/characters`  | キャラクター一覧                                         |
| `POST /api/characters` | キャラクターJSONの追加・更新                             |
| `POST /api/battles`    | `{"leftId":"aegis-knight","rightId":"ember-mage"}`で対戦 |
| `GET /api/battles`     | 直近50件の対戦履歴（DBにはそれ以前の履歴も保持）         |

## 試験ルール v0.1.0

- 1対1で速度の高い順に行動。同速ならIDの文字列順で決め、左右の選択順に依存しません。
- 武器は物理、魔術は魔法ダメージとして扱います。武器種・魔術属性は設定に保持しますが、属性相性は未実装です。
- 基礎ダメージは`max(0, 攻撃 + 行動の威力 - 防御)`。対応する耐性を適用し、小数点以下を切り捨てます。
- 同種の耐性は最大値を採用。与ダメージが最大になる行動を選び、同値ならJSONの記載順を使います。
- HPが0になると即終了。両者が生存したラウンドの終わりに再生量の合計を回復し、最大HPを超えません。
- 100ラウンドを超える戦闘は引き分け。同じ入力とルール版なら同じ結果になり、乱数はまだ使いません。

これは開発基盤の動作確認用ルールです。時間停止・因果操作などの特殊能力の衝突判定、
MPやクールダウン、総当たりやランキング、複数条件による統計評価は今後実装します。
「どの相手にも必ず勝つ」といった設定の優先順位も、今後ルールとして明示する必要があります。

対戦履歴には両者のキャラクター定義のスナップショット、行動ログ、ルール版を保存します。
キャラクターを更新しても過去の履歴は変わりません。
この節は置換前の開発用機能です。新実行系ではルール版と実装digestを固定し、
保存済みの表示記録から再生します。旧版の実行コードは維持しません。

## 新対戦エンジン P1

`@fantasy/domain/tick-v1`と`@fantasy/engine/tick-v1`に新しい入力契約とエンジンを追加しています。
manifest schema 2、rules / engine `tick-v1 / 0.2.0`として識別します。

- 整数tickでdamage / heal / waitを同時解決。HP・MPコスト、速度、耐性、初期シールドを扱います。
- `win / draw / unresolved / truncated`を区別し、状態差分と判定理由を記録します。
- 解決済みrevision・seed・PRNG版・実装digestをmanifestへ固定し、入力・イベント・結果をSHA-256で検証します。
- Golden fixture、境界値、主体と位置を交換した対称性、計算打切りからの再試行をテストします。
- `vp run verify`とLinux / Windows CIで、実装digestの整合性も検査します。

`vp run demo:tick`だけで新対戦を再現できます。詳細は[ルール・入力・hash仕様](./docs/rules/tick-v1.md)と
[JSON fixture](./packages/engine/fixtures/tick-v1/golden.json)を参照してください。

現在のUIと`POST /api/battles`は引き続き`basic-v1 / 0.1.0`で同期対戦します。
新エンジンへの接続、revisionのDB保存、非同期ジョブはP3・P4で追加します。
能力合成・状態効果・射程・移動・条件付き方針はP2以降です。

## データとマイグレーション

SQLiteファイル・WALファイル・`.env`はGit管理から除外します。
`db/migrations`に連番のSQLファイルを追加すると、起動時または`db:migrate`でトランザクション内に適用します。
適用済みSQLのチェックサムを保存しており、過去のファイルを書き換えると起動時に検出します。
SQL変更は既存ファイルの編集ではなく、新しいマイグレーションで行ってください。
Node.js 24の`node:sqlite`は実験的APIの警告が表示される場合があります。バージョンを固定して検証しています。

設計と拡張時の作業方針は[AGENTS.md](./AGENTS.md)を参照してください。

## 参考

- [Vite+ / Getting Started](https://viteplus.dev/guide/)
- [Vite+ / Monorepo](https://viteplus.dev/guide/monorepo)
- [Vite+ / Project-local CLI](https://viteplus.dev/guide/local-cli)
- [Vite+ / CI](https://viteplus.dev/guide/ci)

## 開発ハーネス

実装・修正・PR完了は [fantasy-delivery skill](.agents/skills/fantasy-delivery/SKILL.md)
と [開発ルール](AGENTS.md)に従います。`vp run harness source .generated/harness/source-1`
は、cleanなcommitに対して既存の`vp run verify`を実行し、SHA・実行command・結果を保存します。
[証跡の収集とレビュー](.github/harness/README.md)、[CI計画と実測](docs/development/ci.md)、
[Issue完了手順](docs/issue-completion.md)を参照してください。
PRの成功、mainの成功、release結果、Issue完了はそれぞれ確認します。
