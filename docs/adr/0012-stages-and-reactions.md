# ADR 0012: 技の段・攻撃形状・移動・反応型発動

状態: **設計承認済み**（[承認](https://github.com/apaapapapapa/FantasySimulation/pull/86#issuecomment-5792777109)）。
Refs #61 G-06/§2-E,F, #45, #59, #1 P6. Docs only.

## 1. 採用案・前提

G-01–05 are merged; #45 simultaneous slots precede G-07. Recheck live main/PRs.
Later #45/#59/#61 override parent text; G-05 confirmed §7.

One20ms clock, stage/shared ledger and bounded transactional waves; simulate.ts orchestrates
G-01 categories/G-02 damage/G-03 status/G-04 resources/geometry and G-05 views.
No duplicate loops, recursive callbacks, contact-order HP, character scripts or future prepayment.
Interruption is boundary-based; finer timing needs versioning.

## 2. 段・時計・中断

G-07a implements the stage clocks, costs and interruption contract in
[spatial rules](../rules/spatial-v1.md#段階攻撃g-07aspatial-v116).
G-07b adds the shape/motion adapters below; G-08 owns reaction waves.

## 3. 形状・命中・移動

Contact carries action/stage/emitter/group/target, trace fraction/point/coverage/cause.
Arc shape adds reachMm/bladeRadiusMm/startAngleMilliDegrees/sweepMilliDegrees:
a capsule from muzzle to tip rotates uniformly in launch-frozen local horizontal
plane during durationSteps; radial is a full360-degree sweep. Fixed-table geometry
sweeps the whole blade along actual bent body traces, not only its tip. Keep
muzzle occlusion, first blocking wall and existing wall/body epsilon tie. Radial
contacts check individual occlusion; endpoint cones cannot replace sweeps.
Future emitters/beams/areas use this scheduler/ledger and declare offsets/lifetime/
pulses/coverage/walls. Reject until #61 §2-I is complete.

Ledger key=(actionInstance,stageId,hitGroup,targetId). Default stage emitters share
max1; explicit independent groups allow multiple bolts. Legacy melee retains
maxHitsPerTarget and≤1 hit/target/interval. Explicit re-hit needs maxHits and
minIntervalSteps≥1; requireSeparation adds a full intervening non-overlap interval.
New stage=new key. Zero-damage/parried contact consumes hit; miss does not. Roll
back ledger with transaction; collider order/replay/retry cannot create extra hits.

Motion ownership: collision/gravity → forced → stage → dodge → locomotion.
G-07b effect (strict, integers): `{kind:force,profile:linear-v1,direction:away|toward,
speedMmPerSecond:1..100000,durationSteps:1..100}`. Freeze source actor→target center unit
vector at contact (negate for toward); coincident=zero/logged. Multiply by speed,
round each mm/s component, ties away from0. Active[n+1,n+1+duration); BigInt sum
active vectors; F is the sum clamped to optional `rules.forcedSpeedCapMmPerSecond`
(integer1..100000; omitted100000) by Euclidean norm. Log contributors/cap. §10 versioning;
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

#45 owns posture geometry/timing; completed boundary transition precedes stage
checks/launch using actual capsule/eye/muzzle/headroom. Unsupported pairs are infeasible.
Teleport remains future P6 vocabulary: validated destination/discontinuous trace,
no swept-path damage. Reject until collision/force semantics exist; accepted
undefined interference is unresolved, never invented priority.

## 4. 同時選択・資源

#45 returns both slots from one observation; G-05 evaluates feasible pairs.
Explicit stages declare movement/postures, default follows existing
movementWhileCasting. Free-moving attacks allow dodge; authored motion+dodge cannot
own the same interval. Disallow that pair, not every skill+dodge. Execution failure
rejects the new pair atomically, retaining legal existing work; no silent slot drop.

Reuse one G-04 ResourceBudget for declaration/movement. Without a new simultaneous
pair retain skill→flight→dodge→jump→step→travel. Pair admission first protects
required flight upkeep, then atomically reserves skill/stage+dodge/jump from the
remainder; never fund dodge by cancelling maintainable flight. If the pair fails,
cancel its holds (no skill-only fallback/payment); maintain flight and use existing
run→walk→slow for ordinary motion. This new pair admission is versioned with #45;
it does not redesign G-04's API or alter legacy single-slot order.

Ability costs/uses commit on declaration; extra costs at stage start (stage0 prepaid,
never twice), no extra uses. Future costs hold nothing; shortage interrupts. Started
cost/cooldown survives fizzle, unreached stages cost0. HP-to-zero stays legal and
nonreflectable; defeat at interval end. Settle/cancel once, finish before updates;
G-04 owns clamp/carry/exhaustion/actual distance/start-snapshot recovery.

At a reaction point use a settled ResourceBudget on current provisional resources,
not an old balance. All eligible owner reactions at that point reserve together or
all fail for cost. Commit once, cooldown from reaction boundary, one use/activation.
Shortage/exhausted semantic uses is no-proc, not truncated. Deferred counter carries
paid activation ID, never an open hold or second charge. No cross-update holds.

## 5. 処理順・反応点

Boundary n and interval[n,n+1) are separate atomic transactions. At n, existing
startup(n=0) precedes expiry/periodic; expiry precedes pulses, G-03 resource pulses
precede HP effects. Periodic HP uses the wave pipeline, then verdict; only survivors
perceive/decide. No extra boundary pulses after final interval.

- **Plan**: Delayed observations, same-snapshot slots; reserve/pay/start, freeze source/aim, release
- **Geometry**: Shared body/projectile/shape traces; collect contacts/falls/direct effects, settle movement
- **before-hit**: Group contacts by owner/ability/point/wave: one activation/cost over all matches; parry/filter/shield, no rewind
- **Primary wave**: G-03 old-cohort reaction plan; G-02 defense/coverage/resistance/modifiers; absorption hook; concurrent shield/exact attribution; sum heal, one HP clamp/target
- **after-damage**: Finalized wave attribution (before HP clipping), not net HP loss; queue reflection and deferred counter
- **Reflection**: Same reducers/defense/shield/clamp, even from reflector at HP0; flag forbids re-reflection
- **before-defeat**: After all damage waves: gather provisional HP0 owners, bounded simultaneous revival waves
- **Commit/verdict**: Statuses, next-interval interruption/forces, G-04 natural recovery, ledger/PRNG/knowledge/log/display; then win/draw

Waves are provisional. Reaction: point, category/element filter, condition,
costs/clocks/uses,response. Combat-only data; pretransaction capabilities only.

G-03 evaluates each old revision/element once per whole transaction including later
waves; damage keeps old status modifiers. Union accepted contacts/grants/removals,
commit statuses once. Preserve remove>strengthen, conflicting transform→unresolved,
nonrecursive transform and permanent protection. Whole-contact parry cancels element/
status payload; damage-only cancellation retains contact. Instant shield is a wave
response, not early status activation. Numeric defensive modifiers combine via
shared Bps aggregation; conflicting replacements require a rule, not ID precedence.

Before-hit is a reducer, not another immediate attack or self-trigger recursion.
Cooldown/uses eligibility is evaluated before that group; duplicate contacts cannot
activate it again. after-damage counter requires positive hostile damage; launch no earlier than the
commit boundary (boundary transaction n→interval n; interval n→interval n+1),
rechecking owner/range/geometry. Death cancels, cost remains.
Reaction action slot coexists with main action but shares motion/ledger/budget;
incompatible authored-motion counter fails activation.

P6 hooks are designed, not implemented in G-06/G-08:

- Absorption diverts post-modifier/pre-shield damage to same-wave healing. That
  portion cannot also drain shield/reflect; competing absorbers need a fraction rule.
- Reflection basis: hostile post-defense/resistance/**shield**, before remaining-HP
  clipping or simultaneous-heal cancellation (#1). Exclude costs, environmental/
  nonhostile damage and reflections. Rational component attribution, floor once per
  owner/source/component after reflection Bps; no new attack scaling/dealt bonus.
  Recipient defense/resistance/shield still apply; preserve causes even at HP0.
  Reflections may be defended, never reflected again.
- Same-wave healing precedes before-defeat. Revival is explicit restoration, not
  ordinary heal/counter recursion. Gather all HP0 owners, reserve all-or-none per
  owner; finite uses/explicit rules govern competing revivals. Undefined revive/
  annihilation or competing replacement is unresolved.

## 6. 同時順序・上限・原子性

Integer20ms steps; contact fraction binary64, rounded subtimeMicros only for logs.
Preserve [spatial rules](../rules/spatial-v1.md) mm/Bps/BigInt/rational attribution/
f32 conversion/finite/-0/hashes. Two aim draws per spatial release, direct none;
new emitter index order explicit, rejected stages draw none. #45 purpose separation
and legacy omission streams remain. Serialize phase→wave depth→stable actor/action/
stage/emitter/contact key→effect index; mechanics use frozen/commutative groups,
never serialization precedence. Causes precede children; display sequence is separate.

Proposed schema caps:16 stages, offsets≤6000,duration1..100,16 effects/stage,
16 emitters/stage,16 hits/group/target,plan end≤6000; keep existing geometry/manifest
limits. Invalid definition fails validation. Proposed execution Budget ceilings:
64 reactions/transaction,1024/match,depth8(primary0),4 revival activations/actor/match.
Pending counters count across intervals, empty waves add no depth. These differ
from semantic uses/cooldown: an eligible next activation exceeding budget truncates;
exhausted ability uses simply disable it. No silent omission.

Accepted undefined interference→unresolved(rule ID,revisions,causes,point).
Work/queue/record ceiling→truncated(resource,observed/limit,cause). Neither is draw;
unexpected exceptions fail the attempt. Keep bounded terminal diagnostics.
Clone resources/holds/uses/carry/statuses/shield/stages/counters/forces/ledger/bodies/
projectiles/perception/PRNG/IDs/journal. Validate all waves and full record bytes
before publishing. Failure discards the entire boundary or interval, including
provisional costs/spawns/earlier waves. Committed boundary n survives failed interval n.
Work counters retain attempted work; no budget refill or partial wave yield/checkpoint.

## 7. G-05・観測・ログ・保存

G-05 consumes own timing/power/status value, shape/coverage/motion, slot/posture compatibility,
costs/exposure/reaction limits. Bounded estimates, never guaranteed hits.
Use DecisionView→assessAbility/assessStatusEffects→CandidateAssessment;
observedCondition uses only latest delayed visible snapshot, including unknown propagation.
G-05 confirmed this boundary; no wait for its completion.

Enemy stage/phase/motion/status/impact cues obey sight/delay. Future stages, unused
reactions, exact resources/costs/revision/hash are private; no lookup. Unknown≠0;
mechanical triggers/omniscient replay are forbidden AI inputs. Subjective cognition:
both slots/exclusions, own allocation, estimates/confidence, sampled/available cues,
weight/total/PRNG purpose. Separate results: stage lifecycle, contact/group/dedupe,
cost/component/shield/reflection basis, wave/cause, force/revival/diagnostics.

StreamRecord/ActorDisplay/checkpoints store actual stage/phase clocks/IDs, emitted
geometry/paths, motion/discontinuity/reaction visuals, replacement deltas. Viewer
never infers or runs engine/Rapier. Hash stage/ledger/deferred counter/force/activation
state. Checkpoints cannot resume. Test domain ReplayState forward/backward across
stage/wave/terminal and Worker/SQLite round trips.

## 8. データ例と机上受入（実装試験ではない）

Proposed notation, not JSON/macros. Keep required attack/effects=stage0;
extra cost defaults0, top-level cost paid once.

```text
costs={hp:0,mp:0,stamina:6,uses:0}; castSteps=2
shape={kind:melee,activeSteps:2,reachMm:1500,radiusMm:150,maxHitsPerTarget:1}
D(n)={kind:damage,element:physical,amount:n,attackScaleBps:0}
stages=[
 {id:cut,offsetSteps:0,durationSteps:2,attack:shape,effects:[D(10)]},
 {id:return,offsetSteps:3,durationSteps:2,attack:shape,effects:[D(15)],cost:{stamina:4}}
]
```

Zero defenses unless specified.

- 連撃: declaration10/speed10000 → L12, windows[12,14),[15,17), hits10+15,
  no duplicate at13. Extra4 paid15; shortage cancels second, retains6.
- 突進斬り: +X dash/melee clips/bends at wall, no through-wall hit; fixed cost remains.
  Next-interval forces +80000/+80000 clamp to100000; +80000/-80000 cancel.
- 薙ぎ払い: adjacent overlaps/multiple emitters give one shared-group hit;
  only explicit re-hit rules or a new stage permit another.
- 回避＋射撃: stamina20,skill6+dodge8 reserves14. With13 neither pays.
  Flight2,stamina10,skill6+dodge4: protect2, reject pair against8; no flight loss.
- 受け流し／反撃: full parry consumes hit/cancels payload; positive-damage counter
  queues n+1, actual geometry decides its hit.
- 同時致死: bothHP10/take15, A heals6 → A1/B0 after reactions/A wins;
  without heal/revival → draw.
- 反射／蘇生(P6): B HP10/shield5 takes30/heals8 → basis25,B0;
  50% reflection12 kills A HP12, no re-reflect. B revival7→B wins; neither→draw.
- 上限: eligible65th with cap64 rolls back all64/cost/PRNG/hits. Undefined
  parry-vs-pierce→unresolved; neither omits a reaction to award a winner.

## 9. 実装PR・所有・検証

G-07 needs approved ADR **and merged #45 simultaneous slots**; reuse #45 posture/policy.
G-08 merges after G-07; only pure reducers/fixtures parallel. One editor for shared
loop/domain schema/log adapters. G-04 is published; G-05 reviews only §7.

- **G-07a**: New stages.ts/hit-ledger.ts, attacks.ts/combat-state.ts/simulate.ts, domain contracts/records/replay: one-stage legacy equivalence, pair reservation, clocks/interruption/rollback
- **G-07b (after a)**: Shape/movement adapters using shared movement.ts/physics.ts; pending forces: combo/dash/arc, walls/ceiling/posture, shared hits/actual costs and saved geometry
- **G-08a (after G-07)**: New reactions.ts, same coordinator, combat-effects.ts/effects.ts planning adapter, domain triggers/records: reuse G-03/G-04, empty reactions preserve old results
- **G-08b (after a)**: Declarative parry or counter, bounded waves/queue: lethality/heal/ledger/cost/cross-interval limits/atomic diagnostics/replay. No reflection/absorption/revival capability or P4/P5

Each PR: #61 §2-I, independent fixtures/docs/new sample IDs. Coordinate G-05
evaluation/perception; one editor/shared file. P6 owns reflection/revival fixtures.

Tests: boundary0/final/end-contact, melee duration mismatch, interruption, exact
HP cost/stage shortage, force bounds/zero direction/expiry/gravity/ceiling, expiry/transform,
repeated contact, enumeration swaps,
seed/hash/Worker equivalence, unseen-enemy mutation invariance, cast/queue/byte
rollback, bidirectional replay seek, old DB/result/replay reading. ADR needs full Linux CI:
quality/context/links, verify, clean-source, latest-head review/CI; main CI after merge.

## 10. 版更新・承認証跡

[ADR0010](0010-battle-version-compatibility.md): additive fields/enums, unchanged
omission/meanings/ranges/required fields/fixtures. New mechanics/selection/waves need
new engine/rules version and ID; review digest/corpus/independent expectations/docs.
Choose version after #45/G-05 rebase; preserve published ID/hash, add new sample IDs.
Keep old data strict-readable, reject old execution/retry/recovery; no historical
engine/DB conversion. Optional display additions only when unambiguous; incompatible
record/profile needs explicit version rejection while preserving old readers.

PR records reviewer/head/decision/findings. Self-review is not approval. Require
maintainer/user approval and main CI; update only #61 G-06 design approval.
Implementation/Issue remain open; no subsequent work is authorized.
