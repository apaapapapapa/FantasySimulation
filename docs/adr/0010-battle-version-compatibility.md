# ADR 0010: 戦闘版と保存データの互換性

Issue #59の2026-09-23改訂。版ごとに新DBを作る旧決定を置き換える。Refs #1, #45, #61。

## 追加と版更新

schemaは省略可能な項目・列挙値の追加で広げ、省略時の既存fixtureを維持する。
既存項目の削除、意味・範囲・必須性の変更は原則禁止。保存revision・結果・replayを
同じDBで厳格に検証して読み、利用者の定義・下書き・結果を無言で変換しない。

判断を変える場合はrules/engine版を上げ、新rulesを別IDで追加する。
実装digest・コーパス・fixture・ルール文書を同じPRでレビューし、差の理由を記録する。
失敗を通すためだけに期待値を再生成しない。旧engineの登録・ロード・再実行は行わない。

保存用`StoredManifestSchema`を実行用`ManifestSchema`から分離する。
`unsupportedExecutionReason`はengine/AI/実装identityを判定する。
旧版の未完了jobは理由付きで失敗とし、再試行・replay復旧は409で拒否する。
実行と再試行は`Store.requireExecutableSpec`、新規入力は`prepareSpec`で検査し、
旧rules指定には現在版を選ぶよう案内する。保存済み結果とdisplay/replayは読めるまま残す。

## サンプル

変更には新IDを使う。配布済みidentityは`data/spatial/published-revisions.json`へ追記し、
catalog検査とCIで再hash・revision・欠落・ID重複を検査する。seedは既存IDを上書きしない。

PR #57で`flat`・`pillars` rev 1に`terrainKnowledge: surveyed`が追加された履歴は残す。
配布用の正本は#57後の内容を固定する。既存DBの追加前（省略=observed）・後の双方を変換しない。
新規参照には`flat-surveyed-v1`・`pillars-surveyed-v1`を追加し、catalogの既定は後者とする。
両DBへ同じ内容で追加できる。旧IDを明示した呼出し・固定コーパスは従来の入力を維持し、
alias化しない。既存の保存revision参照はその内容に従う。

## 避けられない非互換変更

PRのADRで必要性・影響を記録した場合だけDBとartifact rootの両方を版別にする。
旧ファイルは削除・移動・変換しない。`.store-id`保護を迂回しない。
明示した`DATABASE_PATH`・`ARTIFACT_PATH`が対応外なら、書込み前に保存版・現在版・
新規パスの対処を示して停止する。この例外機能は必要時に実装し、現在の既定パスは維持する。
schema世代宣言・checksum receipt・reset・自前migration runner・履歴tableを復活させない。
relational schemaは[公式Drizzle](0005-drizzle-kit.md)で変更する。

## 検証

各PRで追加/判断変更/非互換を分類し、省略時の動作・旧定義読取・未対応版拒否を検証する。
実際の旧コード2版のSQL exportとreplayは[fixture](../../apps/api/fixtures/compatibility/README.md)に固定。
`version-compatibility.test.ts`で起動・seed・API取得・未完了job/再試行/復旧拒否を確認する。
復元は試験用だけで、製品へ旧engineや別migrationを追加しない。
版と新IDの整合、digest/corpus差分をレビューし、verify・clean source・Linux CI・main確認を完了する。
