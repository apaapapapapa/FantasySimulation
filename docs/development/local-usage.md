# ローカル利用

導入は[README](../../README.md)。固定版とコマンド一覧は[package.json](../../package.json)が正本です。

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

## ビルドして起動

`vp run build`後、APIは`vp run --filter @fantasy/api start`、画面は別ターミナルで`vp run --filter @fantasy/web preview`。
画面は <http://127.0.0.1:4173>、成果物は各appの`dist`です。APIはルートの`db/drizzle`と`data/spatial`を参照するため、リポジトリ内で起動します。
SQLiteのネイティブビルドが必要な環境ではPythonとC++ツールも用意します。

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

画面ではキャラクター・能力のJSONを下書き保存→検証→新revision公開できます。
対戦は設定とseedを選んで開始し、中止・再試行・結果・保存ログを確認します。
ログ上限で中断した場合は計算予算を増やして再試行します。公開revisionは保持されます。
記録の検証・表示復元は[ADR 0006](../adr/0006-recorded-replay.md)。描画はengineを実行しません。

## 3Dサンプル対戦

`pnpm demo:spatial` は柱のある広場で剣士と飛行術師を対戦させます。
`pnpm demo:spatial archer guardian flat` のように2体と戦場を指定できます。
画面・DBなしで同じmanifest/seedの対戦を再現します。

`data/spatial/catalog.json` は15体と能力・装備・方針・状態・戦場・ルールの69revisionです。
剣士、槍兵、重装騎士、弓使い、魔法弓使い、炎術師、氷術師、雷術師、飛行術師、治癒剣士を
同じ型付き部品で構成しています。キャラクターごとの実行分岐はありません。
`pnpm catalog:spatial` で生成元との一致を確認し、変更時は
`pnpm catalog:spatial --write` の差分をレビューしてください。
配布済みサンプルは[版更新規則](../adr/0010-battle-version-compatibility.md)に従い新しいIDで追加します。起動時・`db:seed`で未登録のIDをDBへ追加します。

戦場は `flat` と `pillars`。manifestには選択した参加者と戦場から辿れるrevisionだけを含めるため、
無関係なキャラクターの追加が既存対戦のhashを変えることはありません。

## 非同期対戦とリプレイ

所有権・lease・再試行・容量予約・cacheと復旧条件は[ADR 0007](../adr/0007-worker-runtime.md)を正本とします。
失敗時の記録保持、結果hash不一致の隔離、欠落/破損結果を明示復旧まで保留する契約も含みます。

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

## Headlessバッチ

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
公開用directoryの生成（未完了なら全枠を残してexit 2、不正ならexit 1）:

```sh
vp run batch export .generated/batch-plan.json .generated/public path/to/index.json .generated/batch-output
```

R2書込みや画面への接続は後続です。公開layout/理由コード/容量は[ADR 0008](../adr/0008-headless-batch.md)。
配布ビルドでは`node apps/api/dist/batch.mjs`を使用できます。
出力の`.work/`はローカルDB/作業記録です。必要ディスク容量は最終出力上限＋作業replay上限＋256 MiB。
[計画・保存・再開の契約](../adr/0008-headless-batch.md)を参照してください。
