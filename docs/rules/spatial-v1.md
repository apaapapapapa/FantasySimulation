# spatial-v1.0: 公開入力と実行manifest

3D-02で固定する公開契約。実際に受理する項目は`packages/domain/src/spatial`のstrict Zod
schemaを正本とする。3D-03〜07で実行系を追加し、3D-08でAPIへ接続する。
旧契約を3Dへ暗黙変換しない。

## 単位と上限

右手系、X/Z水平、Y鉛直。公開座標・速度・加速度は整数mm、mm/s、mm/s²。
方向ベクトルは非零の整数比。角度は整数millidegree、比率は10,000を1とする整数Bps。
行動速度、移動速度、加速度、旋回、知覚範囲、反応間隔は別の値である。
actionSpeedBps=0は新しい主行動を開始できないことを表し、移動速度0と同一ではない。

| 値                                 | 許容範囲                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| 各座標/方向成分                    | -1,000,000〜1,000,000                                            |
| 戦場の各軸extent                   | 正、200,000mm以内                                                |
| HP/MP/基本攻撃/基本防御/初期shield | 0〜1,000,000（最大HPは正）                                       |
| 身体                               | 直立カプセル、半径1〜5,000mm、高さ1〜20,000mm、height ≥ 2 radius |
| 物理移動/加速度                    | 0〜100,000mm/s、0〜100,000mm/s²                                  |
| 飛翔体速度                         | 1〜1,000,000mm/s                                                 |
| 物理区間                           | 20ms固定、1〜6,000区間                                           |
| 条件式                             | 深さ4、all/anyの子1〜8、限定ASTのみ                              |
| 公開manifest                       | revision最大256、地形256、経路node4096/edge16384                 |
| JSON境界                           | 100,000 node、深さ24、保守的UTF-8見積4MB                         |

カプセル半円柱長はheight/2-radius。positionは身体中心。標準身体はradius=300mm、
height=1800mm。y=0の床に接する中心は900mmで、移動余白2mmを取る標準spawnは902mm。
eye/muzzle/aim offsetは身体を基準とする。天井/地形との重なりは3D-03のshape queryで
検査する。定義の座標範囲だけでspawnが合法とは扱わない。

差分成分最大2,000,000の距離二乗和は12×10^12、方向内積は3×10^12で、
安全整数上限2^53-1以内。角度の二乗や速度Bps乗算もこの上限を越えない範囲で計算する。
装備は8個、状態の同時保持は64種・各32stackを実行上限とする。整数効果の集約・
耐性/シールドの比例配分には必要に応じBigInt有理数を使用し、巨大な積をnumber経由で
丸めない。予算の枯渇はtruncatedであり、能力を黙って省かない。

物理の内部はm/sと浮動小数点。静的地形queryはRapier境界でbinary32へ変換、
直立カプセル同士の相対sweepとTS状態はbinary64。保存/hashではIEEE754 binary64の
big-endian hexへ変換し、-0を+0へ正規化、NaN/Infinityを拒否する。表示用の丸めを
計算に戻さない。固定sin表とWASM bytesのhashもmanifestに含む。

## 型付き構成

characterは能力・装備・方針revisionを参照する。装備は能力を参照でき、能力の
apply-statusは状態revisionを参照する。状態は他revisionを参照しないため、型の依存関係は
循環しない。JSON自体の循環は再帰schemaへ渡す前に拒否する。

能力はtrigger、condition、target、cost、cast/recovery/cooldown、攻撃形状、effectsを持つ。
初版triggerはaction/battle-start。directはselfのみで、enemyはmelee/hitscan/projectileの
幾何判定を必要とする。開始時効果はself・cast0のみ。未知のtrigger/effectや任意コードは
拒否する。反射・蘇生・テレポートなどP6の型は未公開である。

地形はbox（yaw/slopeで斜面も表現）またはpillar。movement/vision/attackの遮蔽フラグを
分離する。経路は高さを含むground/air nodeとwalk/jump/fly edgeで構成し、幅・頭上空間を
持つ。グラフに辺があっても、実際の身体sweepで通行を確認する。

## revisionとhash

revisionはkind/id/revision/schemaVersion/contentHash/definitionを持つ。
contentHashは`{kind,schemaVersion,definition}`の正規化JSONをUTF-8 SHA-256で識別する。
公開後の書換えを許可しない。refはid/revision/contentHashの3値を固定する。

`prepareBattle`は全定義のcontent hash、参照のkind/id/revision/hash、能力重複、方針の
能力参照、参加者ID、身体の戦場境界を検証する。新しいmanifest schema 3には、
2参加者の配置・向き・乱数stream、ruleset/scenario、解決済みrevision、seed/PRNG版、
engineVersion/実装digest、physics profile本体とhash、WASM/table hashを記録する。

正規化はobject keyをASCII順にする。resolved revisionsは集合としてkind/id/revision順に
正規化する。参加枠、effects、policy prioritiesなど意味を持つ配列を勝手に並べ替えない。
simulationHashはこの確定manifestのhash。計算予算、Worker数、attempt ID、実時計は
manifestに含めず、同じ試合を予算増加して再試行できるようにする。

乱数はxorshift32-v1。actorSeedを対応する主体に固定し、主体/位置/向き交換時には
streamも一緒に交換する。seed0は固定の非零初期値へ写す。PRNGは照準確定時だけ消費し、
候補列挙や描画fpsには依存させない。照準誤差は発射時に固定し、通常命中に旧accuracy乱数を
重ねない。master seedからactor seedへの生成手順はrunnerのactor-stream-v1として固定する。

event/result schemaは新形式のみを定義する。win/draw/unresolved/truncatedを区別し、
event hash、表示軌跡hash、TS state hash、Rapier snapshot hashを別々に持つ。
ホストfailed/cancelledはjob/attemptの状態であり、勝敗やdrawへ変換しない。
