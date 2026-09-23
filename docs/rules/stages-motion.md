# 段階攻撃・移動（G-07、spatial-v1.17）

standard-motion-v1 supersedes standard-stages-v1 for execution. Omitted stages preserve costs/aim/events/hits/PRNG.
Required attack/effects=stage0, executed once. Action only; 1–16 unique IDs,
first offset0, ordered nonoverlapping windows, offset≤6000, duration1–100,
last end≤6000. Melee duration=activeSteps; hold=null attack/empty effects.
Other releases emit once; projectiles may outlive stages.

L is the speed-scaled release; stage windows are [L+offset,L+offset+duration),
with physical offsets/duration. Recovery follows the last planned end; cooldown starts
at L. Failure/interruption never shortens either. At each start recheck capabilities,
condition/startCondition/interruptWhen and observed range; failure cancels all remaining
stages without retry. Conditions use bounded own/delayed observation ASTs.

Top cost/uses + stage0 extra pay at declaration; later extras use ResourceBudget at
start, without future holds/uses. Before paying, admit due cost plus flight upkeep and
selected dodge/jump together. Shortage cancels stage/new burst, preserves flight and
existing gait, and retains committed cost.
Boundary death/incapacity/silence cancels explicit sequences. Declared damage interruption
uses positive attributed HP damage, including simultaneous healing. Interval effects commit
at n+1 without rewinding gathered contacts. Attached shapes end/cancel; detached shots keep
snapshots. Legacy launched melee persists. No pulse runs beyond the final interval.

The shared ledger keys action/stage/group/target. Default max1; explicit hit policy sets
maxHits≤16, minIntervalSteps≥1 and optional full intervening separation. Zero damage consumes
a contact; miss does not. Clone/hash/rollback ledger, stage, cost and PRNG together.
return-cut-v1 / staged-duelist-v1: 10+15 damage, 6+4 stamina.

## 形状・外力

Contact carries action/stage/emitter/group/target, trace fraction/point/coverage/cause.
Arc shape adds reachMm/bladeRadiusMm/startAngleMilliDegrees/sweepMilliDegrees:
a capsule from muzzle to tip rotates uniformly in launch-frozen local horizontal
plane during durationSteps; radial is a full360-degree sweep. Fixed-table geometry
sweeps the whole blade along actual bent body traces, not only its tip. Keep
muzzle occlusion, first blocking wall and existing wall/body epsilon tie. Radial
contacts check individual occlusion; endpoint cones cannot replace sweeps.
Future emitters/beams/areas use this scheduler/ledger and declare offsets/lifetime/
pulses/coverage/walls. Reject until #61 §2-I is complete.

Motion ownership: collision/gravity → forced → stage → dodge → locomotion.
Effect (strict, integers): `{kind:force,profile:linear-v1,direction:away|toward,
speedMmPerSecond:1..100000,durationSteps:1..100}`. Freeze source actor→target center unit
vector at contact (negate for toward); coincident=zero/logged. Multiply by speed,
round each mm/s component, ties away from0. Active[n+1,n+1+duration); BigInt sum
active vectors; F is the sum clamped to optional `rules.forcedSpeedCapMmPerSecond`
(integer1..100000; omitted100000) by Euclidean norm. Log contributors/cap. Separate engine/rules identity;
never character-speed cap/retargeting. No force=unchanged legacy path.

Nonzero F: force mode; suppress voluntary movement/jump/step. On entry:
G=(0,previousVelocity.y,0). Each step: flying→G=0, else add gravity to G.y.
Convert capped F to m/s and add G. Shared trace supplies each collision's effective
normal n (horizontal normal for steep-wall branch). If the combined velocity is
inward, apply P=I-nnᵀ to BOTH G,F, not separate sign tests. Apply in trace order,
including endpoint hits; body-contact/no-progress collision stop uses P=0.
Unblocked cancellation G+F=0 uses identity. Carry only projected G; rebuild F from
active definitions next step. At zero F/last expiry hand G to normal movement, never
actualVelocity. Landing damage uses combined incident y before ground projection.
Hash G; record projections/incident speed. Ceiling: G.y=4,F.y=12m/s → both0
at impact; expiry starts falling from0 under gravity, without retained force.
Root/action lock blocks voluntary motion, not gravity/force.
Dash/retreat supplies velocity/acceleration to shared movement, leap uses real
support/jump/ceiling checks. Authored motion replaces gait: stage cost replaces gait
travel cost; G-04 flight/jump/step charges remain. No duplicate distance charging.
Force adds no target cost. Dodge pays burst+actual travel; cancel a
suppressed unstarted hold, never refund a committed burst. Walls clip travel,
not stage time/fixed skill cost.

Unsupported posture/teleport/emitters remain rejected; undefined accepted interference is unresolved.

## 同時選択・資源

Both slots use one observation. Current authored motion excludes dodge; free-moving attacks
allow it. Reject new infeasible pairs atomically while retaining legal existing work.
One ResourceBudget settles before effects: ordinary order is skill→flight→dodge→jump→step→travel.
Pair admission protects maintainable flight, reserves skill/stage+burst together, then
cancels every hold on failure; ordinary run→walk→slow fallback remains.
HP-to-zero cost is legal/nonreflectable; verdict follows interval effects. G-04 owns
clamp/carry/exhaustion/actual distance/start-snapshot recovery.

## 入力・実装境界・検証

Explicit selfMotion={kind:dash|retreat|leap,speedMmPerSecond:1..100000,
accelerationMmPerSecond2:1..1000000}. Freeze horizontal facing at stage start
(retreat negates; vertical facing uses +X). Leap requests the character's supported
jump only on the first interval and pays its G-04 burst. Unsupported/no-budget leap
interrupts, retaining prepaid cost. Future cast motion permits a present dodge;
existing current stage rejects an unstarted dodge. Force suppresses either.

Arc start angle is integer±180000 millidegrees; signed sweep is nonzero±360000.
Radial uses +360000. Both require explicit stages, reach1..20000mm≤range and
bladeRadius1..5000mm. Positive rotation turns +X toward +Z. Conservative advancement
uses exact shaft/box, ramp, pillar and body separation and a bounded angular speed.
It shares maxCasts; 256 advances without resolution truncate, never assume a miss.
Saved root/tip poses retain body trace bends and curveErrorMm within maxCurveSegments.
Existing wall/body tolerance is retained. Muzzle and per-contact occlusion apply.

maxForces is optional (default64, range1..256 per actor). Excess contributions
truncate the whole interval with observed/limit/cause. The default limits for existing
work are unchanged. Display stores active contributors, applied cap, G before/after,
incident speed, projected force and ordered collision projections; expiry clears it.
Stage display saves requested motion, actual ownership, clocks and emitted geometry.
Replay validates references/windows and seeks without importing the engine.
Enemy cues whitelist only delayed visible current shape/state/motion; own AI estimates
shape coverage, travel exposure, force duration and leap costs without private lookups.

New samples: dash-cut-v1, wide-sweep-v1, stage-vanguard-v1. All published revisions
including standard-stages-v1 retain ID/hash; old data stays readable, old execution
is rejected. Corpus input identity changes only current engine/rules, with independent
paired-load review; Golden outputs remain fixed. Mapped tests cover caps, cancellation,
projection/landing, exact endpoints, shaft crossings, walls, ownership/costs, rollback,
privacy and real Worker/SQLite forward/backward seek. G-08 reactions remain pending.
