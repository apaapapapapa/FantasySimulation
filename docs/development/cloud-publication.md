# スマホで開発・公開

設計: [ADR 0008](../adr/0008-headless-batch.md)。

## 設定

GitHub Settings → Environments → r2-publication:

- Deployment branches: Selected branches and tagsでmainのみ。
- Secrets: R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY。
- Variables: R2_ACCOUNT_ID、確認後にR2_PUBLICATION_ENABLED=true。

通常はbucket限定Object Read & Write。#81の承認済み例外はADR参照。
Global API Key/repository Secretsは使わずR2は非公開。Worker更新は認可済み経路。
全体利用量・請求通知を確認する。無料枠は料金上限ではなく、自己承認禁止で1人運用を止めない。

## リーグ

Daily leagueは毎日03:17 UTC予定（遅延あり）。変更・再試行対象なしなら省略。
手動: Actions → Daily league → Run workflow。mainと成功CIのci_run_id。
mode=dry-runで見積もり、publishで公開（既定20キャラ）。
予算・試行を先に保存し、失敗も分母に含む暫定順位を公開。
各試合の再試行1回、上限自動拡張・削除なし。
再開は新規runかRe-run all jobs。失敗ジョブだけ再実行しない。
全compute成功後の公開失敗はRecover league publicationで元run/attemptを指定。
元の結果だけ検証・公開し、再計算せず新しい通信leaseを消費する。artifactは7日。

失敗はexit 1、Summaryと`reports/failure-<command>.json`に分類・段階・対処を残す。
`PUBLICATION_COMMIT_UNKNOWN`は成否不明、`PUBLICATION_UNVERIFIED`は公開後の検証未完了。
R2/Workerを読み戻し、同一公開入力で復旧する。`USAGE_UNVERIFIED`も台帳確認が必要。
消費済みleaseを再実行・返却せず、未完了を引き分けに変換しない。

## 個別バッチ

Actions → Publish replaysは手動。成功main CIのrun IDをci_run_idに指定し、Public viewer成功も確認。
plan_input=sampleは2試合。独自入力はdata/publication/<name>.json。dry-run後にpublish。
dry-runは認証付きR2読取りのみ、復元は既定256MB。同じSHA・CI ID・入力でRe-run all jobs。
[コマンド](local-usage.md)。
