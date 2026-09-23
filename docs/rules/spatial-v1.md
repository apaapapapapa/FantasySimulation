# spatial-v1.11: 公開入力と実行manifest

公開契約の正本は`packages/domain/src/spatial`のstrict Zod schema。旧契約を暗黙変換しない。
観測AIの式・情報境界・記憶・乱数は[ADR 0009](../adr/0009-observed-ai.md)を参照。

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

character references abilities/equipment/policy; equipment references abilities;
apply-status and status transform reference exact status revisions. Preparation/storage collect
and validate this bounded closure. JSON object cycles are rejected before schema parsing.

Abilities declare trigger/condition/target/cost/clocks/shape/effects. Triggers: action/battle-start;
startup requires self/cast0; direct is self-only; enemy effects require melee/hitscan/projectile contact.
Unknown triggers/effects/code are rejected. Reflection/revival/teleport remain P6.
Terrain: box (yaw/slope) or pillar with independent movement/vision/attack flags.
Ground/air nodes and walk/jump/fly edges carry elevation/width/headroom; body sweeps validate passage.

## revisionとhash

revisionはkind/id/revision/schemaVersion/contentHash/definitionを持つ。
contentHashは`{kind,schemaVersion,definition}`の正規化JSONをUTF-8 SHA-256で識別する。
公開後の書換えを許可しない。refはid/revision/contentHashの3値を固定する。

`prepareBattle`は全定義のcontent hash、参照のkind/id/revision/hash、能力重複、方針の
能力参照、参加者ID、身体の戦場境界を検証する。新しいmanifest schema 3には、
2参加者の配置・向き・乱数stream、ruleset/scenario、解決済みrevision、seed/PRNG版、
engineVersion/実装digest、physics profile本体とhash、WASM/table hashを記録する。

正規化はobject keyをASCII順にする。resolved revisionsは集合としてkind/id/revision順に
正規化する。参加枠、effects、policy prioritiesなどの入力配列をhash正規化で勝手に並べ替えない。
AI評価時のprioritiesは条件付き候補の集合として扱い、列挙順によるutility加点をしない。
simulationHashはこの確定manifestのhash。計算予算、Worker数、attempt ID、実時計は
manifestに含めず、同じ試合を予算増加して再試行できるようにする。

乱数はxorshift32-v1。actorSeedを対応する主体に固定し、主体/位置/向き交換時には
streamも一緒に交換する。seed0は固定の非零初期値へ写す。照準streamは照準確定時だけ消費し、
判断はaiProfileのactor-purpose-rejection-v1で導出した独立のaction/dodge streamを使う。
唯一候補では消費せず、候補列挙や描画fpsには依存させない。照準誤差は発射時に固定し、通常命中に旧accuracy乱数を
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

全地形を経路判断へ渡すのはscenario.terrainKnowledge=surveyedの場合だけ。
省略またはobservedでは、遅延した観測点・法線の局所地図と短い探索移動を使う。
以下のグラフは明示的な事前知識がある場合の経路契約で、実際の衝突は常に真の地形で解く。

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

## 観測と行動方針（3D-05b / G-03）

Upright offsets: +X forward/+Z right, yaw-rotated (vertical facing uses world +X).
Sight: eye-origin cone, range/FOV/vision LOS independent of attack occlusion.
Every reactionSteps, freeze position/velocity/facing/time; deliver after the same delay,
including startup. Lost targets retain lastSeen for memorySteps. AI gets no hidden current/future state.

Conditions use own resources/statuses, observed distance/visibility/projectiles, all/any/not.
Costs/uses/cooldown/phase/range constrain integer-weighted candidates; combat revalidates
start/release/contact. Probabilities/estimates differ from outcomes (ADR 0009).
Movement: approach/keep-distance/evade/hold. Flight uses policy altitude unless dodging;
lost flight returns to ground. Dodge is left/right, plus up/down in flight. Own geometry/
acceleration, known terrain and constant-velocity observed bullets constrain weighted directions.
Equal directions equiprobable; sole direction draws nothing. Physics resolves actual movement.

Appearance/wounds/phase/impacts are delayed; impact sight uses contact positions and start facing,
with delay from resolution. Exact enemy resources/resistance/unused abilities remain private;
typed reveal exposes one field. Categories: ability physical/magic/technique/special
(omission: magic iff MP>0); status buff/debuff/control/damage-over-time/permanent, without duplicates.
Silence blocks magic start/release; dispel matches ID/category, subject to permanence.

## 効果と状態の同時解決（3D-06a / G-02 / G-03）

Optional magicPower/magicDefense (0..1000000): omitted inherits adjusted attack/defense; explicit 0 is independent.
Power = amount + floor(attack*attackScaleBps/10000) + sum(floor(stat*ratioBps/10000)).
Scaling adds 1..2 unique attack/magicPower terms (ratios 0..100000). Each effect is one component.
Defense physical(default)/magic/none is independent of element/category; none bypasses defense only.
Order: max(0,power-defense) → coverage → resistance → dealt → received → shared shield → HP.
BigInt intermediates; each multiply floors; safe outputs. Coverage/resistance clamp 0..10000;
dealt/received default 10000, clamp 0..30000. Shield includes concurrent grants; exact proportional
fractions attribute shield/HP without ID remainders. HP+healing-unshielded damage clamps once.
damage.ts owns power/calculation; G-03 supplies adjusted stats/factors. Launch freezes source,
including melee/projectiles; resolution reads old target states. New formula/adjustment emits
damage.calculation; amount/impact include factors. AI compares own power and matching defense;
reveal ignores defense. Fixtures: damage-formulas.json and status tests.

Statuses use [start,end): expire before per-stack pulses. Grants activate next boundary;
dispel targets old states. Same revision/key/start shares a cohort; sum caps maxStacks;
distinct starts keep deadlines. Refresh preserves origin/causes;
replace resets; reject keeps old states. Conflicting revisions/key require explicit replacement.
Legacy attack/defense add per stack (floor 0); speed sums deviations from 10000 (clamp 0..30000);
flight/rooted use OR. Expired flight restores gravity. Status type/cause budget excess truncates.

Adjustments: {target,operation:add|multiply,amount,element?,category?}.
Targets: attack/defense/magicPower/magicDefense/speed/damageDealt/damageTaken/resistance,
hpRecovery/staminaRecovery, perceptionRange/perceptionFov/action/movement/vision/visibility.
Add uses target units (stats/mm/millidegrees; stamina recovery units/sec; otherwise Bps).
Sum add*stacks; sum (multiply-10000)*stacks with legacy speed deltas; clamp multiplier 0..30000,
floor one BigInt product. Omitted magic inherits adjusted physical values.
Resistance requires element and clamps 0..10000; damage factors clamp 0..30000.
Element limits damage/resistance; category limits dealt damage (mixed category matches once).
Zero action blocks start/release/movement, but committed attacks persist. Zero movement/vision/
visibility blocks moving/seeing/being seen. Perception clamps to 200000mm/360000 millidegrees.

Reactions: {element,response,damageTakenBps?}, unique elements; response is
none/remove/strengthen{stacks}/transform{status:exact revision}. Explicit water overrides
burning.waterExtinguishable (true→remove, false→none). Coverage>0 water/damage contacts at 0 HP
damage too. React once per old state/element/transaction; weakness applies to that hit, adding
multiplier deviations to damageTaken. Remove beats strengthen; remove+transform or differing
destinations are unresolved. Strengthen fills oldest cohort to maxStacks, keeps clocks/causes.
Transform grants once, no recursion; dispel precedes grants. Diagnostics retain causes.

Permanent states use endStep=12000 (battle max 6000), ignoring duration and normal removal/transform.
Same-revision replace preserves clocks; other replacement is unresolved. Dedicated sealing stays P6.

Periodic {kind:resource,resource:mp|stamina,amount:signed integer,everySteps} calls G-04
updateResources once per boundary; retains carry/exhaustion, leaves absent stamina absent.
Resource pulses precede HP/declarations. recoverActorResources settles interval-start
staminaRecovery at step+1; later removal/grants cannot alter elapsed recovery. No duplicate arithmetic.

Omitted/hidden visibility reveals nothing. Sight/reaction delay delivers at most 64 sorted summaries:
ID/categories, benefit/adjustment direction, removability, reaction/damage direction; no hashes,
quantities, stacks or deadlines. Own AI knows its states/definitions/transform closure; enemy AI
uses delayed summaries/impacts only. Apply/cleanse/reaction estimates follow holder benefit,
including resource pulses/recovery (missing own resources ignored). Weakness changes the coarse
prior, never duplicates measured impact. Public context changes retire old impacts after delivery.
Knowledge/decision logs share these summaries, never enemy truth.

G-03 spatial-v1.12 / standard-status-v1 changes water-damage extinguishing and status AI.
ADR 0010: omissions preserve legacy arithmetic/hashes; old records remain readable without historical
execution. Corpus changes only engine/rules identity; published sample IDs stay fixed.

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

## 固定step対戦と記録（3D-06c）

`simulate(prepared, budget)`は同期generatorで、呼出し側が次の記録を要求するまで進まない。
初期表示、必要な境界差分、各20ms区間の折れ線/差分/イベント、終端を出力する。途中でreturn
してもfinallyでWASM worldを解放する。エンジンにI/O・実時計・Worker番号を渡さない。
`runBattle`はCLI/fixture用の予算付き収集器であり、本番Workerはgeneratorをbackpressure付きで使う。

境界nは期限切れ→継続効果→敗北判定→遅延観測→AI→宣言/支払い→発射。
区間[n,n+1)の移動・接触・効果・自然回復を同時確定する。AIは100msごとで、その間は移動指示を
保持する。飛行権限は次の移動、詠唱の移動禁止は宣言区間から反映。硬直/cooldown終了後の宣言は次のAI境界。

開始条件/資源不足の不発はコスト0で通常の回復時間を待つ。成功宣言は使用回数とコストを消費し、
発射時の条件/射程不成立でも返金しない。同区間でHP0となっても発射済み効果は取り消さない。
区間末の同時致死はdraw、片方だけなら直ちにwin。最後の許容区間も解決し、終了境界の継続効果や
新規宣言は実行しない。落下は環境由来のphysical damageとして同じ防御/耐性/シールドを通す。

battle-startはdirect selfのみ。同じ初期snapshotで条件を満たす群を主体ごとに一括予約し、
合計不足なら全不発、成功なら支払い・効果を同時解決する。開始状態は境界0の継続効果より先に有効。

`character.stamina?`: integer max/recoveryPerSecond, optional resumeAt; starts at max, floor 0.
Recover each interval end; retain fractions, discard at max. Reaching 0 blocks stamina skills until
resumeAt (default ceil(max/10)). Omission adds no resource/events. Omitted costs.stamina=0;
uses=0 remains unlimited. updateResources sums signed deltas/recovery, clamps once, returns actual
delta/carry. Recovery=max(0,rate+add)*Bps/10000. ResourceBudget reserves shared remaining capacity;
commit/cancel once per reservation, settle all before another update.

境界と区間は独立トランザクション。予算超過/未定義干渉は未確定のコスト・乱数・移動・イベントを
破棄し、最後の確定表示と理由を返す。入力不正/実装例外をunresolved/drawへ変換しない。
蓄積上限は`maxEvents/maxBytes/maxFrameBytes`、初期/終端診断は別枠32KiB。
maxPathNodesは1探索、casts/candidatesは試合累計の上限。statsは実作業量。

イベントは安定ID、記録sequence、step/phase/区間内時刻、親/原因集合、前後資源、厳密なダメージ
内訳を持つ。sequenceは記録順であり戦闘の先手ではない。同時効果の各内訳のbefore/afterは
共有snapshotと一括確定値を指す。状態の原因は付与eventから継続効果まで辿れる。
表示記録は初期状態へのreplacement deltaと各折れ線で、戦闘を再実行せず復元できる。

eventHashは各event、trajectoryHashは各記録からeventsを除いた内容について、数値を規定のf64
encodingへ変換→canonical JSON→LFの列をSHA-256した値。圧縮checksumとは別物である。
tsStateHashは資源・状態の原因/期限・行動時計・使用回数・cooldown・観測記憶・乱数を含む。
physicsStateHashは静的Rapier world snapshot。TS側の身体運動はTS state/trajectoryに含める。
これらを「途中から再計算を再開できる完全snapshot」とは扱わない。

## 飛翔体・誘導・爆発（3D-07）

飛翔体は発射時の位置・向き・攻撃値・合法な目標位置を固定する。実体IDは予約名前空間
`projectile.*`に置き、参加者IDとの衝突を入力時に拒否する。半径付き球と対象の同区間の身体軌跡を
相対sweepし、最初の壁/身体で消滅する。通常弾は所有者自身と衝突しない。攻撃のpointは接触面の
点、centerは球中心として分離し、爆発の起点と軌跡にはcenterを使う。開始重なりで接触面が
一意にならない場合は開始点を診断点とする。寿命は発射を含む区間数で、最後の区間を進んだ後に
消滅する。寿命切れだけでは爆発しない。片方が倒れた区間末で試合を終了し、残存弾を待たない。

gravityScaleBpsで重力を倍率指定する。誘導は速度の向きを1秒当たりの上限角まで旋回させる。
launch-onlyは発射時点で得ていた目標位置へ向かう。owner-visibleは所有者へ遅延配信済みの観測だけで
更新し、観測が非可視になったら現在速度と重力で進む。pendingの将来観測や相手の実位置を参照しない。
飛翔体の公開観測はID/所有者/位置/速度/可視半径のみで、内部の目標や能力/乱数を混入させない。

区間幅dt=0.02秒、角速度ωはradian/s、重力g、現在速さvについて、分割数は
`ceil(sqrt((abs(g) + 2*(v + abs(g)*dt)*ω) * dt² / (8*curveError)))`、最低1とする。
目標がない場合のωは0。各小区間は旋回の中点速度による変位と重力の解析変位を加え、末尾の旋回と
重力で速度を更新する。これは版付きの区分線形近似であり、誤差は各小区間の曲率に対する局所基準。
全長にわたる連続誘導の厳密解を保証しない。重力のみの放物線では中点の弦誤差をfixtureで検証する。
分割数はルールから決め、maxCurveSegmentsを増やしても既に完走した試合の軌跡を変えない。
上限不足はtruncatedとして区間を巻き戻す。弾数・候補・castも同様で、同時生成の片方だけを採用しない。

explosionRadiusMm>0なら接触時点で球形範囲に一度だけ作用し、直撃分を重複加算しない。
爆発hitのpointは範囲の起点を表し、直撃hitのpointは接触面を表す。
所有者を含む全身体が対象になる。まず球と直立カプセルの交差を正確に調べる。その後、身体中心、
上端、下端、起点に最も近い身体点、同じ中心軸点から反対側の身体点の5点を等重みで採る。
起点が身体内部なら最寄り点は起点自身、中心軸上なら反対方向を恣意的に選ばず軸点を用いる。
各点へattack遮蔽がなければ`max(0, 1-distance/radius)`を加え、合計×2000を切り捨てたBpsをcoverageとする。
遮蔽体内部を起点とする爆発のcoverageは0。防御後のdamage・heal・shieldをcoverageで縮小し、
状態付与/解除はcoverageが正のとき1回だけ行う。これは明示的な5点近似で、連続的な体積積分ではない。

初期表示に空の飛翔体集合を置き、各区間にspawn/位置・速度更新/接触時刻付きremoveと実際の分割軌跡を
記録する。接触後の存在しない軌道を補間しない。projectile-spawn→接触→hit→effect/removeの原因を残す。

## 地上方針の空中目標とサンプル（spatial-v1.10）

地上方針が観測/記憶した空中の目標へ近づく場合、移動目標をその真下で最初に身体を支える
地形面へ投影する。身体sweepで静的なmovement地形を調べ、内部重なりや許容傾斜外なら投影しない。
既に支持される橋上の目標は高さを保持する。graphの明示的なedge/goalを別の階層へ書き換えず、
相手の未観測の現在位置も使わない。飛行権限は状態だけで決まり、投影が飛行を与えることはない。
この行動判断の変更をspatial-v1.10とする。平地の既存固定hashは変更しない。

10体のデータ構成、柱の迂回、飛行主体の上空射撃をheadless fixtureで確認する。
参加者/revisionの列挙順を逆転してもevent/trajectory/TS stateは一致する。
このfixtureは勝率の評価やP3の保存込み性能の合格証拠ではない。
