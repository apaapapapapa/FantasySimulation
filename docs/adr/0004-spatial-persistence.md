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

Issue #59以降は戦闘ルールの版ごとに新しいDB・artifact rootを使う。
既定値は`data/<CURRENT_ENGINE_VERSION>/fantasy.sqlite`と同じディレクトリの`replays`。
`DATABASE_PATH`と`ARTIFACT_PATH`を未指定にすると版更新へ自動追従する。
新規DBは`pnpm dev`または`pnpm db:seed`で公式migrationとseedを実行して初期化する。
明示したDBの保存済みrulesVersion/engineVersionが現在と違う、混在する、または不明なら
書込み前に保存版・現在版・新規パスの案内を含む`StorageVersionError`で停止する。
artifact rootも対応するDBの既存`.store-id`所有権を満たす必要がある。
旧DB・下書き・artifactはそのまま残し、変換・取込み・旧engine実行を行わない。
新版の一覧には旧結果を表示しない。対応schemaの保存記録はexport等の経路で扱う。
不要な旧版ディレクトリはAPI停止とバックアップ後に手動削除する（READMEのOS別例参照）。
自前resetやschema世代宣言は追加しない。
サンプルは`data/spatial/catalog.json`の不変revisionを使用し、既存IDを上書きしない。
Worker・job・artifactの永続化は同じ世代に後続migrationで追加する。
