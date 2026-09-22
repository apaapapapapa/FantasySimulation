# spatial-v1.7: 公開入力と実行manifest

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
装備は8個、状態の同時保持は既定予算64種（増額可能な上限256種）・各32stackとする。整数効果の集約・
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

## 静的戦場と初期配置（3D-03）

boxはyaw/slopeを固定sin表から正規化quaternionへ変換し、pillarは円柱として生成する。
地形queryではmovement/vision/attackを別々に指定する。目のLOSが通ることは、
より低い銃口や矢の発射点から攻撃が通ることを意味しない。

scenario.boundsから6枚のsolid境界を生成する。これは移動/視線/攻撃の壁であり、
場外を敗北とする新ルールではない。`boundary.{x,y,z}.{min,max}`は予約ID。
橋の上下面、床、天井は別の高さにある体積として残し、高さを単一の地表値へ潰さない。

spawnは身体全体のboundsと地形、相手身体との重なりを検証する。Rapier 0.20.0の
capsule/cuboid contact queryは対称軸上の薄い離隔を誤ってpenetrationと返すfixtureが
あるため、初期重なりはsegment/OBBの区分二次距離と直立円柱との距離で検証する。
微小な位置ずらしや乱数による回避は行わない。

地形へのsweepはRapierを使い、boxの面内部と確認できる接触ではその面の法線へ
戻す。これは床面での数値的な横方向の揺れを抑える処理であり、edge/cornerの法線は
保持する。2mmのskinは貫通判定の代替ではない。worldの所有者は成功/例外どちらでもfreeする。

## 同時移動（3D-04）

`moveActors`は20msの区間を処理する。双方の加減速・重力・向き・地形接触を同じ境界の
入力から計算し、その折れ線同士の相対sweepで最初の身体接触を求める。接触した双方は
同じ時刻で停止する。接触済みでも離れる運動は許可する。入力の身体状態を変更しない。

歩行速度は歩ける面に沿った速度、飛行速度は3Dの速度。歩ける傾斜では速度を接面へ
投影してから加減速し、斜面の鉛直成分を次区間へ保持する。限界を越える斜面を移動補正で
登らせない。重力は半陰的Euler（速度→位置）で毎区間適用する。接地時だけジャンプでき、
頭上の体積で止まる。移動不能でも重力は継続する。

段差は指定の高さ以内で、前方の歩ける上面と身体全体の上方・横方向clearanceを確認する。
20%の区間を持ち上げ、残りを横移動へ割り当てる。10mm以内に足場がある場合は最後の
20%を降下へ割り当てる。身体中心が縁へ達するまで複数区間かかる場合は重力で追跡し、
補正による上向き速度をジャンプ速度として持ち越さない。これらの区間は全て接触判定へ
渡し、端点だけを結ぶ直線へ省略しない。区間数の上限超過はSpatialBudgetErrorとなる。

着地damageは`floor(max(0, 着地直前の下降mm/s - 安全速度) × rate / 1000)`。
飛行中は重力を適用せず、失効後は保持していた鉛直速度へ重力が再び作用する。
高度はscenarioの天井によって制限される。滞空コスト・状態有効期限との接続は効果解決層が担う。

Rapierのf32 GJKが広い床の対称軸近傍で接触を見逃す／法線をずらす回帰例に対して、
カプセルとOBB/円柱の距離から法線を求め、平面内部の有効な接触時刻をbinary64で補完する。
裏面の平面やedge/cornerを平面の延長として扱わない。地形の候補選択・曲面のsweepは
Rapierを使い、接線・離脱方向の凸地形を除外して次の接触を検査する。

接地はsupport probeの検出だけでは確定しない。実際の接触時刻が余白から1μm以内であることを
必要とし、浮いた身体を早期に着地させない。身体同士の接触時刻が区間の末端と一致しても、
確定速度は双方0となり、次区間で離れる意図を直ちに反映できる。

## 地上・空中経路（3D-05a）

地上/空中nodeは身体中心を示し、同modeの同一座標重複と戦場外nodeを拒否する。
直進できる場合は探索しない。地上では全身体sweepに加え250mm以下の間隔で歩ける
支持面を確認する。段差は近接node間の高さ差・持ち上げ/横移動/降下のclearanceを確認する。
ジャンプedgeは初速・重力・速度上限を使った半陰的Eulerの放物線を20ms以下に分割し、
全区間をbody sweepする。経路は移動命令を提案し、実際の接触・加速・着地は移動層が確定する。

グラフedgeの幅は身体直径+4mm、頭上空間は全高+4mm以上を必要とし、実地形でも確認する。
地上と空中を混ぜず、橋の上下を別の支持面として残す。空中移動にも身体sweepを適用し、
壁や天井を無視しない。探索は距離costと直線距離heuristicを使い、同点は開始/目標に相対的な
幾何位置で固定する。配列/IDの順を優先順にしない。edge判定cacheは不変戦場・身体ごと。
探索上限はbudget-exceeded、到達経路がない場合はunreachableであり、両者を区別する。

## 観測と行動方針（3D-05b）

身体は直立し、ローカル+Xを前、+Zを右としてoffsetをyaw回転する。真上/真下の向きでは
offset用の水平軸をworld +Xに固定する。視野は3D円錐で、目からの距離・角度・vision LOSを
使う。攻撃遮蔽とは独立する。

知覚はreactionStepsごとに採取し、同じreactionStepsだけ遅れてAIへ渡す。初期境界の観測も
この遅延を受ける。観測は位置・速度・向き・採取時刻をdeep freezeしたsnapshotであり、後の
実体の移動で変わらない。見失った場合は最終観測をmemoryStepsまで保持し、相手の現在位置を
policyへ渡さない。回避の候補は視認済みの敵弾だけで、未来の弾・乱数・未確定行動を使わない。

条件は自己HP/MP、観測/記憶上の距離、観測上のvisible、自己状態、観測済み弾とall/any/not。
明示されたpriority順に、自己の使用可能な能力を選ぶ。近接/射撃の実際の開始・発射・命中検証は
攻撃層が行う。移動は接近、指定距離維持、観測弾からの回避、停止。飛行中は設定高度へ向かい、
飛行権限を失えば地上経路に戻す。飛行維持の資源消費は有限期間の状態を持つ能力の再使用コスト
として表し、無償で永久延長しない。状態付与/失効・コストの統合fixtureは3D-06で追加する。

回避の横方向は弾の速度に垂直な方向とし、弾の相対位置から離れる符号を選ぶ。真上/真下から
来る弾にも水平な回避方向を選び、弾が完全に同一直線上の場合だけ定義済みの右方向を使う。

## 効果と状態の同時解決（3D-06a）

ダメージは各効果ごとに`max(0, amount + floor(attack × attackScaleBps / 10000) - defense)`、
範囲攻撃等のcoverage、属性耐性の順に整数切捨てする。その対象へ同区間に届く耐性適用後の
ダメージを合計し、開始時と同区間付与のshieldを一括消費する。個々の吸収/HP向け内訳は
`総量 × 各寄与 / 寄与合計`の既約有理数で保存する。端数をID順へ配らない。

回復合計とshield後のダメージ合計を、コスト確定後のHPへ一度に反映して0〜maxHPへclampする。
先に回復上限で切り捨てず、確定済み効果を同区間の被弾や合法なHP自己コストで取り消さない。
計算の乗算・合算にはBigIntを用い、資源として安全整数へ戻す時に検証する。対象や効果の
列挙順は結果を変えない。戻り値のID整列は記録の正規化だけに使う。

状態は[startStep, endStep)。主行動の新規状態は次境界から有効であり、その区間の防御を
遡って変えない。期限切れを先に除き、継続効果は開始境界から定義した間隔で発火する。
endStepでは発火しない。継続damage/healはstackごとの効果として扱い、防御の適用単位を
cohortのまとめ方で変えない。解除は既存snapshotだけを対象とし、同時の新規付与を消さない。

同じstackKey・同じrevisionの同時付与はcohortとして扱う。sumは最大stackまで共有して受け入れ、
原因集合を保持する。異なる開始時刻のstackはそれぞれ期限を持つ。refreshは終了のみを延長して
周期の開始を動かさず、replaceは既存を除いて開始を更新、rejectは有効な既存があれば拒否する。
期限と新規開始が同じ境界なら古いcohortは新規付与を妨げない。同時に異なるrevisionが同じkeyを
要求する場合は優先規則を捏造せずunresolvedとする。単独のreplaceは明示的な置換として扱う。

状態の攻撃/防御修正はstack数で加算し、実効値は0以上。移動倍率は10000を基準とする差分を
加算し、0〜30000Bpsに制限する。flight/rootedは有効な状態の論理和。飛行権限が期限切れなら
次の移動で重力へ戻る。maxStatusTypes/maxStatusCausesはattemptの予算で、manifest/hashへ含めず
増額できる。上限超過はtruncatedであり、状態や原因を黙って捨てない。

## 行動時計と攻撃形状（3D-06b）

行動速度0では新規主行動を開始しない。正なら詠唱・硬直・cooldownは
`ceil(定義step × 10000 / actionSpeedBps)`。硬直は最低1stepで、攻撃の有効区間を終えてから
始まる。cooldownは発射予定境界から数える。物理移動と攻撃の有効時間は行動速度で縮めない。
costs.uses=0は無制限、正ならその能力の試合中の成功宣言回数上限。HP/MP不足時に部分消費は
行わず、HPをちょうど0にする支払いは合法。消費後の詠唱・発射不成立でも返金しない。

宣言・発射時の射程は観測/記憶上の相手中心と武器起点で確認し、後方への開始を認めない。
照準は発射境界の身体の向きに固定し、相手の現在位置へ瞬間的に向き直らない。照準誤差は
発射ごとに主体のPRNGを2回進め、local yaw/pitchへそれぞれ定義範囲の一様誤差を与える。
誤差0でも2回進める。通常弾には発射後の相手位置を自動注入しない。

hitscanは発射時点の起点からrangeまでを半径付きで検査し、最初の壁/身体に作用する。
meleeは半径radiusMmの球を、有効activeStepsの間に武器起点からreachMmまで前進させる
突きとして定義する。射程上限とreachの小さい方を実行時に使う。方向は発射時に固定し、
身体の移動折れ線に突きの進行を加えた軌跡を保持する。動く対象との相対sweepで命中を調べる。
同一instanceは対象へ1区間に最大1回、全有効時間でmaxHitsPerTarget回まで作用する。
既定の1回は複数stepの接触で重複しない。壁接触はinstanceを終了する。

攻撃の開始重なりは命中として数え、身体移動の「離れる接触は止めない」と区別する。
壁/身体の接触がepsilon以内なら壁優先。身体中心と武器offsetの間にも遮蔽検査を行い、
武器だけを壁の向こうへ生成しない。接触時刻は表示/最初の接触選択に使い、HP確定は同区間末尾。
