# FantasySimulation

キャラクターの設定を追加し、仮想対戦とランキングへ発展させるための開発基盤です。
3D対戦エンジン、不変revision・下書きAPI、非同期ジョブと圧縮リプレイ保存を利用できます。
P2〜P3はIssue #1の3D設計へ移行中です。旧実装の互換維持は行いません。
[計算基盤ADR](./docs/adr/0002-spatial-engine.md)に対象範囲・数値条件・性能目標を記録しています。
`vp run bench:spatial`でRapier試作の6000step計測、`vp test`で固定hashと幾何境界を検証できます。
`pnpm demo:spatial`で剣士と飛行術師の3D対戦を画面・DBなしで実行できます。
近接・即時射撃・飛翔体/誘導/爆発・状態効果に対応しています。公開revisionと下書きは新しいDB世代へ保存します。

## 技術構成

| 部分             | 採用技術                              | 配置                  |
| ---------------- | ------------------------------------- | --------------------- |
| 開発ツール       | Vite+ 0.3.3 / pnpm 11.19.0            | ルート設定            |
| 画面             | React 19 / TypeScript strict          | `apps/web`            |
| API              | Node.js 24.19.0 / Fastify 5           | `apps/api`            |
| 対戦エンジン     | TypeScriptの純粋関数                  | `packages/engine`     |
| 共通型・JSON検証 | TypeScript / Zod 4                    | `packages/domain`     |
| データベース     | SQLite / Drizzle ORM / better-sqlite3 | `data/fantasy.sqlite` |
| サンプル設定     | JSON                                  | `data/spatial`        |
| DB変更履歴       | Drizzle Kit                           | `db/drizzle`          |
| 将来の分析       | 必要になった段階でPythonを追加        | `analysis`            |

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

初回起動時にDBを作成し、マイグレーションとサンプル10体の登録を行います。
通常の開発に別のDBサーバーやDockerは不要です。SQLiteドライバーのネイティブビルドが必要な環境ではPythonとC++ビルドツールを用意してください。
DBスキーマ・変更履歴はDrizzleへ統一しました。既存の最新`spatial-v1`（旧002・003適用済み）のrevision・下書き・BattleSpecは保持し、旧管理テーブルのみ削除します。
既存DBはバックアップし、APIを停止して`vp run db:migrate`を実行してください。
旧`local-v1`の業務データを3D定義へ自動変換する機能はありません。既存の無関係なテーブル・行は削除しません。
新しい開発用DBが必要なら`.env`の`DATABASE_PATH`を未使用のファイル名に変更してください。自前resetや世代管理はありません。
[Drizzleの移行・制約](docs/adr/0005-drizzle-kit.md)を参照してください。

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

| コマンド               | 内容                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `vp run dev`           | 画面とAPIを並行起動、コード変更を反映                              |
| `vp check`             | フォーマット、lint、型を使った静的検査                             |
| `vp run typecheck`     | TypeScriptコンパイラによる全ソースの検査                           |
| `vp fmt`               | フォーマット修正                                                   |
| `vp test`              | 共通スキーマ、エンジン、API・SQLite結合テスト                      |
| `vp test watch`        | テストの継続実行                                                   |
| `vp run build`         | 画面とAPIのビルド                                                  |
| `vp run verify`        | チェック・型検査・テスト・固定コーパス・ビルドを一括実行           |
| `vp run db:migrate`    | Drizzle Kitで未適用SQLを適用                                       |
| `vp run db:generate`   | TypeScriptスキーマからSQL・snapshotを生成                          |
| `vp run db:check`      | Drizzle Kitの履歴整合性検査                                        |
| `vp run check:quality` | 依存方向・決定性・重複コード・ソース形式・migration安全性を検査    |
| `vp run check:corpus`  | 固定対戦入力のidentity・反復一致と既存決定性テストのcoverageを検査 |
| `vp run db:seed`       | JSONサンプルの未登録IDのみ追加                                     |
| `vp run demo:spatial`  | 3Dサンプル対戦の結果・hashを表示                                   |
| `vp run engine:check`  | エンジン実装digestと現在のソースの整合性を検査                     |

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
APIは起動時にルートの`db/drizzle`と`data/spatial`を参照するため、リポジトリ内で実行してください。
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

## 下書きと公開revision

公開済みの設定は上書き・削除できません。`GET /api/characters/{id}`等で取得し、
`POST /api/drafts` に `{kind, definitionId, base, definition}` を送って編集します。
`base` は編集元の `{id, revision, contentHash}`（新規IDは`null`）。他の下書きから公開された場合も409を返します。
`PATCH` は `{expectedVersion, definition}`、`publish` は `{expectedVersion}` を要求し、
古い版による編集・二重公開は409です。未完成の下書きは保存できますが、公開時は型・参照を検証します。
公開に成功すると不変の新revisionと更新後の下書きが返ります。

| API                                         | 用途                                               |
| ------------------------------------------- | -------------------------------------------------- |
| `GET /api/health`                           | 起動・Drizzle接続確認                              |
| `GET /api/characters`                       | 最新revisionの一覧。`limit`最大100、`cursor`で続き |
| `GET /api/characters/{id}?revision=1`       | 指定revision。省略時は最新                         |
| `GET /api/rulesets`、`GET /api/scenarios`   | ルール・戦場revision一覧                           |
| `GET /api/revisions/{kind}/{id}/{revision}` | 能力・装備・状態・方針を含む固定revision取得       |
| `POST /api/drafts`、`GET /api/drafts/{id}`  | 下書き作成・取得                                   |
| `PATCH /api/drafts/{id}`                    | 競合検出付きの編集                                 |
| `POST /api/drafts/{id}/validate`            | 公開可能な構造・参照の検証                         |
| `POST /api/drafts/{id}/publish`             | 検証済みsnapshotの新revision公開                   |

現行仕様は[3Dルール](docs/rules/spatial-v1.md)を参照してください。
初期画面は接続状態を表示します。編集・対戦・観戦の画面はP4で追加します。

保存ログの表示契約は `packages/domain` の `ReplayState` で検証・復元できます。
イベント順序、因果参照、主体・飛翔体の軌跡、終端と表示状態を検査し、
チェックポイントからの復元には対戦エンジンやRapierを使いません。
[記録形式と上限](docs/adr/0006-recorded-replay.md)を参照してください。
API側の `ReplayWriter` は記録を独立したgzipチャンクへ保存し、全体を再読込検証してから
確定配置します。`verifyReplay` は全件の整合性、`seekReplay` は対象チャンクからの
表示状態を復元します。ジョブ実行は下記APIで利用でき、観戦画面はP4の作業です。

## データとマイグレーション

SQLiteファイル・WALファイル・`.env`はGit管理から除外します。
`apps/api/src/db/schema.ts`を変更し、`vp run db:generate`で生成したSQLとsnapshotを`db/drizzle`へコミットします。
`vp run db:check`で履歴を検査し、SQLレビュー後に`vp run db:migrate`を実行します。
API起動時も同じSQLと公式`__drizzle_migrations`を使います。自前runner・世代管理・チェックサム台帳はありません。
既存SQLは編集せず追記します。CIはKit検査、生成差分、実DB適用・再実行・失敗rollback・Git上の履歴不変性を検証します。
Drizzleが過去SQLの実行時改変検出を保証するわけではありません。レビュー済みSQLを迂回する`drizzle-kit push`は使用しません。
`STRICT`と不変revision/仕様のtriggerはレビュー済みSQLで維持します。将来のテーブル再作成時にも保持してください。
公開revision・下書きの競合検出・BattleSpecはDrizzle ORMへ移行し、Zodによる実行時検証は維持しています。

設計と拡張時の作業方針は[AGENTS.md](./AGENTS.md)を参照してください。

## 参考

- [Vite+ / Getting Started](https://viteplus.dev/guide/)
- [Vite+ / Monorepo](https://viteplus.dev/guide/monorepo)
- [Vite+ / Project-local CLI](https://viteplus.dev/guide/local-cli)
- [Vite+ / CI](https://viteplus.dev/guide/ci)

## 3Dサンプル対戦（P2）

`pnpm demo:spatial` は柱のある広場で剣士と飛行術師を対戦させます。
`pnpm demo:spatial archer guardian flat` のように2体と戦場を指定できます。
画面・DBなしで同じmanifest/seedの対戦を再現します。

`data/spatial/catalog.json` は10体と能力・装備・方針・状態・戦場・ルールの40revisionです。
剣士、槍兵、重装騎士、弓使い、魔法弓使い、炎術師、氷術師、雷術師、飛行術師、治癒剣士を
同じ型付き部品で構成しています。キャラクターごとの実行分岐はありません。
`pnpm catalog:spatial` で生成元との一致を確認し、変更時は
`pnpm catalog:spatial --write` の差分をレビューしてください。
公開後の編集は新revisionにします。起動時・`db:seed`で未登録のIDをDBへ追加します。

戦場は `flat` と `pillars`。manifestには選択した参加者と戦場から辿れるrevisionだけを含めるため、
無関係なキャラクターの追加が既存対戦のhashを変えることはありません。

## 開発ハーネス

実装・修正・PR完了は [fantasy-delivery skill](.agents/skills/fantasy-delivery/SKILL.md)
と [開発ルール](AGENTS.md)に従います。`vp run harness source .generated/harness/source-1`
は、cleanなcommitに対して既存の`vp run verify`を実行し、SHA・実行command・結果を保存します。
[証跡の収集とレビュー](.github/harness/README.md)、[CI計画と実測](docs/development/ci.md)、
[Issue完了手順](docs/issue-completion.md)を参照してください。
PRの成功、mainの成功、release結果、Issue完了はそれぞれ確認します。

対戦の決定性・回帰は `vp run check:corpus` で検査します。
`packages/engine/fixtures/spatial/corpus.json` の固定入力を2回実行してdigestの一致を確認し、
入力identityの変化と、既存の決定性テストの実行結果をカテゴリ別に記録します。
両OS間の出力突合、公平性、Worker投入順、計算量・容量の上限と同一runnerでの負荷比較も検証します。
実測の欠落・比較不能・中断は `unknown` とし、未完了の証跡を合格に数えません。
固定入力や対応テストを意図して変更する場合は、同じPRでコーパスを更新し理由を記載します。

ソース・テストの重複は `vp run check:quality` の `quality:duplication` で検査します。
新規の未ステージファイルも対象です。指摘箇所を共通化し、期待値は各テストに残します。
[重複防止の方針・共通fixture・検査範囲](docs/development/duplication.md)を参照してください。

### Persistent job ownership

`JobStore` persists queued jobs, token-fenced attempts, immutable results and replay references
using Drizzle. Claims, lease renewal/recovery, cancellation and completion use short SQLite
immediate transactions. A 10-second lease expires into a fresh attempt, up to three attempts;
ordinary failure, cancellation and truncation can be retried explicitly with an expected
attempt number and a new budget. Previous attempt budgets and results remain recorded.

Idempotency belongs to a client/endpoint scope and request hash, separately from simulation
identity. Only definitive win/draw results with a ready artifact qualify for cache reuse.
The first definitive result remains an immutable hash authority. After an artifact is lost,
a separately verified rerun with exactly that result hash can supply the ready cache artifact;
a disagreement quarantines every artifact for that simulation. Normal callers must hold a
missing/corrupt result until recovery has been explicitly requested and verified. Late diagnostic
insertion preserves every outstanding job's byte reservation. The initial admission limit is
128 outstanding jobs and 16 GiB of stored replay data, reserving room for admitted work.
`BattleRuntime` connects this store to reusable Workers and verified replay files.
See [the runtime contract and measured-memory definitions](docs/adr/0007-worker-runtime.md).

| API                                            | 用途                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/battle-jobs`                        | `{spec, budget?}` を受付。`X-Client-Id`と`Idempotency-Key`が必要。202、確定cacheなら200 |
| `GET /api/battle-jobs/:id`                     | 状態、attempt、進捗、診断、計測値                                                       |
| `POST /api/battle-jobs/:id/cancel`             | 中止を確定してからWorkerを停止                                                          |
| `POST /api/battle-jobs/:id/retry`              | `{expectedAttempts, budget}` で明示再試行                                               |
| `GET /api/battle-results/:id`                  | 保存記録を検証した結果。欠落・破損・隔離時は503で保留                                   |
| `POST /api/battle-results/:id/replay-recovery` | `{budget}` と冪等headersで欠落/破損記録の復旧を明示要求                                 |
| `GET /api/replays/:id`                         | 検証済みmanifest                                                                        |
| `GET /api/replays/:id/files/:file`             | manifestに列挙されたgzip bytes。Content-Encodingなし                                    |

既定設定は`ARTIFACT_PATH=./data/replays`、`BATTLE_WORKERS=1`、
`BATTLE_TIMEOUT_MS=30000`、`BATTLE_QUEUE_LIMIT=128`、
`BATTLE_STORAGE_BYTES=17179869184`、`BATTLE_RSS_BYTES=1610612736`。
APIは引き続き認証のないlocalhost開発用です。

## Headlessバッチ（P3）

cleanなcommitから計画を作り、同じcommit/toolchainで実行します。HTTPは不要です。
入力は公開revision、最大1,000の予定枠、計算予算、予測保存量と2種類の容量上限を含みます。

```sh
vp run batch sample .generated/batch-input.json
vp run batch plan .generated/batch-input.json .generated/batch-plan.json
vp run batch run .generated/batch-plan.json .generated/batch-output --workers 1
```

`--shard 0/4`から`--shard 3/4`は各shardを実行します。並列実行では別々の出力先を指定します。
同じ計画/出力先で再実行すると完全な結果を検証して再利用します。failed/cancelledを
再試行する場合は`--retry-failed`を明示します。`--deadline`はミリ秒、最大1,800,000です。
出力には不変のindexファイルのパスが表示されます。全体の照合には各indexと出力先を渡します。

```sh
vp run batch check .generated/batch-plan.json path/to/index.json .generated/batch-output
```

不完全なshardや破損を成功として数えません。不完全ならexit 2、入力/整合性エラーはexit 1です。
配布ビルドでは`node apps/api/dist/batch.mjs`を使用できます。
出力の`.work/`はローカルDB/作業記録です。必要ディスク容量は最終出力上限＋作業replay上限＋256 MiB。
[計画・保存・再開の契約](docs/adr/0008-headless-batch.md)を参照してください。

### 対戦の回帰・負荷ハーネス（Issue #9）

`verify`は固定コーパスの再現性、実Workerの並列数・投入順、左右交換の公平性、
SQLiteの状態遷移、計算回数とログ容量の上限をコミット前にも検証できます。
作業中の結果は未コミットの診断として保存し、最終証跡はcleanなcommitに固定します。
CIはLinux/Windowsの出力digestを自動照合し、固定baseline SHAとcandidateを
同じrunnerで交互に測定します。時間・メモリは観測値として別reportへ保存します。
再現手順、制約、予算変更reviewは[ハーネス手順](.github/harness/README.md)を参照してください。
