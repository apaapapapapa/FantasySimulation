# 3D専用のrevision保存世代

Issue #1のP3としてDB世代を`local-v1`から`spatial-v1`へ置換する。
共有migration runnerと`db/schema.json`を使用する。旧001 SQLと旧同期API/実行系は
この世代では不要なため除去し、新しい002から空DBを初期化する。旧DBの自動変換はしない。
同じ世代に追加するSQLは引き続き追記式・checksum検証付きとする。

公開revisionはkind/definition ID/revisionの複合主キー、内容hashと構造化定義を保持する。
DB triggerでUPDATE/DELETEを拒否する。編集は新revisionを発行する下書きへ分離し、
PATCHとpublishはexpectedVersionを要求する。非同期検証中の編集もpublish直前の
短いトランザクションで再確認し、古い編集の上書きと二重公開を防ぐ。

下書きは未完成のJSONを許容する。公開時にはschema・内容hash・型付き参照と
キャラクター方針の利用可能能力を検証する。公開済み参照のみを辿り、戦闘manifestには
必要なclosureを固定する。公開revisionの変更・latestの試合中参照は行わない。
BattleSpecは固定manifestとsimulationHashを一度保存する。予算・job/attempt・実時計は
別データで、同じ意味の対戦を予算増加で再試行可能にする。

新規DBへの明示的な切替例:

```sh
pnpm db:reset ./data/fantasy-spatial.sqlite --confirm-generation spatial-v1
```

`DATABASE_PATH=./data/fantasy-spatial.sqlite`を指定して起動する。resetは既存のファイルを
開かず、新しい宛先のみを作成する。旧ファイルの削除や勝敗の推測はしない。
サンプルは`data/spatial/catalog.json`の不変revisionを使用し、既存IDを上書きしない。
Worker・job・artifactの永続化は同じ世代に後続migrationで追加する。
