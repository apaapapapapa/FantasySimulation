# 3D専用のrevision保存世代

Issue #1のP3としてDB世代を`local-v1`から`spatial-v1`へ置換する。
保存モデルの決定は維持する。マイグレーション・世代検証・resetの運用は
[ADR 0005](0005-drizzle-kit.md)によりDrizzle Kitへ置換した。旧実行系/APIの互換は追加しない。

公開revisionはkind/definition ID/revisionの複合主キー、内容hashと構造化定義を保持する。
DB triggerでUPDATE/DELETEを拒否する。編集は新revisionを発行する下書きへ分離し、
PATCHとpublishはexpectedVersionを要求する。非同期検証中の編集もpublish直前の
短いトランザクションで再確認し、古い編集の上書きと二重公開を防ぐ。
003 SQLで下書きに編集元revision/hashを固定し、作成時と公開トランザクション内で
最新revisionとの一致を要求する。別々の下書きや新規IDの同時公開も片方を409で拒否する。
公開成功時のみ編集元を自身の新revisionへ進める。既存のbase未記録下書きは
既存定義を公開できず、最新revisionから作り直す。

下書きは未完成のJSONを許容する。公開時にはschema・内容hash・型付き参照と
キャラクター方針の利用可能能力を検証する。公開済み参照のみを辿り、戦闘manifestには
必要なclosureを固定する。公開revisionの変更・latestの試合中参照は行わない。
BattleSpecは固定manifestとsimulationHashを一度保存する。予算・job/attempt・実時計は
別データで、同じ意味の対戦を予算増加で再試行可能にする。

新規DBへ切り替える場合は`.env`の`DATABASE_PATH`に未使用のファイル名を指定し、
`pnpm db:migrate`を実行する。自前resetは廃止し、既存ファイルを削除しない。
サンプルは`data/spatial/catalog.json`の不変revisionを使用し、既存IDを上書きしない。
Worker・job・artifactの永続化は同じ世代に後続migrationで追加する。
