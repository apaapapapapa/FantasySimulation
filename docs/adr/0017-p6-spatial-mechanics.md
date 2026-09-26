# ADR 0017: P6 spatial mechanics

**Owner-approved 2026-09-26.** Refs #155 §7/Q-9/Q-10, #1, #61, #45, #10.
P6-00 merged; P6-05 was design-only; Group1 progresses independently.
[ADR 0016](0016-p6-foundation.md) governs admission, diagnostics and milestone publication;
[stage/motion](../rules/stages-motion.md) and [reactions](../rules/reactions.md) retain ownership.

## Scope and decisions

Group 2 adds standard teleport, barrier, persistent area, beam and phasing after all
accepted standard interference is defined. Still exactly two actors; spatial objects
have owners and geometry, never turns, minds, actor RNG streams or victory eligibility.
Unimplemented payloads remain rejected even with experimental permission.

| Approval point | Accepted rule                                                               |
| -------------- | --------------------------------------------------------------------------- |
| Q-9 target     | Fixed relative offset from self or delivered visible enemy; no randomness.  |
| Teleport       | Release n -> boundary n+1; whole-body clearance, no path/fallback search.   |
| Conflicts      | All overlapping candidates fail; occupied starts remain reserved.           |
| Barrier        | Solid sphere/box/cylinder, finite durability/lifetime, owner-aware layers.  |
| Following      | Boundary translations; blocked move holds prior pose, no pushing.           |
| Q-10 exit      | Body-only protection<=50 intervals, then diagnostic truncated; no ejection. |

Random teleport, rotating/deforming barriers, hollow shells and independent emitters are rejected
until later versioned contracts.

## One coordinator and an atomic world

`simulate.ts` already commits boundary and interval separately. `StepTransaction` clones
TS state, but `SpatialWorld` currently populates static colliders/bounds only once.
Do not mutate that shared world from an effect callback. Extend the existing transaction
with pending spatial commands, object state, exit state, ledger and a candidate world.
Build the candidate from immutable terrain plus the complete proposed object set in
canonical order, update query bounds/indices, validate, then swap it only after the
journal fits. Free failed candidates and keep the old world/TS/RNG/IDs/ledger/records.
Unchanged geometry reuses the world (durability-only changes do not rebuild). Attempted casts/candidates remain counted on failure.
No additional simulation clock, recursive contact loop or incremental half-commits.

Owner slot/emission ordinal orders handles, never winners or public IDs; resolve geometric
ties together. Test reorder physics hashes and mapped slot/position/RNG symmetry.

| Phase              | Addition, in order                                                              |
| ------------------ | ------------------------------------------------------------------------------- |
| Boundary n         | Remove expired/broken objects; existing status expiry/pulses/reactions/verdict. |
| Surviving actors   | Phasing/posture -> following objects -> queued placements -> queued teleports.  |
| Observation        | Commit boundary/world, then delayed sampling and ordinary AI/payment.           |
| Release [n,n+1)    | Queue relocations/barriers/areas for n+1; beam starts with its stage.           |
| Contact/resolution | Shared movement/ledger/waves, aggregate durability; removal at n+1.             |

Each boundary subphase uses a shared snapshot; terminal battles activate nothing.
Following objects and new placements validate against pre-teleport bodies. A newly active
barrier therefore blocks a same-boundary teleport destination. Within a subphase, conflicting
proposals all fail; never retry losers after another proposal fails. Source permission is
rechecked for queued commands after periodic effects: dead/incapacitated/sealed or interrupted
sources fizzle, retaining committed costs. Startup and reactive spatial commands are rejected.
Boundary0 starting phasing is allowed through ordinary starting statuses; initial spawn must
still satisfy existing solid-body validation. The last allowed interval processes effects
normally but does not add boundary6000 activation; pending commands are logged as battle-ended.

Physics, geometry, movement, visibility and navigation share layer/owner/material/floor/ignored-object
context across sweeps, overlaps, support, muzzle, blast and navigation, including f64 and Rapier.
Invalidate geometry caches; AI uses delayed known dynamic objects even on surveyed terrain.
All queries charge the existing work meter.

## Teleport contract (P6-06)

Add one strict self-directed action/stage relocation operation, separate from dash/leap
velocity. Its stage has direct/self targeting and no attack payload or second teleport;
reject reactions, battle-start, concurrent authored motion and a paired dodge. An actor
can have at most one due relocation. Existing action clocks, top/stage costs and uses apply.
Cancellation before payment costs zero; failed destination/release after payment refunds
nothing and does not shorten recovery/cooldown. No distance or jump charge for the jump.

Input: anchor self|observed-enemy, direction front|back|left|right, distanceMm 1..200000
and maxDistanceMm 1..200000, with distance<=maxDistance. Freeze destination at release:
self uses its release centre/horizontal facing; enemy uses only the delivered visible
snapshot's centre/horizontal facing. No lastSeen/pending/live enemy state; missing visible
anchor fizzles. Use the pinned angle/axis convention, right=(-forward.z,0,forward.x);
vertical-only facing uses the existing +X fallback. Preserve anchor y; round once to integer
mm, ties away from zero. Require actual source-to-destination distance<=maxDistance at
activation too. No RNG draws, hidden clearance search or silent clamp to the arena.

At n+1 check arena containment and current whole capsule/posture against terrain, active
movement-blocking barriers and both pre-teleport occupied bodies (excluding self).
Destination validity ignores the mover's phasing: teleport never embeds a body. Paths may
cross walls, bodies and barriers; endpoints may not. Positive overlap uses the existing
binary64 penetration tolerance; legal support touching is not penetration. Pairwise compare
all candidate endpoints, including individually invalid ones, and fail every overlapping
candidate. Swaps into occupied starts fail even if both intend to leave. Record failures for replay without exposing hidden obstructions/coordinates to enemy cognition.

Success changes centre only. Retain facing, velocity, gravity accumulator, force contributions
and clocks; invalidate support/navigation caches and end active dodge without refund. Resume
ordinary force/gravity/movement from the destination. Do not synthesize a trace between the
two centres or reset falling speed. Attached shapes end at the jump and restart, if still
active, at the destination with the same hit ledger; no swept attack bridge. Detached shots,
areas and fixed barriers retain their poses; following barriers update next boundary under
their own collision rule. Already aimed attacks keep aim; homing learns only through ordinary
owner observations. Opponents losing sight retain lastSeen, not the destination.

## Objects, barriers and contact resolution (P6-07)

Common object state: stable reserved ID, kind, owner, exact ability/stage/cause, launch
snapshot, pose/shape, pending/active window, attachment and ledger identity. Barriers/areas
queue release n -> active [n+1,n+1+durationSteps); duration1..6000 (beam timing below). Cancel pending commands with their stage;
once activated, fixed barriers and areas are detached and persist through source interruption
or sealing. Following barriers and beams are attached and end when the stage is interrupted,
sealed, owner dies or attachment window ends. Following barriers require stage duration>=2
and lifetime within its remaining window after next-boundary activation. Detached effects
never prolong a finished duel.

Barrier shape dimensions/radius are integer1..50000mm; box yaw uses the pinned angle table.
Define durability1..1000000 and movement/vision/attack selector independently as
none|owner|enemy|both; at least one blocks. Material is energy. For attack queries classify
by current attack owner (including deflected projectiles), not original power snapshot.
Vision selectors use observer; movement selectors use mover. All shapes are solid volumes.

Barrier placement.maxDistanceMm<=ability.rangeMm; anchors use teleport targeting/visibility rules. No
terrain/active-barrier penetration; no overlap with any actor it movement-blocks. A vision-
or attack-only barrier may contain a body, but inside-origin occlusion applies, including
muzzle checks; a barrier never supplies an escape exception. Proposed overlapping barrier
volumes all fail. Movement-blocked bodies win over placements regardless of actor order.
Failure keeps paid costs. Floor/support contact is legal; all geometry remains within bounds.

Following barriers preserve release orientation and owner-relative translation offset.
At boundary n propose the pose from the owner's current centre; sweep the full shape from
old to new against terrain, other barriers and affected pre-teleport bodies. Collision or
pairwise swept conflict keeps every involved follower at its old pose. Test all proposals
against old poses too; no vacated-space optimization. Holding is logged, costs/lifetime
continue. Teleport never transports a barrier instantly. New activations cannot overlap
the resulting followers. Bodies move against these stationary interval poses; no crush damage.

For a projectile/hitscan/melee/arc/beam, earliest attack blocker wins; epsilon ties between
terrain/barriers/body prefer blocking geometry over body. Tied barriers all receive the full
damage request, not an ID-selected winner; static terrain in the tie shields all barriers.
This explicit rule also covers touching barrier faces. Deflection/parry are body reactions,
not barrier reactions; a blocking barrier intercepts before either. No damage passthrough
when a barrier breaks during an interval; all that interval's attacks see the same geometry.

Durability uses the existing source-snapshot damage calculator with defense0, resistance0,
takenBps10000, no shield/absorption; sum positive damage simultaneously and clamp once.
Do not deliver heal/status/force/reveal, drain, revival or owner reactions to a barrier.
Other contact payloads stop at it. New object targets extend contact/ledger identity, not
the two-actor arrays. Drain remains based only on actual opponent HP lost.
Durability0 disables the object at the next boundary. No per-event collider deletion.

Explosion: preserve existing five equal body samples/falloff and shared snapshot; attack-
blocking barriers join occlusion. For barrier durability, use closest surface distance and
the same radial falloff (0 outside); other blockers occlude the ray to that surface, the
target barrier itself is excluded. A directly contacted barrier receives this explosion
damage once, no added direct damage. Origin strictly inside a blocker gives zero outward
coverage. Surface-origin rays ignore only the struck collider's zero-distance outward hit,
never its interior or far side. Wall/body epsilon and cast budgets remain authoritative.

### Persistent areas and beams

Area is a detached nonblocking solid sphere/box/cylinder using the object scheduler;
it may overlap terrain/bodies/other areas. Its activation condition uses the existing
bounded own/delayed-observation AST, sampled at release, with armDelaySteps0..6000,
periodSteps1..6000 and the stage's per-target hit policy (maxHits<=16). First eligible
interval is activeFrom+armDelay; require at least one pulse before expiry. Each eligible
interval sweeps the whole body trace against the volume, so crossing between endpoints
counts. Require attack line-of-sight from the area centre to first contact; an embedded
blocked centre cannot damage through walls. No five-sample explosion scaling for areas.
Continuous occupancy can hit again only by period and ledger; requireSeparation retains
its full intervening no-contact interval semantics, tracking occupancy on non-pulse steps.
An already occupied area can hit at its first eligible interval. Only the opponent is a
target in this increment; chains that create objects on contact are rejected.

Beam is an attached radius0..1000mm segment, length bounded by ability range, existing
stage duration1..100. Freeze direction and source power at release (ordinary two aim draws),
follow actual muzzle traces without retargeting. Check centre-to-muzzle occlusion, then
relative continuous contact against body traces/first wall or barrier in each interval;
moving muzzle bends use existing segmentation budgets. Hit spacing/max/separation use
the same ledger, not a beam timer. A nearer body blocks the rest; barriers/walls terminate
the segment even when their hit limit suppresses damage. Record actual clipped geometry.
No projectile, explosion, reflection or new AI lottery; whole parry cancels one accepted
body contact, damage-only parry keeps non-damage effects. Zero damage consumes a hit.

Retain ledger keys while a detached area remains active, even after its action recovers;
prune only when no stage/projectile/object uses the action. Paused/suppressed hits never
reset counts. Detached areas need no upkeep; beams use existing stage cost, without hidden
per-step charges. Later resource subscriptions need an explicit separate contract.

## Phasing and safe exit (P6-08)

Optional authored terrain material: generic|stone|wood|metal|earth; omitted=generic without
rewriting saved revisions. Barriers are energy. Arena boundary colliders always block all
layers and cannot be phased, including bottom/ceiling. Unknown materials/keys fail schema.
Body phasing is a status capability listing a nonempty unique material set and explicit
floor boolean. Attack phasing is a separate attack definition with the same selectors,
frozen into each launch snapshot; never inherited from the owner's body status.

Body masks affect movement/support only, not actor/actor contact, incoming attacks or vision.
Attack masks skip selected obstacles in muzzle/sweep/explosion/area/beam queries, not bodies.
Neither grants invisibility; visible/hidden phasing cues follow status.visibility. floor=false
keeps walkable supporting faces even on matching material (normal.y >= the mover's existing
maxSlope cosine; attacks use the owner's launch slope). floor=true also skips those faces.
Normal-dependent filtering applies equally in analytical and Rapier paths, with bounded
search past ignored contacts. Entry-overlap queries use the matching material mask; exiting
always checks the full solid body. Losing floor support applies ordinary gravity/flight.
Energy must be explicitly selected to pass barriers; no ownership immunity is inferred.

Multiple active body masks combine by union, including floor permissions, with provenance.
Expire/dispel/seal removes the corresponding contribution at its ordinary boundary. Test the
whole current capsule against newly solid obstacles. If embedded, mark exit-pending and retain
only the old body mask needed to leave; attack phasing, visibility changes and other status
benefits end normally. Posture changes that would introduce new penetration fail normally.
Existing actor collisions, arena walls, gravity and forces remain active. No extra HP/cost.

Retry at each boundary; on the first clear pose remove the safety mask. Extension count is
per actor and cannot reset via refresh, dispel, seal, regrant or changing embedded material.
Clearance under the fully solid body resets it. After 50 executed extended intervals, if
still embedded, throw SpatialBudgetError at that boundary: resource=phase-exit-steps,
observed=51, limit=50, causes/revisions under ADR0016. Roll back that boundary, retain the
last committed display; this is not a draw/unresolved/automatic defeat. Match termination
does not add exit steps. A same-boundary successful teleport can leave the obstacle, but
never erases already exceeded work; last-budget exit must commit before the retry boundary.
Sealing therefore disables the ability immediately while bounded collision protection avoids
materializing inside terrain. Record extension separately from the expired/sealed status.

## Bounded work, interference and records

New budgets (omitted uses defaults): active+pending spatial objects64/match,
allowed1..256; pending commands64/boundary, allowed1..256. Count barriers/areas/beams together,
including simultaneous emissions before choosing any result. Lifetime and hit counts above
are rule semantics; object/command/cast/candidate/curve/frame budgets only bound work.
Every candidate-world build/overlap/tie/pulse/exit query charges the existing meters;
overflow rolls back the entire transaction with observed/limit/cause, never drops objects.
The phase-exit50 rule is fixed in the versioned ruleset, not raised automatically to finish.

Each implementation fills every ordered/self/conditional cell in ADR0016's matrix and
executed coverage. Include teleport/teleport, barrier activation/endpoint conflict, phasing/
force/stages; barrier/projectile/explosion/beam/area/terrain; area/beam versus parry/absorb/
drain/revival/status; phasing/material/flight/force; seal/pending/attached/detached/permanent.
Ordinary body contacts retain Group1 waves; objects have no actor reactions; no deflection
of areas/beams. Also cover all accepted damage/heal/shield/status/flight/silence pairs.
Concept mechanics stay reserved/rejected pending their ADR, never independent by default.
Standard admission waits for complete defined behavior and fixtures; genuinely undefined
experimental interactions need ADR0016 diagnostics. This prose is not the JSON matrix.

Extend domain StreamRecord/ReplayState additively with boundary actor/from/to/cause/rule,
object spawn/update/remove/window/owner/shape/durability/attachment, clipped beam/area contact,
phasing/exit state and bounded causes. Hash pending commands/objects/ledger/masks/counters and
cache-independent world state. Failed attempts never leave dangling IDs. Domain validates
references/time/geometry/caps atomically without engine; old omission=no new feature.
Checkpoints and both seek directions restore the complete display. Jump boundaries never interpolate, including loop/reverse seek.

AI derives range/occupancy/exposure/cost/uncertainty from definitions and known terrain, never
ability IDs. Enemy knowledge is delayed visible geometry/activation/damage, excluding private
durability/uses/endpoints/masks/unseen objects. Keep replay truth separate from cognition and
navigation. Render records or explicit unsupported cues; never hide barriers or replace motion.

## Delivery ownership and acceptance

One owner integrates schema/variants, matrix/coverage, transactions, query context, version and identity.
Feature owners supply resolver/AI/record tests; renderer/API consume domain records. No separate restamps.

1. P6-05: design/document compaction/review/approval only.
2. P6-06a: shared query and atomic world with legacy no-op fixtures; 06b teleport end-to-end.
3. P6-07a: object lifetime/barriers; 07b areas; 07c beams, each end-to-end.
4. P6-08: materials, body/attack phasing, safe exit and cross-mechanic fixtures.
5. Group2 integration/viewer verification, official revision dry-run/calculation/publication
   under ADR0016 (same20 participants, old public results preserved).

After approval, feature design/tests may progress in parallel, shared foundation merges first,
then 06->07->08. Reuse latest Group1 APIs and add cross fixtures before merge. ADR0010 governs
new rules IDs/decision versions and reviewed identity/corpus transitions: batch only behavior
shipped together. Omitted additions preserve independent legacy expectations. No old engine/DB
conversion. Proposed DTO spelling can be refined during schema review, not these semantics.

| Planned independent fixture                             | Required result                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| T1 wall path; headroom/range/arena/occupied endpoint    | Path ignored; whole-body failure retains payment, no new RNG/travel cost.        |
| T2 same destination/swap/invalid overlapping candidate  | Both fail under ID/slot/order permutations, no freed-origin reuse.               |
| T3 hidden/moved enemy; force/fall/arc/homing            | Frozen delivered target, no leak/bridge/force reset; ledger retained.            |
| B1 release20/duration3; conflicting new barriers        | Active21..23, absent24; both conflicting placements fail.                        |
| B2 durability10, simultaneous damage6+6                 | Both blocked, durability0 at end, absent next boundary.                          |
| B3 follower wall/body/teleport; selector/epsilon ties   | Held pose/no crush, deflected ownership, joint barrier/terrain rule.             |
| B4 blast surface/inside/behind barrier                  | Five body samples, explicit barrier falloff, no direct+blast duplication.        |
| A1 release10,delay2,period3,duration10,maxHits2         | Active11..20,pulses13/16/19,first2 hits; crossing/separation verified.           |
| A2 expired action with live field; bent/blocked beam    | Detached ledger retained; clipped traces, no tunneling/reset.                    |
| P1 material/layer/floor/energy combinations             | Independent body/attack masks, boundary/support/force/flight rules.              |
| P2 expiry/cleanse/seal/permanent/regrant                | Safety mask only, clear-before-cap success,51st extension truncates.             |
| X1 object/command/build/cast/journal limits; unresolved | Exact limit passes,+1 rolls back world/TS/RNG/IDs/ledger/display; work retained. |
| X2 old/new replay, Worker/SQLite/Pages                  | Engine-free seek/loop, old omission, malformed rejection/unsupported cue.        |
| X3 repeat/reorder and mapped slot/position/RNG swaps    | Same-input result/event/trajectory/TS/physics hashes, independent symmetry.      |

Acceptance also requires new-ID samples, prepare/job/league admission including dormant closure,
matrix coverage, strict schemas/exhaustive switches, AI/privacy/replay/renderer tests,
corpus/load gates, quality/verify, clean-source and Linux PR/main CI.
Approved design: PR #182 head `fa1b7850b5aabed2ea12d18cc949be012943110e`.
#155 stays open for the remaining P6 work; its spatial design approval is satisfied.
