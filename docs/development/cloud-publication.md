# スマホだけで開発・公開する

ユーザーPC・ターミナル・ローカル`.env`は不要。スマホのChatGPTアプリからCodex等に
変更を依頼し、レビューとmain CIを通す。公開はGitHub Actionsの`Publish replays`で行う。
本番キーをCodexの開発環境やチャットへ渡さない。編集APIをインターネットへ公開する変更ではない。
[ADR 0008](../adr/0008-headless-batch.md)の公開・整合性・無料枠運用の契約は維持する。

## 最初にスマホのGitHub Web画面で設定

リポジトリのSettings → Environments → New environmentで`r2-publication`を作る。
Deployment branches and tagsはSelected branches and tagsにして、**branch `main`だけ**を許可する。
必要ならRequired reviewersも設定できるが、1人運用で自己承認禁止を有効にすると承認できない。
秘密値はこのEnvironmentの専用入力欄へ登録し、通常のrepository Secretsには置かない。

Environment secretsには`R2_ACCESS_KEY_ID`（発行済みR2アクセスキーID）と
`R2_SECRET_ACCESS_KEY`（対になる秘密キー）を登録する。
Environment variablesには`R2_ACCOUNT_ID`（対象CloudflareアカウントID）を登録し、
初期設定・プラン確認後に`R2_PUBLICATION_ENABLED`を`true`にする。

キーは`fantasysimulation-replays`だけのObject Read & Write権限に限定する。
Global API Key、他プロジェクトのキー、Cloudflare管理者権限は使わない。
紛失した秘密キーはチャットで送らず、Cloudflareで再発行してこの画面で更新する。
R2は非公開のまま、既存の読取WorkerとGitHub Pagesを使う。Workers Free/Paid、
アカウント全体のR2利用量と請求通知を確認する。無料枠は料金ゼロの保証・強制上限ではない。

## 公開

Actions → `Publish replays` → Run workflowを開き、branchは`main`を選ぶ。
そのmain SHAで成功した`CI`のrun IDを`ci_run_id`へ指定する。Pages側の`Public viewer`も
成功していることを確認する。既定の`plan_input=sample`はサンプル2試合。
独自の組合せはCodexに`data/publication/<name>.json`のバッチ入力をコミットしてもらい、
main CI合格後にそのパスを指定する。下書きや任意のURL・ファイルアップロードは受け付けない。

最初は`mode=dry-run`を実行し、見積もりを確認してから`mode=publish`を明示実行する。
起動と結果確認を接続済みGitHubツールへ依頼する運用も可能だが、ツールによる起動成功と
workflowの完了は区別する。起動権限がなければスマホの上記画面を使う。
`dry-run`も実R2の読取りを行うため、キーと利用枠は必要。R2への書込みは行わない。

計算ジョブは本番Secretなしでplan/run/check/exportする。完了した入力・index・検証済みbundle
だけを同一runのartifact IDで公開ジョブへ渡し、DB・`.work`・環境設定は含めない。
公開ジョブはEnvironmentの制限後にCIを再確認し、キーを公開stepだけへ渡す。
保持世代をR2から復元・検証して既存publisherで追加公開し、読み戻しが成功して初めて検証済みとする。
未完了の計算はこのworkflowでは公開しない。CLIの未完了行表示の契約は変更しない。

## 再実行・上限

同時公開は1つ。失敗したrunは同じSHA・CI run ID・入力のままRe-run all jobsで再実行する。
新規Run workflowでは現在のmainとCIのSHAを一致させる。新しいrunnerで復元し、同じobjectを
再利用する。古い世代への巻き戻し・不一致・未確認の読み戻しは成功扱いにしない。
復元は既存directoryを上書きせず、保持中の全世代とbundle・展開後の秘密情報を検査する。
workflowの復元読取りは256MBまで。全保存8GB、転送256MB、書込み10,000、
Worker読み戻し200要求の既存上限も維持する。上限に達したら止めて設計を見直し、自動拡張・削除はしない。
artifact保持は7日。期限後は計算ジョブも含めて再実行する。R2の公開済みデータはartifact期限に依存しない。

Secret登録、成功した実公開・再公開、Pagesでの一覧→再生→直接URL再読込、過去viewerとの互換性、
費用実測はそれぞれ別の受入。workflowの実装や模擬テストだけで#81を完了にしない。
読取Workerの将来の更新も、認可済みクラウド連携か専用の制限付き配備経路で行い、ユーザーPCは要求しない。

参考: [GitHub Environments](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)、[R2認証](https://developers.cloudflare.com/r2/api/tokens/)。
