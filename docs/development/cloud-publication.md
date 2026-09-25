# スマホで開発・公開

ChatGPTからCodexへ依頼し、レビュー・main CI後にActionsで計算・公開する。
PCやローカル.envは不要。本番キーをチャット・Codexへ渡さない。
詳細は[ADR 0008](../adr/0008-headless-batch.md)。編集APIは公開しない。

## 設定

GitHub Settings → Environments → r2-publication:

- Deployment branches: Selected branches and tagsでBranchのmainだけ許可。
- Environment Secrets: R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY。
- Variables: R2_ACCOUNT_ID、確認後にR2_PUBLICATION_ENABLED=true。

通常はbucket限定Object Read & Write。#81の承認済み例外はADR参照。
Global API Key・repository Secretsは使わず、R2は非公開。
Worker更新は認可済みクラウド経路。契約・全体利用量・請求通知を確認する。
無料枠・通知は料金上限ではない。自己承認禁止の設定で1人運用を止めない。

## リーグ

Daily leagueは毎日03:17 UTC予定（遅延あり）。変更・再試行対象がなければ省略。
手動はActions → Daily league → Run workflowでmain、成功CIのci_run_id、
mode=dry-runで見積もり、publishで公開。definition既定は全20キャラ。
計算前に予算・試行を保存し、失敗分も分母に含む暫定順位を公開する。
各試合の追加再試行は1回。上限では停止し、自動拡張・削除しない。
再開は新規runかRe-run all jobs。**失敗ジョブだけ再実行しない**。
artifactは7日、公開済みR2履歴は保持。費用・実公開・スマホ表示は別途実測する。

## 個別バッチ

Actions → Publish replaysは手動のまま。現在mainで成功したCIのrun IDを
ci_run_idに指定し、Public viewer成功も確認。plan_input=sampleは2試合。
独自入力はコミット済みdata/publication/<name>.json。dry-run確認後publish。
この経路のdry-runは認証付きR2読取りのみ。復元は既定256MB。
再開は同じSHA・CI ID・入力でRe-run all jobs。詳しくは[コマンド](local-usage.md)。
