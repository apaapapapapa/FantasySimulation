# Spatial rules: public input and execution

Strict domain schemas own executable input. This is a compact contract/index;
[the complete pre-P6 spatial specification](https://github.com/apaapapapapa/FantasySimulation/blob/63b49c60bba9af4007061b7eb1228c7b4fad8ac4/docs/rules/spatial-v1.md)
retains the authoritative formulas, rounding, numeric examples and boundary cases summarized
here. This compaction changes no rule. Later accepted ADRs prevail;
[ADR0017](../adr/0017-p6-spatial-mechanics.md) owns spatial operations; `relocation` implements
P6-06 teleport. It freezes a visible relative anchor, activates next boundary after full-body
clearance, rejects conflicting endpoints together and records a jump without interpolation.
P6-07 adds boundary-owned barriers/areas and staged beams; phasing awaits P6-08.

## 単位と上限

Right-handed X/Z horizontal,Y up; integer mm/mm/s/mm/s²,millidegrees, nonzero direction
ratios,Bps10000=1. Independent clocks; action0 disables new actions.
Coordinates±1000000, arena extent<=200000, stats/resources<=1000000,maxHP>0;
capsule radius1..5000,height1..20000>=2radius. Movement/acceleration<=100000,
projectiles<=1000000; step20ms,max6000. AST depth4/children8; revisions256,terrain256,
nav4096nodes/16384edges; JSON100000nodes/depth24/4MB. Equipment8,statuses64(default)/256max,
32stacks. Overflow truncates. Body centre and offsets, halfHeight=height/2-radius;
standard300/1800 body spawns902mm above floor0 with2mm skin. Whole-body validation required.
BigInt rational aggregation; internal metres, f32 Rapier/f64 TS; hash big-endian f64,
normalize -0, reject nonfinite. Display rounding never feeds physics; WASM/table pinned.

## 型付き構成

Bounded acyclic exact revision closure character->abilities/equipment/policy,
equipment->abilities,apply-status/transform->statuses. Unknown variants fail. Action/startup
(self/cast0); direct self only, hostile effects require contact. Terrain box(yaw/slope)/pillar
has independent movement/vision/attack masks; height-aware navigation validates body clearance.
P6 future payloads stay rejected.

## revisionとhash

Immutable revision/manifest hashes pin exact closure,placement/RNG/rules/engine/physics assets.
[ADR0010](../adr/0010-battle-version-compatibility.md)/[ADR0013](../adr/0013-execution-identity.md)
and the full specification own canonicalization/identity. No overwrite/conversion/old engine.
Sort keys/revision sets,not meaningful arrays; simulationHash excludes attempt budgets/time.
Xorshift32-v1 and actor-purpose-rejection-v1 streams follow actors,sole choices draw none;
launch aim only,rendering/order never perturb RNG. Battle outcomes differ from host attempt
failures; event/trajectory/TS/physics hashes remain independent.

## 静的戦場と初期配置（3D-03）

Pinned rotations and six solid arena faces, reserved boundary.* IDs; no boundary defeat.
Keep bridge/floor/ceiling volumes. Full body/bounds/terrain/opponent validation uses f64
segment/OBB/cylinder distances against Rapier thin-gap false penetration. No jitter; skin
is not penetration. Eye LOS differs from muzzle LOS. Free worlds on all exits.

## 同時移動（3D-04）

Shared immutable boundary; relative sweeps stop both at first body contact/endpoints,
allow separation. Ground tangent projection,3D flight, semi-implicit gravity under locks.
Supported jump/ceiling and full-body steps: lift20%, reserve20% drop if support<=10mm.
Retain bends/ledge progress, no carried step jump velocity. Segment excess truncates.
Landing=floor(max(0,downward-safe)*rate/1000); flight expiry restores retained vertical
velocity. Support tolerance1μm beyond skin. Rapier plus f64 fallbacks preserve face/edge/
corner normals/rear faces; skip separating/tangent contacts, continue query.

## 地上・空中経路（3D-05a）

Surveyed static support graph versus delayed observed local terrain; real collision always
wins. Distinct height-aware ground/air nodes; diameter/height+4mm clearance, walking samples
<=250mm, gait-aware <=20ms jump sweeps. Flight cannot bypass walls. A* distance plus estimated
stamina/max(1,remaining), straight-distance heuristic; legacy distance only. Cache gait, not
stamina. Distinguish resource-limited/unreachable/budget-exceeded. Execution alone pays.
Relative-geometry ties, no ID/order priority. Policy altitude projects to first support;
explicit graph goals preserve levels.

## 観測と行動方針（G-05）

[ADR0009](../adr/0009-observed-ai.md) and the pinned full specification own weights/priors/
knowledge/condition thresholds. +X forward/+Z right,vertical fallback+X. Eye samples freeze
pose/time,deliver after reactionSteps; lost targets retain lastSeen for memorySteps.
No hidden/future state. Observed state conditions need delivered visible snapshots, not memory;
unknown is not true, invisible statuses are not absent. Impacts/reveals delayed and typed.
Record observations/weights/draws. Silence/category/permanence rules apply; dodge/navigation
use only own geometry and observed threats/terrain. Candidate order cannot add utility.

## 効果と状態の同時解決（3D-06a / G-02 / G-03）

The pinned full specification owns exact G-02 power/scaling/rounding and G-03 cohort/
adjustment/element-reaction/AI formulas and worked fixtures; damage.ts owns shared arithmetic.
Order power-defense(floor0)->coverage->resistance->dealt->received->absorption->shared shield->HP;
BigInt floors, exact proportional attribution, one simultaneous HP+heal-damage clamp.
Launch freezes source; target modifiers/cohorts frozen per transaction. Omitted magic inherits
adjusted physical; explicit0 independent. Defense and element/category remain separate.
Statuses [start,end), expiry before pulses, grants next boundary, dispel old cohorts.
Sum caps,refresh retains origin,replace resets,reject retains; conflicting revisions require
explicit resolution. Element response once per old state/element/transaction even at zero
damage; explicit water overrides burning. Remove beats strengthen; competing transforms
unresolved, no recursive transforms. Permanent end12000 resists ordinary removal, different
revision replacement unresolved. G-04 pulses/recovery use shared resources/start modifiers.
Visibility/capability selectors remain separate; committed attacks survive action locks.
Visible status summaries<=64 omit exact hidden values; own evaluation uses full closure,
enemy uses delivered summaries only. Contextual impacts cannot retrain baseline resistance.
Type/cause overflow truncates, never drops statuses. Sealing remains P6.

P6-02 (#184) [full recovery contract](https://github.com/apaapapapapa/FantasySimulation/blob/be04fcd5d0c34b88b5ffbdd8894b22de11b8d607/docs/rules/spatial-v1.md)
supplements this baseline: absorption before shield becomes same-wave hpRecovery-scaled
healing. Drain uses exact shares of capped actual HP loss; apply rates before one floor,
freeze bases before reciprocal credits, then clamp HP once. No self/periodic/cost/fall/
redirected drain. Contact/periodic reactions, delayed coarse observations and optional
recovery records follow that contract; replay stays engine-free. See recovery-pairs.json.

## 同時選択（#45、spatial-v1.15）

[Tactical rules](tactical-ai.md) own spatial-v1.19+ search/posture/cover. Optional
ai.slots=simultaneous-v1: shared observation->action->feasible movement lottery; separate
direction sample. Seed actor xor0x13198a2e, sole choices no draw. Protect flight and atomically
admit skill+dodge+jump; failure retains previous legal intent/costs/clocks, no skill-only
fallback. Cast-stop excludes paired dodge. Save candidates/exclusions/draw; no private enemy data.

### Optional candidate floor (#45)

minimumCandidateWeightBps0..10000 discards iff w*10000<max(original)*floor. Equality and
survivor weights stay; omitted/0 preserves draws. Log before/effective weight and totals.

## 段階攻撃・移動（G-07）

[stages-motion.md](stages-motion.md) owns scheduler/ledger/force/resources, spatial-v1.17.

## 行動時計と攻撃形状（3D-06b）

Positive action speed scales cast/recovery/cooldown by ceil(steps*10000/speed), recovery>=1.
Recovery follows physical active time, cooldown release. uses0 unlimited; insufficient
resources reject all payment, exact HP0 cost legal, post-payment fizzle no refund.
Observed/remembered target range/muzzle checks, no rear starts; launch-facing aim freezes,
two yaw/pitch draws even at zero error. Hitscan first wall/body; melee thrust sphere retains
body bends/relative sweeps. Hit limits persist across intervals. Attack initial overlap hits;
epsilon wall/body tie favors wall. Centre-to-muzzle checks; HP commits at interval end.

## 固定step対戦と記録（3D-06c）

Pull simulate yields initial/optional boundary/20ms interval/terminal; finally frees WASM,
no I/O/clock/Worker ID. Boundary expiry->periodic->defeat->observation->AI->payment->release.
Movement/contact/effects/recovery atomic, AI100ms holds intent. No extra final boundary.
Same-interval lethal HP keeps launched effects; one survivor wins, mutual defeat draws.
Startup whole self group pays/resolves before periodic0; failed admission waits recovery.
G-04 stamina/locomotion: optional fields preserve legacy; zero latches exhaustion until
resume threshold. Shared resource reservations and actual travel costs are summarized in
[stages-motion.md](stages-motion.md); the pinned full specification retains all recovery/
carry/upkeep/flight/fallback/AI formulas and sample values. No duplicate accounting or refund
of committed costs; gravity continues and enemies never see exact stamina.
Boundary/interval rollback separately restores state/RNG/IDs/ledger/events; attempted work
survives. Invalid/internal errors stay failures. Cumulative events/bytes/frame;32KiB control,
pathNodes per search,casts/candidates per match. Causal serialization is not priority.
Replacement states/bent paths replay without engine. Event and event-free trajectory hashes:
f64/canonical JSON/LF/SHA256; TS includes clocks/knowledge/RNG, current physics is static Rapier.
Checkpoints cannot resume. [ADR0006](../adr/0006-recorded-replay.md) owns storage/playback.

## 飛翔体・誘導・爆発（3D-07）

Reserved projectile.*; launch snapshot,sphere versus body relative sweeps,first wall/body
removes,owner excluded. Contact point differs from centre; nonunique start contact diagnosed.
Lifetime includes launch, expiry never explodes; verdict never waits for bullets. Homing uses
launch-known or delivered owner-visible target only; loss continues velocity/gravity. Public
cues omit private target/definition/RNG. Segments follow pinned error/gravity/turn formula,
not work budget; approximation is local, no exact full-curve claim. Excess rolls back.
Explosion replaces direct damage and includes owner: exact sphere/capsule intersection then
five equal body samples/LOS/radial falloff, floor(sum*2000) coverage. Inside blocker=0;
degenerate samples use pinned rules without arbitrary direction. Scale damage/heal/shield
after defense; status/dispel once if coverage>0. Not volume integration. Record actual
spawn/segments/update/contact/remove/causes; no interpolation past removal.

## サンプル

New IDs only; catalog fixed battles cover chase/detour/flight, enumeration invariance;
not win-rate or persistence performance claims. Preserve independent expected outputs.

## 反応型発動

[reactions.md](reactions.md) owns spatial-v1.18; [ADR0016](../adr/0016-p6-foundation.md)
owns P6 admission/diagnostics and official milestones. Published revisions stay readable,
old execution rejected. P6-05 design approval does not enable any new mechanic.
