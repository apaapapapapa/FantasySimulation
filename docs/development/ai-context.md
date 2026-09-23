# AIが読む情報量の管理

## 作業の開始

`AGENTS.md`を読み、`node scripts/harness.ts context list`で作業を選びます。
例: `node scripts/harness.ts context engine`。参照するソース・文書・関連検査を
2,000 bytes以内で案内し、本文・diff・ログを一括展開しません。Nodeだけで実行でき、
依存インストール・外部AI/API呼出し・リポジトリへの書込みはありません。
実装とPR完了では既存delivery skillも適用します。複数領域の変更は該当topicを追加します。

1. `rg --files <担当ディレクトリ>`と`rg -n '<symbol>' <path>`で対象を探します。
2. 該当schema・実装・テスト、適用される階層のAGENTS、必要な文書節を読みます。
3. 関連テストで修正を確認し、最後は既存verify/source/PR/mainの検証を完了します。

README・ADR・Git履歴の全読込を定型作業にしません。広い変更のレビューでは必要な
全差分を読みます。関連検査だけの成功を全体検証・PR完了とは扱いません。

## ログと引継ぎ

長いコマンド出力は`.generated/`へ保存し、終了コード・reportの状態・失敗箇所から読みます。
`rg -n 'FAIL|error|unknown' <log>`などで絞り、必要なら前後へ広げます。検索結果だけで
成功判定せず、command receiptと終了コードを確認します。CIが収集する既存report markerは残します。
同じSHA・同じ条件の成功ログを再読込・再実行するのは、未解決リスクや必須ゲートがある場合だけです。
引継ぎには目的、branch/head、変更点、確認済み結果と証跡パス、残課題、次の操作だけを記載します。
証跡はsource・command・ログを一緒に保持し、別SHAへ流用しません。

## 文書と自動検査

起動はREADME、共通制約はAGENTS、操作手順はlocal-usage、設計判断は該当ADR、検証契約は
ハーネス文書を正本にします。他の文書ではリンクで参照し、巨大な案内や別AI用の全文コピーを作りません。
完了作業の経緯はPR/Issue/Git履歴へ残し、入口には現在の操作・制約・未完了事項だけを置きます。
既存リンク先の廃止や移動では参照元も修正します。

`node scripts/harness.ts context check`は全Markdown（md/mdx/markdown）のUTF-8 bytes、
入口合計、AGENTS/CLAUDE/SKILLごとの上限、全体上限、案内先とローカルinline linkを検査します。
上限の正本は[scripts/harness/context.ts](../../scripts/harness/context.ts)。日本語もbytesで計測し、
モデル固有のトークン数・料金・実際のAPI消費量とは区別します。節約率は文書サイズの比較です。
外部URL・anchor・reference形式リンクの正しさは検査しません。

未追跡ファイルも対象です。通常の`check:quality`→verify/sourceには`quality:context`、
軽量Docs CIには必須の`docs:context`として入り、既存ci-gateとdeliveryが欠落・失敗を拒否します。
全ファイルのサイズと指摘は通常のquality findingsまたはDocs成果物に保持します。
`context check`は成功0、違反1、入力/実行不備2。計測不能を成功にしません。
予算の自動引上げや除外追加で回避せず、まず重複を整理します。正当な拡張には根拠と
上限境界・失敗時テストを含む通常のPRレビューが必要です。
