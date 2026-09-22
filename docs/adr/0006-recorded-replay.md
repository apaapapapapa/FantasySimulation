# 保存記録だけから復元する3Dリプレイ

Issue #10 R1 / Issue #1 P3。表示契約は`packages/domain`へ置き、Node、対戦engine、
Rapier、Three.jsを参照しない。実行用manifestは引き続き現行版だけを受理するが、
保存済み表示schema 1は記録されたengine/rulesの識別子を保持する。観戦のために
旧実行物を読み込まない。未知の構造/schemaは拒否し、互換engine registryを作らない。

## 記録と時計

固定された入力と全revision、身体・戦場・表示種別をreplay manifestに含める。
初期状態→任意の境界更新→1区間の軌跡と同時確定差分→終端を記録する。
座標は右手Y上・mのbinary64、stepは20ms。表示用量子化を行わない。
区間の軌跡は折れ線をそのまま保存する。数値・状態効果・生成消滅は記録時刻で
切り替え、HP等を描画フレームの順に再計算しない。`grounded`、速度、固定された
flight modifierと状態期間から飛行/落下を表示できる。未知の移動演出を推測しない。

event IDは生成時の因果ID、sequenceはstep/phase/区間内時刻で整列した表示順。
両者は同じ番号とは限らない。各transactionのID集合とsequenceは欠番・重複を
拒否し、親/原因はより前に生成されたIDに限定する。イベントを省略しない。
actor差分は置換式。部分的な不正recordは適用せず、最後の検証済み状態を保つ。

## checkpointと独立チャンク

`ReplayState`は表示状態のみを復元する。checkpointはstep、次record/event位置、
境界適用状態、活動中の弾/状態/行動開始時刻、直前の表示record（軌跡・eventを含む）
を持つ。シミュレーションの途中再開には使えない。checkpointのschema/参照/範囲検証と、
writerによる先頭からの復元との照合を分ける。checksumだけで公式結果の真正性は保証しない。

保存profile `display-ndjson-gzip-v1` の初期値は独立gzip NDJSON、128 KiBを目安に
最大250stepごとに分割し、各チャンクの直前checkpointを独立gzip JSONへ保存する。
単一record・checkpointは約4 MB、展開後のartifact合計256,032,768 bytes、
保存合計16 MiBを上限とする。チャンク途中のrecordは分割しない。chunk indexには
step/record範囲、対応checkpoint、圧縮前後bytes、圧縮bytesのSHA-256を持つ。
event hash・trajectory hashは既存のbinary64正規化を保持し、圧縮checksumと分離する。
checkpointとチャンクを含む最終サイズの実測・採用判断はR2の保存込み評価で行う。
目標未達なら新profileとして差分と理由をレビューし、無言で間引かない。

正常・未定義・打切りは結果に対応する終端recordを保存する。実行障害/中止は
最後の検証済み範囲と診断を持ち、正常な決着を合成しない。initial未受信なら範囲はnull。
result ID、attempt ID、simulationHash、固定入力、結果のevent/trajectory hashを結び付ける。
artifact参照は規定の相対ファイル名だけを許可し、URL・上位パス・任意コードを拒否する。

## 保持と容量

採用結果に対応する正本と部分/失敗診断は、利用者が明示的に削除するまで保持する。
容量を空ける目的で過去ログを自動削除しない。予測容量が上限を超える投入は拒否し、
保存先の変更・バッチ分割・利用者によるアーカイブを要求する。アーカイブ/backupは
DBとartifactの対応する世代を一緒に保持する。SQLiteの稼働中ファイルだけをコピーして
backup完了と扱わない。現段階では停止してDBとartifact一式を保全する手順を基本とする。
writerは一時配置→再読込検証→rename→DB参照確定の順とし、再開時に未参照の
一時/孤立artifactだけを回収する。公開packや採用済み正本を回収対象にしない。
欠落・破損は再生可否を明示し、cache/正式採用を保留する。勝敗の捏造や自動再生成はしない。

`packages/domain/fixtures/replay/mutual-hit.json`は生成プロセスが停止した後にdomainだけで
読む固定fixture。内容hash、同時致死、前後seek、表示eventを検証する。
地形/飛行/弾/状態の統合recordもAPI側の契約試験で復元する。P4の画面・描画時計は範囲外。

## 保存実装と配信契約

`apps/api/src/replay-writer.ts` は `append` の完了を待つ逐次投入を要求する。
Node標準のgzip streamが書込を待ち、保持するデータは1チャンクと表示状態に限定する。
確定前に全チャンクを再読込し、各checkpointを実際の先頭からの復元結果と照合する。
manifestは最後に書き、各ファイルをsyncしてから同一保存先でdirectoryをrenameする。
DB登録はこの確定後に調整側が行う。Workerからの転送・DB参照・再起動時の回収は
ジョブ調整のPRで接続する。

readerは実bytes上限・symlink・圧縮checksum・展開後上限・UTF-8・NDJSON件数を検査する。
checksumを付け替えた不正checkpointも全件検証で拒否する。seekは指定record境界の直前
checkpointと対象chunkのみ読むため、同stepのboundary前後をrecord cursorで区別する。
seekだけでログ全体の真正性や完全性が検証されたと表示しない。

配信時は`.ndjson.gz` / `.json.gz`を`application/gzip`、`Content-Encoding`なしで返し、
checksumは圧縮bytesに対して確認する。アプリ側で一度だけgzip展開する。
ローカルimportも同じbytes契約を使う。任意URL・親directory・symlinkは受け付けない。
HTTP経路とブラウザーの展開・Safari実機検証は、それぞれAPI接続/P4で追加する。
