# 段階攻撃・移動（G-07、spatial-v1.17）

standard-motion-v1 supersedes standard-stages-v1.
[Full implemented contract/examples](https://github.com/apaapapapapa/FantasySimulation/blob/63b49c60bba9af4007061b7eb1228c7b4fad8ac4/docs/rules/stages-motion.md)
remains authoritative for every geometry/projection/resource/validation detail summarized
here; no rule changes. [reactions.md](reactions.md) owns G-08; [ADR0017](../adr/0017-p6-spatial-mechanics.md)
defines accepted teleport/barrier/area/beam/phasing design awaiting implementation.

## Scheduler and ledger

Omission preserves costs/aim/events/hits/PRNG. Required fields=stage0 once; action only,
1..16 unique ordered nonoverlapping stages,first offset0,end<=6000,duration1..100;
melee duration=activeSteps,hold=null attack/empty effects. Other releases emit once,
detached shots outlive stages. L=speed-scaled release; physical [L+offset,L+offset+duration).
Recovery planned end,cooldown L; failure never shortens clocks. Recheck capability/condition/
observed range at start; failure cancels remainder/no retry. Boundary interruption cannot
rewind interval contacts; attached shapes cancel, detached snapshots/legacy melee persist.
No final extra pulse. Shared action/stage/group/target ledger: default1,max16,minInterval>=1,
optional full intervening separation; zero damage consumes,miss not. Clone/hash/rollback
ledger/stage/cost/RNG together. Future emitters reuse this scheduler.

## 形状・外力

Contact retains stage/emitter/group/target/time/geometry/causes. Arc/radial capsule sweeps
whole shaft along bent traces in launch-frozen horizontal plane, fixed table, not endpoint
cones. Positive rotation+X->+Z; radial360°. Explicit stages,reach<=20000 and range,radius<=5000,
start±180000,sweep nonzero±360000. Muzzle/radial occlusion,first wall/epsilon priority apply.
Shared cast budget,256 unresolved advances truncate; saved root/tip curves bounded.
Motion collision/gravity->force->stage->dodge->gait. Strict linear-v1 force away/toward,
speed1..100000,duration1..100, frozen contact vector/coincident0,round ties away from0.
Active[n+1,n+1+duration),BigInt vector sum,Euclidean cap1..100000(default100000).
Nonzero F suppresses voluntary motion; G starts previous vertical velocity,flight0/else gravity.
Move F+G; inward combined velocity projects BOTH through trace collision normals; body/no-progress
P=0,unblocked cancellation identity. Carry projected G only,rebuild F; expiry resumes G.
Landing uses combined incident y. Log/hash contributors/cap/G/projections; root stops no force.
Dash/retreat/leap use frozen horizontal facing (vertical+X),speed<=100000,acceleration<=1000000;
leap uses supported ordinary jump at first interval. Walls clip travel,not clocks.

## 同時選択・資源

One observation/ResourceBudget. Top cost/uses+stage0 at declaration,later extra at start,
no future holds. Protect flight, atomically admit skill/stage+dodge/jump; shortage cancels
new work, preserves legal prior gait/flight. Current authored motion excludes dodge;
force suppresses both; cancel unstarted holds,never refund committed burst. Ordinary order
skill->flight->dodge->jump->step->travel; run->walk->slow fallback. Stage cost replaces gait
travel,not G-04 flight/jump/step; force adds no target cost,dodge burst+travel. HP0 cost legal,
verdict after effects. G-04 owns clamp/carry/exhaustion/start-modifier recovery.

## 入力・実装境界・検証

maxForces default64,range1..256/actor; overflow rolls back with observed/limit/cause.
Display clocks/motion/geometry/projections restore engine-free; enemy cues delayed/visible,
own AI definition-derived. Published IDs/Goldens preserved,new versions/identity reviewed,
old execution rejected. Full pinned contract retains samples/numeric examples and acceptance:
geometry/projection/endpoints,admission/cancellation/ledger,rollback/privacy,corpus/paired-load,
real Worker/SQLite and bidirectional replay seeks.
