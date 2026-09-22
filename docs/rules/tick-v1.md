# tick-v1 / rules 0.2.0

Issue #1 P1の実行可能な契約。`basic-v1 / 0.1.0`とは別の入口で提供する。
旧schema、旧API、旧DB、旧対戦ルールは引き続き旧エンジンを使う。
この文書のP1規則と`packages/domain/src/tick-v1`のschemaを正本とし、
判定を変える変更は新rules / engine版として追加する。

## 識別子と実行方法

| 対象                     | 固定値                  |
| ------------------------ | ----------------------- |
| manifest schema          | `2`                     |
| イベント / report schema | `1` / `1`               |
| rules / engine           | `tick-v1 / 0.2.0`       |
| 正規化                   | `canonical-json-v1`     |
| PRNG                     | `xorshift32-13-17-5-v1` |
| 主体別seed導出           | `character-sha256-v1`   |

`@fantasy/domain/tick-v1`は契約・revision作成・検証、`@fantasy/engine/tick-v1`は
`createTickManifest`、`prepareTickBattle`、`simulateTickBattle`を公開する。
すべての参照を解決したrevisionを`createTickManifest`へ渡し、返されたmanifestを保存して再実行する。
hash計算に標準Web Cryptoを使うため非同期関数だが、入出力にDB・HTTP・実時計・暗黙の乱数は使わない。

```sh
vp run demo:tick
vp test packages/engine/src/tick-v1/simulate.test.ts
```

デモはコミット済みJSON fixtureを読み、結果・ログ・hashを標準出力へ出す。SQLiteや開発サーバーは不要。
ブラウザーではWeb Cryptoが使えるsecure contextが必要。P1では画面との接続は行わない。

## 入力と数値

キャラクター、能力、行動方針、rules、scenarioはすべて`revisionId / contentHash / definition`を持つ。
characterには原文`sourceText`も保存する。個々のrevisionのschemaはmanifest schema 2により固定する。
内容hashはdefinition全体のSHA-256。参照欠落、余分な能力、重複能力、同じrevision IDの異なる内容、hash不一致を拒否する。
装備は空配列だけを受理する。キャラクターIDが同一の自己対戦は拒否する。

| 数値                                 | 単位・許容範囲                                        |
| ------------------------------------ | ----------------------------------------------------- |
| maxHP / 現在HP                       | 整数資源、1〜1,000,000 / 0〜maxHP（初期HPは1以上）    |
| maxMP / 現在MP                       | 整数資源、0〜1,000,000 / 0〜maxMP                     |
| HP・MPコスト / 回復量 / 初期シールド | 整数資源、0〜1,000,000                                |
| 攻撃 / 防御 / 威力 / 速度            | 整数、0〜10,000                                       |
| 耐性 / 命中率                        | basis points、0〜10,000（10,000で100%）               |
| 位置 / 距離                          | 一次元整数、-10,000〜10,000 / 位置差の絶対値0〜20,000 |
| ゲーム内tick / maxTick               | 整数tick、0〜1,000,000（終了tickを含む）              |
| recoveryTicks                        | 速度100での待ちtick、1〜10,000                        |
| seed                                 | 非ゼロ32bit符号なし整数、1〜4,294,967,295             |

小数、NaN、Infinity、負のゼロ、安全整数範囲外の値は拒否する。
最大のダメージ中間積は`20,000 × 10,000 = 200,000,000`、HP集約も安全整数範囲内に収まる。
ダメージ丸めは耐性適用後の切捨て、待ち時間は切上げ。それ以外に暗黙の丸めはない。
位置は入力・状態・hashに保持し、P1のdamageは距離に関係なく相手へ、healは自分へ作用する。

## 行動と同時処理

能力は`trigger: action`、1つの`damage / heal / wait`効果、コスト、待ち時間を持つ。
開始時効果・受動回復・反応・状態効果はない。方針は能力revision IDの有限リストを先頭から繰り返す`cycle`。
同じ能力IDを方針に複数回記載することは可能で、配列順は意味を持つ。

両者の初回行動はtick 0。次回行動までの待ちは次の整数で固定する。

`delay = max(1, min(1,000,000, ceil(recoveryTicks × 100 / max(1, speed))))`

速度0は実効速度1。wait、不発、極端な高速でもdelayは1以上。同tickで複数回行動しない。
次の予約tickに直接移動し、空tickを走査しない。予約がmaxTickを超えればmaxTickで時間切れとなる。

1. そのtickに予約された生存主体が、同じ確定状態から行動を宣言する。
2. HP不足、次にMP不足を調べる。不足時は不発、コスト0、効果なし。方針の次項へ進み、通常と同じdelayを待つ。
3. 有効な宣言の干渉規則を確認する。欠落があればそのtick全体を未適用のまま`unresolved`とする。
4. 両者のHP/MPコストを確定する。HPをちょうど0にする自己コストも合法。
5. 同じ段階開始時の値から効果を計算し、対象別に集約する。
6. `HP' = clamp(開始HP - HPコスト + 回復合計 - HP向けダメージ合計, 0, maxHP)`を一度だけ適用する。
7. 戦闘不能を判定し、次回予約と時間上限を処理する。

相手の同時攻撃や自己コストでHP0になっても、確定済み主効果を取り消さない。
同時回復で致死ダメージや自己コストを相殺できる。回復だけを先に上限で切り捨てない。
開始HP100・回復20・ダメージ30なら90。開始HP10・回復20・ダメージ15なら15。

## ダメージ・命中・シールド

命中時のみ`base = max(0, 攻撃 + 威力 - 対象防御)`を計算する。
`resisted = floor(base × (10,000 - 対応耐性bps) / 10,000)`、
`absorbed = min(開始シールド, resisted)`、`damageToHp = resisted - absorbed`の順に適用する。
物理と魔法にはそれぞれ独立の耐性値がある。シールドは吸収量だけ減り、時間で回復しない。
外れた場合はすべて0。`damageToHp`は残HPによる切捨て・同時回復による相殺の前の値であり、実際のHP差分ではない。
実際の変化は`state`イベントに記録する。

| aim           | 対象avoidance   | 判定                                                          |
| ------------- | --------------- | ------------------------------------------------------------- |
| `roll`        | `normal`        | 0〜9,999の標本がaccuracyBps未満なら命中                       |
| `certain-hit` | `normal`        | 必中（accuracyBpsに依存しない）                               |
| `roll`        | `certain-evade` | 必ず回避                                                      |
| `certain-hit` | `certain-evade` | `unresolved`、rule ID `accuracy.certain-hit-vs-certain-evade` |

必中と絶対回避は両方とも受理済みの定義なので、この衝突を入力エラーや引分に変換しない。
未知の効果型や未実装の条件ASTは実行前の検証エラーであり、この診断とは区別する。

P1は1対1かつ一主体一効果のため、一対象へ同tickに届くdamageは最大1件。
複数効果配列はschemaで拒否する。P2の複数damageでは、個別の防御・耐性後の値を対象別に合計して
シールドを一度だけ消費する方針を固定する。内訳は`吸収総量 × 各damage / damage総量`の厳密な有理数とし、
表示時だけ丸める。端数を先着やID順へ加算して戦闘上の有利不利を作らない。この拡張には新rules版が必要。

## P2へ引き継ぐ状態・位置の境界

以下はP2実装時の固定方針であり、P1のschemaでは関連フィールド・効果を受理しない。

- 状態は`[開始tick, 終了tick)`。tick更新時に期限切れを先に除く。
- 主行動で付与する状態は次tickから有効。期間dなら`[付与tick+1, 付与tick+1+d)`、dは1以上。
- 同tickの解除は段階開始時に存在する状態を対象とし、そのtickの新規付与を消さない。
- 継続効果の初回発火は開始tick、次回は定義済みの正の間隔後。終了tickでは発火しない。
- 状態の重複処理は型で宣言する。加算は上限を最後に適用、更新は終了tickの最大値、重複拒否は既存を保持する。
  同時の異なる置換値に優先規則がなければ`unresolved`。列挙順で決めない。
- 位置共有・すれ違いを許可する。射程は宣言時の位置で判定し、同時移動を先着順に反映しない。

## PRNGと再現性

PRNGは[Marsagliaのxorshift](https://www.jstatsoft.org/article/view/v008i14)の32bit版、
シフト`13, 17, 5`。暗号用途には使わない。
状態1からのraw列は`270369, 67634689, 2647435461, 307599695, 2398689233`。

各主体の初期状態はcanonical JSONの`["character-sha256-v1", seed, character.contentHash]`をSHA-256化し、
先頭4byteをbig-endianのuint32として読む。0なら1へ置換する。
主体別ストリームを持つため、左右の入替や表示用走査順で乱数の割当は変わらない。
character内容が変わればストリームも変わる。revision IDだけの変更は同じ内容hashなら同じストリーム。

有効なdamageごとに必中・必避も含めて1つのbps標本を消費する。heal / wait / 不発は消費しない。
raw値1〜4,294,967,295から1を引き、4,294,960,000未満だけを受理して10,000で剰余を取る。
剰余の偏りを避ける棄却法で、棄却候補は7,295値。全周期の非反復性から最大7,296回のraw生成で終了する。
計算予算でbatchを破棄した場合、そのbatchの乱数状態も適用しない。

## 正規化・hash・実装識別

入力を検証・複製し、resolvedな`abilities`一覧だけをrevision ID順に整列してdeep freezeする。
呼出し元の値は変更・凍結しない。definition内の配列（能力参照、方針等）はrevisionの内容として順序を保つ。
左右の主体・開始位置を正規化で入れ替えない。

canonical-json-v1はオブジェクトキーをUTF-16コード単位順に整列し、空白なしのJSONにする。
文字列はJSONのエスケープを使い、Unicode正規化は行わない。配列順を保持する。
plain object以外、アクセサー、symbol、循環、疎配列・拡張配列を拒否する。
最大20,000ノード、深さ32、文字列とキーの合計1,000,000 UTF-16単位。
結果のバイト列はUTF-8、hash表現は`sha256:`と64桁の小文字16進数。

- `simulationHash`: 正規化manifest全体。seed、全revision、schema/rules/engine版と実装digestを含む。
- `eventsHash`: canonical JSON化したイベントを順に並べたJSON配列のSHA-256。
- `resultHash`: `{simulationHash, eventSchemaVersion, eventsHash, outcome, tick, finalState}`のcanonical hash。

日時、ジョブID、Worker番号、計測値、attempt予算はmanifest・確定結果hashに含めない。
resolved能力一覧順やJSONキー順だけの差は同じhashになり、方針・開始位置・seed・ゲーム内期限の変更は別入力となる。
リーグmaster seedから対戦seedを作る計画はP5で実装する。P1は明示seedを受け取り、リーグID等を混ぜない。

`scripts/engine-identity.ts`がdomain / engineのtick-v1実装ソース、package設定、lockfile、
Node版、tsconfig、生成手順自身から実装digestを算出する。
POSIXパス順の`[path, LF正規化済みUTF-8文字列]`配列をJSON化してSHA-256を取り、
`implementation.json`へ保存する。test / fixture / 生成JSONは入力から除外する。
LF正規化によりWindowsとLinuxで一致する。ソースや固定依存が変わると`engine:check`が失敗する。
異なるdigestのmanifestは実行せず、対応する保存版engineを要求する。digestだけから旧コードを復元はしない。

```sh
# 規則・版・ソース変更をレビューした後だけ実行する。
vp fmt
vp run engine:stamp
vp run fixtures:tick
vp fmt
vp run verify
```

Golden fixtureはmanifestと期待hash・状態・結果をJSONとしてコミットする。
検証中に期待値を自動更新しない。fixture生成とは別に、数式の具体値・境界・対称性をテストする。

## 終了・計算予算・イベント

| outcome                      | 条件                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `win`                        | 同時反映後に片方だけHP0                                                     |
| `draw / simultaneous-defeat` | 同時反映後に両方HP0                                                         |
| `draw / time-limit`          | maxTickの予定処理まで完了し、双方生存                                       |
| `unresolved`                 | 受理済み能力の干渉規則が不足。rule ID・tick・主体・対象・能力revisionを記録 |
| `truncated`                  | 計算予算不足。種別・未処理tick・設定上限・必要量を記録                      |

attempt予算は`maxEvents`（0〜50,000）、`maxTicks`（処理batch数、0〜50,000）、
`maxLogBytes`（2〜8MiB）。既定値は各最大値。
ゲーム内時刻のmaxTickと処理batch数のmaxTicksは異なる。
イベント数・byte数はstartを含む。byte数はcanonical JSON配列の括弧・カンマ・UTF-8をすべて含む。
上限を超えるtickはコスト・主効果・乱数も含めて一切適用せず、最後に確定した状態を返す。
`tick`は最後の確定tick（開始前は0、時間切れはmaxTick）、診断は未処理tickを別途示す。
予算判定はtick数→干渉確認→イベント数→byte数の順。startの収容確認を最初に行う。
startさえ収容できない予算ではeventsは空配列となる。

イベント順はstart、各tickの左・右action、左・右effect、state。
これは表示・hashの順序であって戦闘優先順位ではない。不発はactionに理由を記録しeffectを出さない。
stateは段階前後の両者HP/MP/シールド/位置、damageは防御後・耐性後・シールド後の値を持つ。
勝敗・未定義・打切りの最終診断はreport.outcomeに記録する。

件数・byte数と入力サイズを制限し、ログの無制限蓄積を避ける。圧縮artifact、実時間制限、Workerの
メモリ計測・プロセス制限・中止・永続化はP3で追加する。ホストtimeoutを引分として返す処理はない。
予算増加で同じsimulationHashを再試行できる。確定結果のhashは十分な予算なら一致する。
打切りの診断には上限値を含むため、打切り結果hashは予算次第で変わり得る。
将来のキャッシュ対象は`win / draw`だけ。P1自体はキャッシュやDBを持たない。
