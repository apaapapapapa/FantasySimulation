# ADR 0008: 固定計画・結果bundle・公開layout

#10 A1のheadless実行は公開revision、BattleRuntime、Piscina、既存エンジンを共用する。
[採用済みの計画・容量・再開契約の全文](https://github.com/apaapapapapa/FantasySimulation/blob/e9325df8ca62beba39b85d100265379e4c5ad2fb/docs/adr/0008-headless-batch.md)
を正本として保持する。以下の要約で既存の上限・耐久性・実行契約は変更しない。

## 計画と保存

The linked adopted contract retains all execution, capacity, deadline, shard, atomic
publication, ownership, retry and recovery rules. No engine behavior changes here.

`batch check`: all planned slots, source/shards/receipts/files; complete=0, incomplete=2,
invalid=1. Empty indexes mean all pending. Hashes are not authentication. Reading plans
accepts historical engine IDs; execution still requires current engine/source/digest and
reconstruction equality. No historical execution.

## 公開契約 v1（#81小PR1 / #80小PR1）

Zodと型の正本は`packages/domain/src/spatial/publication.ts`。通信のReplaySource/OpenedReplayは
webが所有する。公開JSONはschemaVersion=1、未知版/余分なfieldを拒否する。

| key（hashはsha256のhex64桁）     | 内容                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| `catalog/current.json`           | 現行catalogHashと展開後bytes                                    |
| `catalog/<hash>.json`            | 前catalogHash（初回null）、setHash/bytesの昇順一覧（最大1,000） |
| `sets/<setHash>/set.json`        | source・計算条件・件数・ページ参照                              |
| `sets/<setHash>/<pageHash>.json` | planId/index、slotId順100行（末尾だけ短い、最大10ページ）       |
| `objects/<objectHash>/...`       | 既存receipt/manifest/chunk/checkpointを元bytesのまま保持        |

新規JSONはcanonicalJsonのUTF-8、改行なし。hashはファイル全体で、自己hash fieldを含めない。
pageにsetHashを含めず循環を避ける。配信JSONのchecksum/サイズはHTTP展開後bytes、gzipは
圧縮bytesが対象。既存objectHashは従来どおりreceiptからobjectHashを除いたcanonical body。
receiptの実bytesのchecksum/サイズとmanifestChecksumを行のPublicReplayRefへ持つ。
consumerはbytesを検証してからrow→receipt→manifest、set→pageの共有照合関数を使う。

行はslotId/simulationHash、名前付きcharacter/scenario revision、配置/向き/主体stream、
ruleset、seed、state/reason、reused、勝敗/終了step、再生参照、records/lastVerifiedStepを持つ。
complete=full、unresolved/truncated=検証済み範囲だけpartial。failed/pendingは参照/result=null、
records=0でunavailable。架空IDを作らない。欠落shardもpending行として残す。
reasonは固定コード。バッチの生エラー文を公開しない。cancelled診断は本bundle形式には含めない。

## ローカルexport

`batch export plan.json public-dir index.json bundle-root [index.json bundle-root ...]`。
DB・戦闘・Git checkout・ネットワークを使わず、checkと同じ照合を再利用する。
plan/index/receiptの参照、revision hash、manifest入力と一覧の条件を検証する。
公開fieldの選択に加え、JSONと展開gzipの絶対パス・秘密field・既知credential形式を検査し拒否。
任意の秘密文字列を完全検出する保証ではない。管理者が公開可能な定義だけを入力する。
`.work/`、DB、環境変数、下書き、任意ファイルはコピーしない。

全衝突・容量を事前照合後、object→page→set→catalog→currentの順に保存。
既存bytesが同じなら再利用、違えば停止。同じsimulationのresultHash差も停止。
同じsetの再exportは世代を進めない。追加setは前世代と過去リンクを保持し、自動削除しない。
上限は保存8,000,000,000 bytes（pointer staging込み）、100,000ファイル。複数objectは非原子的。
rootは入力から分離し、symlink/形式外keyを拒否。ローカル単一writer lockとcurrent再照合を使う。
例外後は再実行可能。強制終了でlockが残った場合、writer停止を確認して管理者がlockを除去する。
exit 2でも全予定枠を含む未完了exportが確定する。通信成功や正式公開の意味ではない。

Tests use fixed v1.10 records; no engine/SQLite execution. R2/S3, Worker, viewer
compatibility, Pages, external setup and production acceptance remain #81 follow-ups.
Static adapter/UI belongs to #79; E2E to #12.
