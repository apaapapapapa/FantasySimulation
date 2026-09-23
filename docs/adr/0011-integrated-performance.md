# ADR 0011: P3の保存込み統合性能受入

## 決定と範囲

Issue #1の3D-08 / PR #60。TypeScript + Rapier + Piscinaを下記の固定条件で統合採用する。
**新規1,000試合を2 Workerで1504.65秒（25.08分）で完走**し、
[ADR 0002](0002-spatial-engine.md)の時間・メモリ・保存量の目標をすべて満たした。
閾値は変更していない。このバッチは2 Workerを選び、アプリの既定1・最大4は維持する。
4 Workerでは保存側の競合で単体遅延が増える。現時点でRustへの移行は不要と判断する。
P4/P5、#45・#59・#61の追加要件や親Issue全体の完了宣言ではない。

## 条件と再実行

- AMD EPYC 9V74、CPU 8、RAM 23109898240 bytes、Linux x64、Node 24.19.0、pnpm 11.19.0。
  コンテナoverlay。物理ディスク型番・IOPSは未公開。
- `scripts/harness/fixtures/integrated-profile.json`の13体・10組合せ、seedは20260923 + 入力番号。
  早期決着と6,000step完走200件を含む。障害物・弾数をすべて上限にした最悪条件の保証ではない。
- 既存の`BattlePool` / `runBatch`を利用。正式event・軌跡・checkpoint・gzip・SQLite・portable bundleを有効にする。
  保存なし比較も同じWorkerの正式ログ生成・転送を含み、sinkだけを捨てる。
- [集計JSON](../measurements/p3-integrated-linux.json)が元のsummary/report、cold/warm、入力別・工程別集計、hash照合の正本。
  raw attempts/memory、コマンドログ、計測commitのgit bundleをPRの計測証跡にも保持する。

```sh
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-one 1 100
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-four 4 100
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-full 2 1000
```

cleanなcommit・未使用の出力先で順番に実行する。100件はprofilingであり`full-batch=unknown`。
assessmentのexit 2はpnpm経由ではexit 1として返る場合がある。1,000件合格へ読み替えない。
共有CIは正しさ・回帰を検証し、基準機の性能合否を代替しない。

変更前はlocal `77958ffb66c2183c8290002c8ed16eed73627ceb`、1,000件はlocal
`6796273f73b93c1af64894dd868da65726a36f56`。後者と公開commit
`170b020d63d56d4b375289fc28538b8cf12df769`はtree
`735ce9467548a0fad54f8172675502ff5b600d38`が一致する。元の計測SHAは書き換えていない。
変更後1/4 Workerはこの公開commitで計測。最終更新は文書・観測JSONとmainの文書/検証整理で、計測対象のruntimeは同じ。

## 比較と改善

| 条件 / Worker |  件数 | 全体 秒 | warm中央値 秒 | warm p95 秒 | RSS最大 MiB |
| ------------- | ----: | ------: | ------------: | ----------: | ----------: |
| 変更前 / 1    |   100 |  237.55 |         0.483 |       6.410 |       444.6 |
| 変更前 / 4    |   100 |  184.67 |         1.226 |      14.176 |       603.8 |
| 変更後 / 1    |   100 |  223.36 |         0.461 |       6.447 |       414.8 |
| 変更後 / 4    |   100 |  158.57 |         1.000 |      13.586 |       615.1 |
| 変更後 / 2    | 1,000 | 1504.65 |         0.548 |       7.721 |       530.3 |

変更前4 Workerのp95 14.176秒は未達。20試合のCPU profileでcoordinatorの`floatBits`に
約7.42秒のself sampleを観測し、数値ごとのbuffer/DataView/配列生成をisolate内の同期scratch bufferと
uint32読出しへ置換した。big-endianの16桁、負のゼロの正規化、非有限値の拒否は不変。
境界値・subnormal・連続利用・エラー後の固定期待値をテストした。
実装digestのみレビューして更新し、WASM・ルール版・コーパスの入力/期待値は維持した。
共通100入力の勝敗・step・計算量・event/trajectory/TS/physics hashは一致。
実装digestを含むsimulationHashと実行順は変わり得る。採用根拠は2 Workerの全1,000件実測である。

## 受入と連続実行

新規attempt 1,000件、失敗・打切り・cache再利用0件。10項目すべてpass。
保存込み`totalMs`はattempt開始から正本DB登録まで。全体時間は準備・export・再検証も含む。
同じ1,000入力の2回目は全件cache hitで286.83秒。checksum/意味検証を通し、計算のpercentileへ混ぜない。
RSS最大530.28 MiB、後半の高水位増加0.00 MiB、
Worker heap最大51.93 MiB。coldのメモリも判定へ含める。
圧縮artifactは最大346,919 bytes/試合、合計116,624,491 bytes。
作業用正本とexport先の複製は別に保管する。

開始順250件ずつの推移（RSS合否はbenchmarkの時間窓）。メモリ単位はMiB。

| 四半分 | warm p95 秒 | heap最大 | external最大 | arrayBuffers最大 | WASM |
| ------ | ----------: | -------: | -----------: | ---------------: | ---: |
| 1      |       6.957 |    51.93 |         9.20 |             2.66 | 1.19 |
| 2      |       7.118 |    38.18 |         9.07 |             2.54 | 1.19 |
| 3      |       7.612 |    38.28 |         9.07 |             2.66 | 1.19 |
| 4      |       9.056 |    38.69 |         9.07 |             2.55 | 1.19 |

全体p95の8秒に対する余裕は約0.28秒。
最後の250件は9.056秒と遅くなる。事前の全体分布で合否を判定し、
この速度変化は残課題にする。より長いバッチでは入力構成・保存待ち・ホスト負荷を分けて再計測する。

RSSは100msサンプル、Worker値はattempt単位。heap/external/arrayBuffers/WASMは重複するので加算しない。
既存終了処理でworldを解放し、Worker内でWASM初期化を再利用、測定後にpoolを閉じる。
瞬間最大値やOS強制隔離の保証ではない。既存RSS監視は1.5 GiB超過時に投入停止・実行中attempt中止を行う。
heapのresourceLimitsだけでWASM全体を隔離したとは扱わない。外部実行サービスでは別プロセス/OS制限を再評価する。
backpressureは転送・検証・圧縮・保存待ちを含む。TS/WASMのCPU内訳、HTTP遅延、Piscinaタスク別queue時間は未分離。
495,000試合や他環境へ外挿して性能を保証しない。
