# spatial-v1.13: 公開入力と実行manifest

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

Squared distances/dots within coordinate limits and bounded angle/Bps products stay within
2^53-1. Equipment limit=8; status budget defaults to64 types (maximum256), each32 stacks.
Effect aggregation and proportional resistance/shield attribution use BigInt rationals when
needed, never imprecise number intermediates. Budget exhaustion truncates, never omits abilities.
Internal units are m/s. Rapier static queries use binary32, TS state/body relative sweeps binary64.
Hashes encode big-endian f64 hex, normalize -0, reject NaN/Infinity; display rounding never feeds
physics. The manifest pins the fixed sine table and WASM bytes.

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

Sweep precision and contact normals follow the movement contract below. Skin is not a
penetration test. Free every world on success and failure.

## 同時移動（3D-04）

`moveActors` computes both actors' acceleration, gravity, facing and terrain traces from the
same 20ms boundary. Relative sweeps stop both at first body contact, including endpoint contact;
separating motion remains legal. Inputs are immutable. Ground speed follows the walkable surface;
flight speed is 3D. Project requests onto the supporting tangent before acceleration, retain ramp
vertical velocity, never climb excessive slopes. Gravity uses semi-implicit Euler (velocity then
position), even when movement is disabled. Jump requires ground support and respects ceilings.

Steps require a walkable top within stepHeight and whole-body lift/traverse clearance. Lift takes
20% of the interval; traverse uses the rest, reserving the last 20% for drop when support is within
10mm. Ledge traversal can span intervals; step lift never becomes carried upward jump velocity.
Keep every bent segment for contacts; segment overflow throws SpatialBudgetError.
Landing damage = floor(max(0, downwardMmPerSecond - safeSpeed) * rate / 1000).
Flight suspends gravity; expiry/insufficient upkeep restores gravity on retained vertical velocity.
Scenario ceilings cap altitude. Grounded requires support contact within 1μm of the skin.

Rapier performs broad/curved sweeps. Binary64 capsule/OBB/cylinder distance supplements f32 GJK
missed contacts on large symmetric floors. Restore face-interior normals to suppress tangential
jitter, preserving edge/corner normals; do not extend rear faces. Skip separating/tangent convex
contacts and continue searching. Skin is not a substitute for penetration validation.

## 地上・空中経路（3D-05a）

Only surveyed terrain permits the full support graph; observed terrain uses delayed local
surfaces and short exploration. Actual collision always uses the real world.
Nodes are body centres, bounded and unique within ground/air mode; bridge levels stay distinct.
Direct routes use body sweeps, walking support samples at <=250mm, and nearby step clearance.
Jump arcs use semi-implicit Euler, selected gait speed and <=20ms body sweeps. Acceleration,
contact and landing remain authoritative in movement. Edges need diameter+4mm width and
height+4mm headroom. Flight cannot bypass walls or ceilings.
A* uses distance plus estimated stamina/max(1, remaining), with straight-distance heuristic;
legacy definitions use distance only. Jump reach cache includes gait speed; cached geometry
never includes current stamina. Insufficient jump resources return resource-limited, retried on
later decisions; geometric failure is unreachable, search exhaustion is budget-exceeded.
Cost estimates include travelled distance, jump, upward steps and flight duration. They guide
route choice; only the shared execution budget authorizes consumption. Relative geometry breaks
ties, never input order/ID. Policy aerial goals project onto the first valid support below;
explicit graph goals retain their levels.

## 観測と行動方針（G-05）

Upright offsets: +X forward/+Z right, yaw-rotated (vertical facing uses world +X).
Sight: eye-origin cone, range/FOV/vision LOS independent of attack occlusion.
Every reactionSteps, freeze position/velocity/facing/time; deliver after the same delay,
including startup. Lost targets retain lastSeen for memorySteps. AI gets no hidden current/future state.

Conditions use own resources/statuses, observed distance/visibility/projectiles, all/any/not.
G-05 adds observed-wounds/phase/status and relative-position using only the latest delivered
visible snapshot (not lastSeen). Unknown propagates through not/all/any; only true admits use.
Status absence means no visible matching status, never absence of hidden states. Relative self
position uses observed enemy facing: front cosine ≥0.5, behind ≤−0.5, side otherwise;
above/below require >100mm vertical separation. Coincident/vertical horizontal axes are unknown.
Decision conditionObservation records observed phase/facing with the existing timestamps.
Rules ai.appearancePriors stores matching silhouette/surface/equipment cues, element efficacy
and confidence. Matches average elemental estimates, use maximum confidence, independent of order.
Omission retains the published red/fire and blue/ice priors; [] disables cues. Earth resistance
is optional (zero when absent); enums expand appearance without per-element AI branches.
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
Resistance: element required, 0..10000; damage factors: 0..30000.
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
Replacing permanent states: same revision preserves clocks; others are unresolved. Sealing stays P6.

Periodic {kind:resource,resource:mp|stamina,amount:signed integer,everySteps} calls G-04
updateResources once per boundary; retains carry/exhaustion, leaves absent stamina absent.
Resource pulses precede HP/declarations. recoverActorResources settles interval-start
staminaRecovery at step+1; later removal/grants cannot alter elapsed recovery. No duplicate arithmetic.

Only visible states yield ≤64 sorted summaries after sight/reaction delay:
ID/categories, benefit/adjustment direction, removability, reaction/damage direction; no hashes,
quantities, stacks or deadlines. Own AI knows ability/held-state transform closures; enemy AI
uses delayed summaries/impacts only. Self utility compares one shared transaction at launch+1,
preserving pulse phase, displaced cohorts, caps and expiry (missing resources ignored). Weakness changes the coarse
prior, never duplicates measured impact. Public changes retire prior/same-boundary impacts after
delay; baseline reveals persist and use the public prior.
Knowledge/decision logs use these summaries, never enemy truth.

G-03 spatial-v1.12 / standard-status-v1 changes water extinguishing and status AI.
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

G-04: spatial-v1.13 / standard-locomotion-v1 changes stamina-only exhaustion movement.
Retain v1.11/v1.12 definitions/replays; reject old execution.
`character.stamina?={max,recoveryPerSecond,resumeAt?}` starts full, clamps 0..max and
recovers each interval, including casting/moving/final.
Zero latches exhaustion until resumeAt (default ceil(max/10)); stamina skills, run, dodge and
jump then stop. Optional `movement.locomotion` requires stamina and defines walk/run
`{speedMmPerSecond,staminaPerMeter}`, `exhaustedSpeedMmPerSecond`, positive `jumpStamina`,
`dodgeStamina`, `stepStaminaPerMeter`. Run is faster/costlier; exhausted walk is slower and free.
Missing locomotion keeps the single free speed; a stamina-only exhausted actor uses 1/4 speed.
Omitting both preserves legacy motion/AI/Goldens.

Ground/air travel charges horizontal gait metres; walls cost0. Round to micrometres;
BigInt carries fractional stamina. Jump charges once at takeoff (including blocked ceilings);
Steps charge vertical lift; dodge charges each selected burst plus travel.
Jump reach uses gait speed and physical acceleration.
Insufficient reservations fall back run→walk→free slow walk; gravity/contact continue.
One actor ResourceBudget covers skill→flight→dodge→jump→step→travel. Reserve atomically;
commit/cancel once. Actual travel≤physical bound; settle all holds before updates. Started
skills keep costs after fizzle; failed reservations cost0; uses0=unlimited; HP may pay all.

`status.flightStaminaPerSecond?` or apply-status override defines upkeep/s, including hover/root/cast.
Omitted=0; grant/refresh minimum wins once. Paid flight needs next interval
ceiling cost and resume threshold; shortage restores gravity/ground routes; retry after recovery.
Free flight persists; displays retain override, decision state fractions.
`updateResources` sums signed deltas and max(0,rate+add)×Bps/10000 recovery before one clamp;
recovery fractions persist, discarded at max. G-03 supplies interval-start modifiers.

AI reserves skill/jump/dodge costs and runs if horizon travel fits.
Visible threats price dodge; skills preserve paid-flight upkeep.
Enemy inputs: delayed visible speed/appearance, never exact stamina. Logs record own gait/reserve,
movement.cost before/after and boundary recovery.
ActorDisplay.locomotion stores mode/jumping/dodging; old records/legacy actors may omit it.
Samples stamina-scout-v1/glider-v1: max100, regen3/s, resume20; walk2m/s at2/m,
run6m/s at6/m, slow0.5m/s free, jump12, dodge8, step10/m. Steady walk nets -1/s, run -33/s;
Stationary: +3/s. Glider takeoff overrides 8/s to5/s.

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

## サンプル

Catalog fixtures cover grounded pursuit, pillar detours and aerial attacks through common rules.
Reversing participant/revision enumeration preserves event/trajectory/TS hashes. These are
behavioral fixtures, not win-rate estimates or persistence-inclusive performance evidence.
