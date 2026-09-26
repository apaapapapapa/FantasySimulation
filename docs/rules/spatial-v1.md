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

Revisions carry kind/id/revision/schemaVersion/contentHash/definition; immutable refs pin
id/revision/contentHash. Hash canonical UTF-8 `{kind,schemaVersion,definition}` with SHA-256.
`prepareBattle` validates hashes, typed references, duplicate abilities, policy references,
participant IDs and whole-body arena bounds. Manifest schema 3 pins both actors' placement,
facing/streams, rules/scenario, resolved revisions, seed/PRNG, engine/digest, physics profile
and its hash, WASM/table hashes. [ADR 0010](../adr/0010-battle-version-compatibility.md)
governs saved-data compatibility; no published revision is overwritten.

Canonicalization sorts object keys by ASCII and revisions by kind/id/revision, never input
arrays (slots/effects/priorities). AI treats priorities as a conditional candidate set without
order bonuses. simulationHash identifies the fixed manifest; budgets, worker counts, attempt
IDs and wall time are excluded, allowing retry with a larger budget.

Xorshift32-v1 actor streams follow actors when swapping placement/facing; zero seeds map to
a fixed nonzero value. Aim consumes only when fixed at launch; old
accuracy draws are not layered on normal hits. actor-purpose-rejection-v1 separates action/
dodge; sole candidates draw nothing. Enumeration/render FPS cannot affect streams. Master
to actor derivation is pinned by the runner's actor-stream-v1.

Event/result schemas distinguish win/draw/unresolved/truncated; event/display/TS-state/Rapier
hashes are independent. Host failed/cancelled are attempt states, never battle outcomes.

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

Offsets: yaw-rotated +X forward/+Z right; vertical facing uses world +X.
Sight uses eye cone/range/vision LOS, independently of attack occlusion. Samples every
reactionSteps freeze position/velocity/facing/time and arrive after that delay, including
startup. Lost targets retain lastSeen for memorySteps. Hidden/future state stays private.
Impacts use contact positions/start facing, delayed from resolution; typed reveal exposes one field.

Conditions: own resources/statuses, observed distance/visibility/projectiles, all/any/not.
G-05 wounds/phase/status/relative-position use the latest visible snapshot, never lastSeen.
Unknown propagates; only true admits use. No visible status does not imply no hidden status.
Relative position uses enemy facing: front cosine>=0.5, behind<=-0.5, otherwise side;
above/below needs >100mm. Coincident/vertical horizontal axes are unknown.
conditionObservation logs phase/facing/times. Appearance priors average efficacy and maximize
confidence across silhouette/surface/equipment, independent of order. Omission keeps red/fire,
blue/ice; [] disables cues. Optional earth resistance defaults0; no per-element AI branches.

Feasible candidates use seeded weights (ADR0009). Movement: approach/keep-distance/evade/hold.
Flight uses policy altitude unless dodging; loss restores ground movement. Dodge uses observed
constant-velocity bullets, own geometry/acceleration and known terrain; physics decides success.
Categories: ability physical/magic/technique/special (omitted: magic iff MP>0), status
buff/debuff/control/damage-over-time/permanent; no duplicates. Silence blocks magic start/release;
dispel matches ID/category subject to permanence. Further tactics are linked below.

## 効果と状態の同時解決（3D-06a / G-02 / G-03）

Optional magicPower/magicDefense (0..1000000): omission inherits adjusted physical stats; 0 is independent.
Power = amount + floor(attack*attackScaleBps/10000) + sum(floor(stat*ratioBps/10000));
1..2 unique attack/magicPower scaling terms, ratios 0..100000. Defense physical(default)/magic/none
is independent of element/category. Order: defense → coverage → resistance → dealt → taken →
absorption → shared shield → HP. BigInt, floor per multiplier; coverage/resistance 0..10000,
dealt/taken 0..30000 (default10000). Shield includes concurrent grants, exact proportional shares.
Launch freezes source; resolution reads old target states. damage.calculation records components.

P6-02 (#155): adjustment absorption requires element, operation:add, amount0..10000 Bps.
Sum stacks/rates, cap10000. floor(post-taken*rate/10000) becomes same-wave healing, leaving shield
intact; hpRecovery applies. Element contact/reactions remain even at zero damage, including periodic.
Optional damage.drainBps0..10000: cap post-shield HP loss at starting HP + ordinary/converted healing;
apportion by exact damage fractions. Multiply each share by drainBps and source hpRecovery, floor once.
Freeze all bases before any drain credit (no recursive funding by reciprocal drain). Add credits,
then clamp HP once to [0,max] before defeat. No drain for self, periodic, costs, fall, or redirected
projectiles (drainDisabled snapshot); cancellation/zero HP damage credits zero. Uses shared waves.
Visible conversion teaches only a delayed weak/strong band, no rates/unused traits; own drain uses
estimated HP loss. Optional damage.absorption/drain and causal heal events restore/display without
engine. Omission preserves old hashes/decisions; additive implementation restamp, no old revision edits.
Fixtures: damage-formulas.json, recovery-pairs.json and recovery tests; old expectations stay fixed.

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

Visible states yield <=64 delayed ID/category/benefit/direction/removability summaries,
never hashes, amounts, stacks or deadlines. Self knows held/ability transform closures.
AI compares the shared launch+1 transaction: duration/magnitude, qualifiers, displaced cohorts,
stacks/expiry and risk. Absent resources/unmatched outgoing qualifiers give no benefit;
harmful-only self grants get zero weight. Own risk uses combat expiry/pulses/reactions/shields;
cleanse weighs risk/cost/exposure. Permanent effects use the horizon. Enemy priors use public
summaries; impacts with mismatched status context cannot train baseline resistance. Public
changes retire impacts after delay; reveals persist. Cognition stores reasons/weights/draws.

## 同時選択（#45、spatial-v1.15）

spatial-v1.19の追加は[索敵・姿勢・遮蔽と数値案](tactical-ai.md)を参照。

standard-simultaneous-v1: optional ai.slots=simultaneous-v1 (omission preserves behavior).
Same observation → action → cost/lock-feasible movement. Dodge competes with ordinary
movement at actionWeight versus existing dodgeWeight/cost; direction is sampled separately.
Movement seed uses actor seed xor 0x13198a2e; sole choices consume no draw.
Before payment, shared ResourceBudget protects flight and admits skill+dodge+jump together.
Failure preserves previous legal intent, costs/uses/deadlines; no skill-only fallback.
Cast-stop excludes paired dodge. Actual collision/settlement remains authoritative.
movementSlot saves candidates/exclusions/draw; existing cognition/locomotion saves the rest.
No hidden enemy inputs.

### Optional candidate floor (#45)

ai.minimumCandidateWeightBps (0..10000): discard w iff w*10000 < max(original)*floor.
Equality/survivor weights stay; omission/0 preserves legacy draws. Explicit floors log
weightBeforeCutoff and effective weight/totalWeight. See [proposal](tactical-ai.md).

## 段階攻撃・移動（G-07）

[段階・形状・強制移動・費用・保存の契約](stages-motion.md)は spatial-v1.17 / standard-motion-v1。
G-08反応処理は別工程。

## 行動時計と攻撃形状（3D-06b）

Action speed0 forbids new actions; positive speed scales cast/recovery/cooldown by
ceil(steps×10000/speed), minimum recovery1. Recovery follows physical active time;
cooldown starts at release. uses0=unlimited, positive=declaration limit. Insufficient
HP/MP rejects the whole payment; exact HP-to-zero is legal. No refund after fizzle.

Declaration/release range uses observed/remembered target centre and muzzle; no rear starts.
Aim freezes launch-boundary facing, never live target position. Each release consumes two
actor PRNG draws for uniform local yaw/pitch error, even at zero error. Ordinary bullets
receive no later target positions.

Hitscan sweeps its radius to range and takes first wall/body. Melee advances a radiusMm
sphere from muzzle to min(reach,range) over activeSteps, retaining body paths plus thrust.
Relative sweeps test moving targets; at most one contact/target/interval and maxHitsPerTarget
per instance (default1, no repeated-step hits). Walls end the instance.
Initial attack overlap counts as hit, unlike separating body contacts. Within epsilon,
wall wins body ties. Centre-to-muzzle occlusion prevents spawning beyond walls. Contact
time chooses first hit/display; HP commits at interval end.

## 固定step対戦と記録（3D-06c）

simulate(prepared,budget) is a synchronous pull generator: initial display, optional boundary,
20ms interval paths/deltas/events, terminal. Early return frees WASM in finally. No I/O,
wall clock or Worker ID enters the engine. runBattle collects bounded CLI/fixture output;
Workers consume with backpressure.

Boundary n: expiry→periodic→defeat→delayed observation→AI→declaration/payment→release.
Movement/contact/effects/recovery commit together over [n,n+1). AI every100ms retains intent
between decisions. Flight updates next movement; cast-stop starts at declaration. Recovery/
cooldown completion permits declaration at the next AI boundary.
Failed condition/resources costs0 but waits recovery. Successful declaration consumes cost/uses;
release failure never refunds. Same-interval HP0 does not cancel released effects. Mutual death
draws, one survivor wins immediately. Resolve the final allowed interval, then no boundary
periodic/new declaration. Fall damage uses environmental physical defense/resistance/shield.
Battle-start is direct self: qualify from one initial snapshot, reserve the actor's whole group,
fail all on shortage, otherwise pay/resolve simultaneously before boundary0 periodic effects.

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

AI reserves skill/jump/dodge costs; run requires horizon funds and observed travel/threat urgency.
Visible threats price dodge; skills preserve paid-flight upkeep.
Enemy inputs: delayed visible speed/appearance, never exact stamina. Logs record own gait/reserve,
movement.cost before/after and boundary recovery.
ActorDisplay.locomotion stores mode/jumping/dodging; old records/legacy actors may omit it.
Samples stamina-scout-v1/glider-v1: max100, regen3/s, resume20; walk2m/s at2/m,
run6m/s at6/m, slow0.5m/s free, jump12, dodge8, step10/m. Steady walk nets -1/s, run -33/s;
Stationary: +3/s. Glider takeoff overrides 8/s to5/s.

Boundary/interval transactions independently roll back uncommitted costs, randomness,
movement and events on budget/unresolved failure; return the last display and reason.
Invalid input/implementation exceptions never become draws/unresolved. maxEvents/Bytes/
FrameBytes are cumulative; control envelopes reserve32KiB. maxPathNodes is per search;
casts/candidates are per battle, and stats count actual work.
Events record stable IDs, sequence, step/phase/subtime, parent/causes, resources and exact
damage attribution. Sequence is recording order, not combat priority; simultaneous
before/after uses shared snapshots. Status causes trace grants through pulses.
Replacement display deltas/paths replay without simulation. eventHash hashes events;
trajectoryHash hashes event-free records: f64 encoding→canonical JSON→LF→SHA256,
independent of compression checksum. tsStateHash covers resources, status causes/clocks,
actions/uses/cooldowns, observations and randomness; physicsStateHash is static Rapier.
Body motion belongs to TS state/trajectory; these are not resumable execution snapshots.

## 飛翔体・誘導・爆発（3D-07）

飛翔体は発射時の位置・向き・攻撃値・合法な目標位置を固定する。実体IDは予約名前空間
`projectile.*`に置き、参加者IDとの衝突を入力時に拒否する。半径付き球と対象の同区間の身体軌跡を
相対sweepし、最初の壁/身体で消滅する。通常弾は所有者自身と衝突しない。攻撃のpointは接触面の
点、centerは球中心として分離し、爆発の起点と軌跡にはcenterを使う。開始重なりで接触面が
一意にならない場合は開始点を診断点とする。寿命は発射を含む区間数で、最後の区間を進んだ後に
消滅する。寿命切れだけでは爆発しない。片方が倒れた区間末で試合を終了し、残存弾を待たない。

gravityScaleBpsで重力を倍率指定する。誘導は速度の向きを1秒当たりの上限角まで旋回させる。
launch-only aims at launch-known positions; owner-visible uses only delivered owner
observations. Once invisible, continue current velocity/gravity, never pending/live targets.
Public samples carry ID/owner/position/velocity/radius, plus visible element/attack cue under
new tactical rules; no private targets, ability definitions or random state.

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

## 反応型発動

spatial-v1.18 / standard-reactions-v1 adds [transactional reactions](reactions.md).
Published rules/revisions remain readable; old execution is rejected under ADR 0010.
