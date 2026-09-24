# ADR 0011: P3の保存込み統合性能受入

## 決定

Issue #1の3D-08 / PR #60でTypeScript + Rapier + Piscinaを採用。
新規1,000試合を2 Workerで1504.65秒（25.08分）で完走し、
[ADR 0002](0002-spatial-engine.md)の時間・メモリ・保存量をすべて満たした。
閾値、既定1・最大4 Workerは維持。P4/P5や#45/#59/#61の受入を意味しない。

[元の比較・四半分の推移・SHA対応](https://github.com/apaapapapapa/FantasySimulation/blob/4618f3cc78942b354e1b8271f845f288cd4582c6/docs/adr/0011-integrated-performance.md)
と[集計JSON](../measurements/p3-integrated-linux.json)に計測証跡を保持する。
計測SHAを書き換えず、raw attempts/memory・ログ・git bundleはPRの証跡で確認する。

## 固定条件と再実行

AMD EPYC 9V74、8 CPU、RAM 23109898240 bytes、Linux x64、Node 24.19.0、
pnpm 11.19.0、overlay。物理ディスク/IOPSは未公開。
`scripts/harness/fixtures/integrated-profile.json`の13体・10組合せ、
seed=20260923+入力番号。早期決着と6,000step完走200件を含む。
全障害物・弾数上限の最悪条件は保証しない。

既存BattlePool/runBatchで正式event・軌跡・checkpoint・gzip・SQLite・portable bundleを使用。
保存なし比較も正式ログ生成/転送を含み、sinkだけを捨てる。
cleanな計測commit・未使用出力先で順番に実行する:

```sh
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-one 1 100
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-four 4 100
pnpm --filter @fantasy/api exec node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/p3-full 2 1000
```

100件はprofilingで`full-batch=unknown`。assessment exit 2はpnpmで1になる場合がある。
共有CIは正しさ/回帰を検証し、基準機の性能合否を代替しない。

## 結果と限界

全1,000件で失敗・打切り・cache再利用0、10項目pass。
保存込みtotalMsはattempt開始〜正本DB登録、全体時間は準備/export/再検証も含む。
warm中央値0.548秒、p95 7.721秒、RSS最大530.28 MiB、後半高水位増加0.00 MiB、
Worker heap最大51.93 MiB。coldメモリも判定対象。
圧縮artifact最大346,919 bytes/試合、合計116,624,491 bytes。正本/export複製は別保管。
2回目は全件cache hitで286.83秒。checksum/意味検証を通し、計算percentileには混ぜない。

変更前4 Workerのp95 14.176秒は未達。floatBitsの割当削減後も4 Workerは13.586秒。
採用根拠は2 Workerの実測。数値encoding・負のゼロ・非有限値拒否は不変。
共通100入力の勝敗/step/計算量/event/trajectory/TS/physics hashが一致し、
実装digestのみレビューして更新。WASM・ルール版・コーパスの入力/期待値は維持した。

全体p95の8秒まで約0.28秒、最後の250件は9.056秒。全体分布での合格と速度低下の残課題を区別する。
長期バッチは入力構成・保存待ち・ホスト負荷を分けて再計測する。
RSSは100ms標本、Worker値はattempt単位。heap/external/arrayBuffers/WASMは加算しない。
world解放・WASM初期化再利用・終了時pool closeを維持する。
RSS 1.5 GiB超過で投入停止/実行中attempt中止。瞬間最大値・OS隔離の保証ではなく、
外部サービス化時は別プロセス/OS制限を再評価する。
backpressureは転送/検証/圧縮/保存待ち込み。TS/WASM CPU、HTTP遅延、タスク別queue時間は未分離。
他環境や495,000試合への外挿はしない。
