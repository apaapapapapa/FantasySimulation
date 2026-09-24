# 重複コードの防止と共通化

## 変更前に探す

実装前に既存の公開関数、同じ責務の実装、`test-support` を検索します。
本体の共通処理は責務を持つモジュール内に置き、テスト用の準備処理は
パッケージ内の `test-support` に置きます。本体からテスト用コードを参照しません。
テスト名・入力差分・期待値を呼び出し側に残し、期待値の計算を本体と共通化しません。
同じ振る舞いの入力違いには `it.each` を使い、無関係な処理の過剰な抽象化は避けます。

共通の戦闘fixtureは `packages/engine/test-support/fixtures.ts` です。
`combatManifest` は能力・方針・キャラクターを編集し、公開 `ManifestBuilder.relink` で参照を接続します。
入力生成はengineの `ManifestBuilder`（`from`・`create`・`participants`・`build`）を使います。
`relink` の外部参照は組立て中として保持し、`build` で閉包と実行可否を検証します。
参照の列挙・走査はdomainの `revisionDependencies`・`resolveClosure` に集約します。
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
Limits: 250,000 nodes/file, 500,000/repository, 1,000,000 comparisons, recorded in policy evidence.
Invalid/incomplete analysis or exhausted limits stays `unknown` (exit 2); clones fail (exit 1).
Policy changes require separate review and positive/negative/failure regression tests.
