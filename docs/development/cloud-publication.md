# スマホで開発・公開

ChatGPTアプリからCodexへ依頼し、レビュー・main CI後にActionsで計算・公開する。
PC・ターミナル・ローカル`.env`は不要。本番キーをチャットやCodexへ渡さない。
契約は[ADR 0008](../adr/0008-headless-batch.md)。編集APIは公開しない。

## 初期設定（GitHub Web）

Settings → Environmentsで`r2-publication`を作成。
Deployment branches and tagsをSelected branches and tagsにし、**Branchのmainだけ**を許可する。
同じEnvironmentに登録する（repository Secretsには置かない）:

- Secrets: `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。
- Variables: `R2_ACCOUNT_ID`。設定・料金確認後に`R2_PUBLICATION_ENABLED=true`。

キーは`fantasysimulation-replays`だけのObject Read & Writeに限定し、紛失時は再発行する。
Global API Key・他プロジェクトのキーは使わない。R2は非公開のまま既存Reader/Pagesを使う。
Workers Free/Paid・全体のR2利用量・請求通知を確認する。無料枠は強制的な料金上限ではない。
Required reviewersは任意だが、1人運用で自己承認禁止にしない。

## 公開

Actions → Publish replays → Run workflowでmainを選び、`ci_run_id`に現在のmain SHAで
成功したCIのrun IDを指定する。Public viewerの成功も確認する。
`plan_input=sample`は2試合。独自入力はCodexに`data/publication/<name>.json`をコミットさせ、
CI合格後にパスを指定する。最初は`mode=dry-run`で見積もりを確認し、次に`publish`を明示実行。
dry-runもR2読取りに認証・利用枠が必要だが、書き込まない。

計算はSecretなし。公開stepで保持世代を復元し、公開後の読戻しまで確認する。
失敗したrunは同じSHA・CI ID・入力でRe-run all jobs。新規起動は現在のmainとCIのSHAを合わせる。
artifact期限7日後は計算から再実行。R2データは残る。
復元256MB等の上限時は停止し、自動拡張・削除しない。詳細はADRと[コマンド](local-usage.md)を参照。

Secret設定、実公開/再公開、Pages再生/再読込/過去viewer互換、費用測定は別の受入。
実装・模擬テストだけで#81を完了にしない。Worker更新も認可済みクラウド経路を使う。
