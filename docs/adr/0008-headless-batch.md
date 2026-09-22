# ADR 0008: 固定計画によるheadless実行と持ち運べる結果

P3 / Issue #10 A1。HTTPを起動せず、公開revision、`BattleRuntime`、Piscina、
同じエンジンと保存処理を使う。別エンジンや簡略判定は作らない。

## 計画

`batch plan`はcleanなGit commit、Node版、OS/arch、engine digest、全入力revision、
seed/主体stream、予定枠、計算予算、容量を実行前に固定する。最大1,000枠。
source SHA/toolchain/OSの異なる実行は拒否する。ラベルだけ違う同一simulationも
二重の対戦枠として認めない。revision、枠の入力列挙順は意味を持たない。
各枠はsimulationHashとラベルから識別し、sha256の先頭32bit modulo shard数で割り当てる。
最大64 shards。shard数・投入順・Worker数は対戦seedへ混ぜない。

計画の予測bytes×枠数が最終出力またはローカル作業容量を超える場合は、実行前に拒否する。
予測値は達成済みの計測値ではない。実ファイル容量も保存ごとに照合する。
既定deadlineは30分、上限も30分。次の30秒timeoutと1秒の余裕を残せなければ
新しい対戦を開始せずpendingとして記録する。各対戦のtimeout/leaseはADR 0007に従う。
OSの停止やディスクI/Oの時間を厳密に保証するリアルタイム制御ではない。
SIGINT/SIGTERMは実行中jobを中止し、未開始枠と区別したindexを保存する。

## 容量と所有権

最終bundleは`maxOutputBytes`（最大16 GiB）、ローカルreplay作業域は別の
`maxWorkBytes`（最大16 GiB）で制限する。SQLiteは64 MiBのpage上限とし、各枠の終了時に
WALをcheckpoint/truncateする。DB/WAL等の管理領域として256 MiBを別途見込む。
必要ディスク容量は **maxOutputBytes + maxWorkBytes + 256 MiB**。
最終出力16 GiBをローカル全使用量16 GiBと取り違えない。Workerごとの二重書込予約と
追加1件が作業容量に入らない設定は起動前に拒否する。最終index用に2 MBを予約する。

`.work/`は単一調整側が所有するSQLiteと元replay。並列shardsは別々のoutput rootを使う。
同じrootへの逐次再開は可能。同一rootの同時実行は既存のDB/root所有権で拒否する。
所有権を得た後だけ、専用prefixとcanonical v4 UUIDの未確定stagingを回収する。
公開対象は`plans/`、`indexes/`、`complete/`、`objects/`のみ。DB、内部絶対パス、
環境変数、認証情報はpayloadに入れない。ローカル`.work/`を丸ごと公開しない。

## 保存・再開

結果bundleはmanifest、独立gzip、チェックポイント、元attempt/result/sourceを示す
receiptからなる。全件検証後、content hashのobject directoryへatomic renameする。
確定win/drawだけが`complete/<simulationHash>.json`に登録される。
pointer/indexはfsync済み一時ファイルをhard linkでcreate-only公開する。
同名の既存ファイルを上書きしない。Windowsの電源断耐久性の制限はADR 0006と同じ。

再開時はpointer、receipt、manifest、全チャンク/checkpointを再検証する。
破損を正常cacheとして再利用したり、黙って別の結果に置き換えたりしない。
object確定後・pointer前の停止は、元DB結果から同じobjectを検証してpointerを補完する。
failed/cancelledの再試行には`--retry-failed`を指定し、元jobの最大3 attemptsを守る。
truncated/unresolvedはその診断結果を保持し、確定cache/成功枠にしない。
大きな計算予算への変更は新しい計画になる。既存の完全な結果はsimulationHashで再利用する。

indexは毎回不変hashで保存する。可変の「最新」pointerを持たないため、遅れて終了した
古い実行が新しいindexを巻き戻すことはない。`batch check`は元計画の全予定枠、重複、
shard構成、source、receiptと実ファイルを突合する。一部shardだけの完了を全体完了にしない。
不完全ならexit 2、入力/整合性エラーならexit 1。ランキング計算や正式公開は行わない。
hashは整合性の検査であり第三者の結果に対する認証ではない。

`batch.test.ts`は同一計画の1 Worker/複数Worker/逆順shard、deadlineからの再開、
新計画へのcache再利用、破損保留、truncation、欠落shard、二重計上、容量とatomic公開を検証する。
source identityのfixture値はテスト入力であり、実checkoutの検証証跡には使わない。
A2のR2 publisher、A3の定期Actions実行、A4のPages画面は後続範囲。
