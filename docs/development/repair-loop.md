# 手動の有界修正ループ

Issue #11 の段階導入。初期版の対象は Linux。Windows runner の検証は、
2026-09-23 の Linux 統一指示により対象外とし、未対応環境では明示的に停止する。

状態は initialized → ready → running → applying → candidate → review → delivery
→ completed。評価失敗は ready、停止条件到達は stopped。中断を記録して再開しても
予約済み試行・外部呼出し・費用と開始時の期限は戻らない。status は読み取り専用。
コマンド成功は記録の成功であり、修正完了を意味しない。

初期提案は3試行、改善なし2回、1時間、外部呼出し200回、外部課金0。
開始前に契約へ repository、full baseline SHA、目的、許可path、必須check、review、
PR目標と予算を固定する。同一repository/baseline/目的の初期化は同じjournalを再利用し、
予算を変えて再初期化できない。別保存先や目的の言い換えで制限を回避しない。

永続化は排他lock、revision照合、hash連鎖、fsyncとatomic renameを用いる。
書込みAPIは既存eventを変更しない。残存lockを自動で奪わない。管理者が前processの
終了を確認し、journal/workspaceを照合してから復旧する。hashは署名・改竄耐性の
保証ではないため、信頼済み保存先と元証跡を一緒に保持する。

HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80` の contract/state/store/scope の
責務を抽出する。Cloudflare、AI、カタログ、merge/deploy adapterは移植しない。
XState は初期版では採用しない。直列の手動操作と少数の状態ではTypeScriptの純粋な
状態遷移が小さく、追加依存や機械snapshot移行を避けられる。並行状態が必要になった
時点で比較し直す。どちらを選んでも予算予約と永続化の原子性は別の責務である。

現在のCLI（次の段階でworkspaceと評価を追加する）:

```sh
node scripts/harness.ts loop init /retained/loops contract.json
node scripts/harness.ts loop status /retained/loops/TASK_ID/journal.json
```

`init` が返すjournalを再開時も使う。生存確認やstatus取得を理由にdeadlineを延長しない。
