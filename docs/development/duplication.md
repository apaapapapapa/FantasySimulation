# 重複コードの防止と共通化

## 変更前に探す

実装前に既存の公開関数、同じ責務の実装、`test-support` を検索します。
本体の共通処理は責務を持つモジュール内に置き、テスト用の準備処理は
パッケージ内の `test-support` に置きます。本体からテスト用コードを参照しません。
テスト名・入力差分・期待値を呼び出し側に残し、期待値の計算を本体と共通化しません。
同じ振る舞いの入力違いには `it.each` を使い、無関係な処理の過剰な抽象化は避けます。

共通の戦闘fixtureは `packages/engine/test-support/fixtures.ts` です。
`combatManifest` は能力・戦闘方針・キャラクターを編集し、revisionを再封印して参照を接続します。
`editScenario` は指定されたscenarioだけを置き換え、他のrevisionを変更しません。
`terrainBattle`、`boxObstacle`、`glassWall` は独立した地形入力を生成します。
`battleEvents` は保存ログからイベントを取り出します。物理worldの解放は利用側の責任です。
品質チェックの一時プロジェクトは `scripts/quality/test-support/project.ts` を使い、必ず破棄します。

## ローカルとCIで同じチェックを使う

```sh
vp run check:quality
vp run verify
# レビュー済みの変更をcommitしたcleanなtreeで実行する
vp run harness source .generated/harness/source-unique-id
```

`quality:duplication` は `verify` に含まれ、既存のLinux CIを失敗させます。
別の検査workflowや修復ループは追加しません。通常の品質成果物に指摘の両側のパス・
開始/終了行・ノード数・修正方針を保存します。
`.generated/harness/quality/findings.json` の `details.duplicationCoverage` は選択した
ファイル一覧と検査ポリシーを示します。解析完了は `report.json` の結果で確認します。
sourceハーネスのcleanチェックとSHA付き証跡を併用し、未commitのローカル結果を
別commitの合格証跡として扱いません。

## 判定範囲と限界

既存の固定バージョンTypeScriptパーサーを再利用し、ASTフラグメントが
**40ノード以上かつ両側8行以上**一致した場合に失敗します。割合の許容値や既存重複の
ベースラインはありません。同一ファイル内、別ファイル間、ソースとテスト間を検査し、
TSXとテストhelperも含めます。未追跡・未ステージのローカルファイルもgitの列挙に含めます。
依存物・生成出力の `node_modules`、`.generated`、`dist` は対象外です。
TS以外のファイルはこのAST検査の対象ではなく、既存のソース形式ガードも維持します。

空白・コメント・通常の文字列の引用符差は無視します。import/export宣言だけの
ボイラープレートは対象外で、exportされた関数の実装は検査します。名前・リテラル値・
演算子は保持します。部分一致の末尾は未一致の子要素まで行範囲を広げません。
文字列に含まれたサンプルコードは再解析しません。

これは構文的な重複検出であり、変数名を変えたコピー、閾値より短い共通処理、意味的に
同じ別実装までゼロである証明ではありません。そのため実装前の検索とレビューも必須です。
検出を回避するための変数名・整形変更、テスト全除外、抑制コメント、閾値引き上げはしません。
解析失敗、空/不足した入力、ノード数や比較回数の上限超過は `unknown` とし合格させません。
検出ありはexit 1、証跡不十分はexit 2です。閾値や範囲の変更は独立したポリシーレビューと
陽性・陰性・失敗時の回帰テストを必要とします。

## 導入時の監査

監査元はmain `1ebd0b11a039e5b448d35ace669f66b66266db3d` です。
同一の検出器で110個のTS/TSXを検査し、4組を検出しました。
`simulate.ts` の例外から対戦結果への変換と発射口遮断時の処理、
`movement.test.ts` の待機ステップ反復、`projectiles.test.ts` と `simulate.test.ts` の
地形準備を共通化しました。併せて近似した戦闘fixture、地形revision編集、
品質テストの一時プロジェクト準備も統合しています。変更後は検出対象の重複0組です。

戦闘ルール・保存データ形式・期待ハッシュは変更しません。実装ソースの変更による
implementation digestのみ、差分確認後に明示的に更新します。CIで自動更新しません。
古い移行SQLや決定性fixtureを書き換えて検証を通過させることも禁止します。
