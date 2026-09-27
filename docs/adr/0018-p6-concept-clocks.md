# ADR 0018: P6 concept clocks and finite defeat protection

**Accepted for implementation by the owner's 2026-09-27 request to implement all remaining
skills before completing #155.** Refs #155, #1. Baseline `39c769091133dc94907f7090dead65d052e3d383`.
This instruction supersedes the proposal's implementation hold; it does not assert earlier approval.
[ADR0016](0016-p6-foundation.md), [ADR0017](0017-p6-spatial-mechanics.md) and
[reactions](../rules/reactions.md) govern existing mechanics. The [companion](0018-p6-concept-cases.json)
retains independently authored arithmetic and acceptance requirements; executed bindings live in the corpus.

## 1. Clocks and representation

Use the existing 20ms coordinator/StepTransaction. Global G is simulation time, not host time;
maxSteps/sequence/budgets/global deadlines never pause. Subject clocks start at zero. Latch the
freeze mask at boundary n; committing [n,n+1) advances G/unfrozen clocks once and frozen clocks
zero times, even if released during settlement. Boundaries/probes/final release add no tick.
Absent early release, stop [s,s+d) freezes d intervals and ends at s+d. No catch-up/second scheduler.

- **Global**: match/record times, stop expiry, spatial-object lifetime, detached area pulses,
  pending command activation, work budgets and phasing exit-safety intervals.
- **Motion (actor)**: translation/velocity/gravity, force lifetime, posture/dodge/jump progress and
  motion-resource costs. Freeze preserves state without accumulating skipped forces/gravity.
  Frozen targets pay no motion/flight maintenance; unfrozen hovering retains normal maintenance.
- **Cognition (observer)**: sample/delivery/decision readiness and memory ageing. Freeze permits
  none; preserve captured payload/remaining delay. Other observers use their own clocks normally.
- **Action (actor)**: cast/stage/recovery/cooldown, reaction readiness and paid counter release.
  Freeze emits nothing, incurs no new cost and retains paid costs/uses.
- **Status/resource (recipient)**: start/expiry/pulse schedule, regeneration/carry, status-resource
  updates, including immortality duration. Seal alone suppresses effects but pauses no clock and
  resets no pulse origin. Freeze pauses this domain; never replay missed pulses.
- **Projectile (instance)**: age/lifetime/homing advance unless CURRENT owner is frozen.
  Deflection preserves instance remaining life/launch power/provenance, not owner-clock deadlines;
  retain no-homing/no-repeat-deflection/no-drain. Consumed shots never reappear.

Frozen bodies remain collision capsules, not pushable or immune. Attached melee/beams stop
emitting; fixed barriers/areas keep blocking/expiry/pulses. Following barriers hold pose.
Their lifetime and beams' object-expiry caps stay global. Freeze alone is not interruption;
actual seal/incapacity/death follows existing attached-object rules. Detached snapshots persist.

Hit keys/counts retain action/stage/group/target identity. Re-hit intervals use action time for
attached melee/beam and GLOBAL time for detached areas/projectile groups. Never compare ages
of different shots; instance age is only for lifetime/homing. Freeze/deflection never rebase
hit timestamps. Keep the touching latch: only resumed clearance proves separation, not omitted
emissions/global gaps/thaw. Retain live/pending ledgers; release never repeats hit admission.

Phasing exit counts committed GLOBAL intervals even when frozen. Its unchanged50-interval cap
can cause phase-exit-steps truncated before thaw, not defeat. No terminal exit work/ejection.

### Deadlines and display

Deadlines carry owner/domain. Status duration10 at recipient time60 ends at70 even when G=100;
activation/startStep/startedAt/launchStep/sampledAt remain GLOBAL stamps. Refresh/transform use
recipient time and existing cohort/pulse rules. Never compare subject70 with global100.
P6-10 adds explicit deadline bindings, remainingSteps and freeze provenance. Legacy end/launch/
recovery fields project G+remainingSteps at recorded projectionAsOfGlobalStep (110 here), NOT expiry promises
while frozen; refresh projections/bindings on thaw. Readers change state only from records,
never expire from projections. Apply to action/status/force/projectile; validate ranges/bindings
engine-free. Internal deadlines are not rewritten each tick; old unbound records keep meaning.
Advertise required clock/release features so unsupported readers reject them.

Hash effective clocks/deadlines/freeze/queues/hit latches, not unused standard clock fields.
No-stop results/events/paths/digests stay unchanged; derive clocks lazily from G until needed.
Observations keep sampled payload, global stamp and observer-clock delivery/age. Neither thaw
nor AI forecasting may substitute live/pending enemy state or private expiry for delivered data.

## 2. Stop control and boundary order (P6-10)

First profile: fixed mask, one opponent, action-triggered; reject arbitrary masks, startup/
reactive stop, nesting/addition/refresh. Paid release n queues one fixed-target request for n+1.
Release checks authored observed-target/range/line-of-sight; activation rechecks source life/
capability, target identity, actual range/line-of-sight and immunity from the shared POST-SPATIAL
snapshot. Invalid requests fizzle without refund/retry; teleport can escape activation range.

Status capability stopImmunity=true requires time-stop permission even through dormant paths.
Only effective opening immunity resists; seal disables it. Innate/temporary variants use
starting/ordinary status cohorts. The separate global CONTROL cannot freeze itself or be
removed/suppressed by ordinary dispel/seal. Later immunity is not retroactive. Source seal/
incapacity/channel interruption does not end it; prospective defeat invokes §3 even if revival
is possible. Dedicated dispel-stop is unsupported; fizzle cues leak no hidden immunity/counts.

At most one control is active. A surviving control or frozen source makes a new request
ineligible. TWO individually valid opposing requests BOTH fizzle; invalid/resisted requests
cannot cancel valid ones. No ID/order/speed/RNG tie-break. Activation reserves FULL duration
against the match allowance with no early-release refund; record reserved and executed time
separately. Exhaustion fizzles, never silently shortens duration; match end may release early.
Work overflow is separately truncated. Capacity tests use the companion bounds.

Boundary n, with shared snapshots inside each subphase:

1. Preserve startup at n=0; remove due/broken global objects, end due stop controls and expire
   statuses against subject clocks. No clock advancement here.
2. Collect due resource/periodic effects and released contacts; settle through existing boundary
   reactions, §3 lethal release and revival. Retain owning stage-interruption/phasing-safety
   checks before commands; do not bypass their errors with a win.
3. Apply existing verdict/eligibility. For a surviving battle, ADR0017 order is phasing/posture,
   following objects, queued placements, queued teleports. A new barrier can block that teleport.
4. Evaluate new stop requests together from the post-spatial snapshot and commit their masks.
5. Publish the atomic boundary/world; only unfrozen actors then sample/deliver/decide.

Valid paid teleport/placement completes BEFORE new stop, without another deferral queue.
Previously frozen sources instead fizzle pending commands without refund; detached objects are
not pending placements. Release precedes re-stop; maxSteps activates nothing and keeps
battle-ended diagnostics. No-concept execution retains its existing ordering.

## 3. Capture, settlement and finality

At global contact consume hit/projectile lifecycles and defer the COMPLETE hostile payload,
including embedded heal/defeat/status/dispel/force/elemental effects. Paused status pulses produce
nothing; detached hostile areas may still hit. Store bounded immutable revision references,
launch stats, actor/target/causes/ancestry/ordinals/stage/group/projectile IDs, never whole worlds
or unbounded definitions. Freeze contact position/direction/coverage/blast falloff/occlusion/
reflected drainDisabled; release geometry never replaces them. No before-hit for captured hits;
normal contacts retain their already evaluated before-hit disposition/cost exactly once.

Release all pending targets in ONE root wave using original power/captured coverage. Opening
release state supplies defense/status modifiers/resistance/shield/absorption/defeat/immortality.
Reuse shared damage/shield/drain allocation, with no per-contact HP clamp. Force starts at
release in its captured direction. New statuses start at ordinary commit in recipient time,
not historical contact time. Same-wave grant/cleanse/seal cannot rewrite opening defenses.
After-damage and before-defeat/revival use the bounded shared reaction pipeline after thaw.
Pure defeat creates no damage; real positive post-shield damage keeps its after-damage trigger
regardless of HP clipping/protection.

### Lethal release BEFORE committing death

Replace the prior "commit normal wave/revival, then flush" proposal. While stop is active,
make a PURE ordinary allocation plan before committing an effect wave, including §4 guard/
drain selection but excluding before-defeat/revival. Any planned HP0 latches early release,
even if revival might later save it. The probe commits no HP/shield/guard/RNG/cost/ID/event.
End all controls and recompute the CURRENT wave once from its unchanged opening snapshot with
all captured contacts. The latch persists even when combined healing prevents death. Commit
only that allocation and run the applicable reaction continuation once. Never rerun normal
before-hit, previously executed reactions or earlier waves. Released hostile damage receives
its normal after-damage opportunity once, with a distinct wave identity if joining a follow-up
wave; use existing activation/depth limits, not recursive unbounded reaction replay.

Later after-damage waves or newly lethal reaction costs before before-defeat also trigger it;
without current effects, probe an empty wave from current state. Opening HP0 is NOT provisional
HP0 computed IN a wave: only explicit revival restores opening-dead actors. Opening-alive actors
may survive via same-wave drain; already-paid lethal HP costs cannot be subsidized. Keep earlier
waves/costs, never retry the entire transaction. Charge all probe work; no second reaction runner.
No stop activates inside settlement, so at most one early release occurs per transaction.
Resolve all revivals before verdict: both HP0 is mutual-defeat; survivors before maxSteps resume
without bonus clock/pulse/observation progress.

### Time limit versus error termination

After the last committed interval, remaining stop/pending state gets ONE bounded release-only
transaction at global maxSteps. Use already advanced clocks for due expiry only, thaw, settle
all contacts/reactions/revival, then verdict. No new pulse, regeneration, decision, observation,
movement, spatial activation or interval. The last interval's lethal probe prevents delayed
flushing only after ordinary death was committed. A survivor can spend another guard on this
DISTINCT timeout-release wave, never twice on one wave. Add explicit release-only record/phase
ordering; global stamps never decrease and prior records are not overwritten.

Flush only before NORMAL victory/mutual-defeat/time-limit finality. Truncated/unresolved stop
immediately; cancellation/host failure are not combat outcomes. Never run extra combat beyond
budgets, turn an error into victory or discard pending state. Failed release rolls back its
entire transaction while earlier committed boundary/interval state and queue remain as bounded
partial replay/diagnostics. Terminal control reserve is for diagnostics, not attack settlement.

### Queue accounting

Release reduces occupancy, NEVER cumulative captures/operations: released200 plus new100
exceeds the256 match cap. Rejected hits incur work, not capture count. An operation is one
retained effect descriptor (including status application); derived reactions have their own
budgets. Preflight ALL simultaneous captures before commit. Canonical UTF-8 descriptor bytes
obey companion cap AND maxFrameBytes, plus actual record/transaction/cause/object/reaction
limits. Exact succeeds when other limits do not bind; +1 is atomic truncated with resource/
observed/limit/causes. Roll back queue/clocks/costs/HP/RNG/IDs/ledgers/records, not prior commits
or attempted work. Capture ADR0016 diagnostics before rollback; no dangling causes/dropped hits.
P6-10 still requires measured capacity/load validation.

## 4. Defeat and finite protection (P6-09b)

Strict defeat contact requires instant-death permission: HP0, not infinite damage/unrevivability.
Accept active opponent contacts only; reject startup/self/reactive/probabilistic/revival-blocking
variants even with flags. Bounded wound/status predicates use opening root-wave target state
(release state during stop), never same-wave new effects or live information exposed to AI.
Explicit defeat immunity is a status capability for starting innate or temporary resistance,
both permission-gated. Only effective opening immunity applies, not sealed/suppressed immunity.
Ordinary shield/defense/resistance/absorption cannot cancel defeat; whole-contact parry/barrier/
geometry can, damage-only parry cannot. Deflection keeps payload/launch snapshot and changes
owner/target. Coalesce requests/causes without ordering or RNG. Eligible unresisted defeat
beats ALL same-wave ordinary recovery, including incoming drain. Apply guard then existing
before-defeat/revival. Pure defeat generates no synthetic damage/absorption/drain/after-damage.

Immortality permission admits a nonstacking finite status. Count C is per MATCH, not per grant;
remaining=max(0,C-spent), duration/count bounded in the companion. C=1 stays exhausted after use,
even on regrant; C=4 cannot protect a fifth time. Refresh/expiry/dispel/seal/revival/new cohorts reset
neither C nor spent; exhaustion disables protection, not truncated. Reject conflicting immortal
revisions per recipient closure, including opposing/dormant grants/transforms/equipment,
before reservation; never select one by ID/order.

Consume one charge per target per EFFECT-SETTLEMENT WAVE: one simultaneous allocation batch,
not one attack/component or whole transaction. Later reaction/timeout batches are new waves;
probes are not. Effective opening protection changes otherwise-lethal HP to1 for living targets.
No consumption for nonlethal/resisted/cancelled attempts or resurrection of opening HP0.
Same-wave grants are not retroactive; expiry precedes opening sampling, seal uses normal status
commit timing. Protection cannot pay HP costs, defeat input errors/time limits, rewrite error
outcomes or refill revival uses. Revival remains one ability/loadout including equipment,
max four uses/actor/match, grouped eligibility/payment and explicit reset after ordinary waves.
HP1 consumes no revival. Existing non-restorative reaction restrictions remain.

### Unique guard/drain allocation

Freeze h=opening HP, R=adjusted ordinary/absorption healing EXCLUDING drains, D=post-shield
numeric damage, attribution/recovery multipliers, K=eligible unresisted defeat and E=living
actors with effective remaining guard. Dead-at-opening actors receive no ordinary recovery.
Start S empty and calculate every actor from the SAME S:

```text
A_i = h_i + R_i
f_i(S) = 1 if i belongs to S, otherwise 0
B_i(S) = min(D_i, max(0, A_i - f_i(S)))
L_i(S) = 0 if h_i=0; otherwise drain healing from B(S) credited to source i
U_i(S) = A_i - D_i + L_i(S)
S_next = S union {i in E | K_i or U_i(S) <= 0}
```

Opening-dead sources have R=B=L=0 until explicit revival. Exclude their drain credits BEFORE
summing L in every probe/final allocation, not just at the final HP clamp. Keep accepted damage
and target attribution; never redistribute skipped credits or backfill them on later revival.
Opening-alive sources remain eligible even if U<=0 or K sets final HP0 (N10 versus N12).
Allocate B exactly and proportionally over NUMERIC post-shield contributions only; use the
existing rational allocator, recovery multipliers and one floor per drain contribution.
Defeat's non-damage HP removal never increases B; returned/disabled/periodic/environment/cost
drains remain disabled.
L never feeds B. Add all newly required guards together until S_next=S. Then guarded HP=1,
unguarded K gives0, otherwise clamp U once to [0,maxHP]. Only now commit HP/shield/drain and one
charge per selected actor. The probe emits/consumes nothing.

Adding guards only decreases B/L: lethal requirements persist. Starting empty selects the
LEAST fixed point in at most two growth rounds/three allocations, including stability.
No actor-order choice, epsilon or unbounded convergence; for living openings E empty retains
legacy drain arithmetic.
N1 requires HP1/zero charges; N2 needs two rounds. Independently test rational rounding/swaps.

## 5. Aim, evasion and reading (P6-11)

Experimental `accuracy: no-error` removes angular error, preserving two PRNG draws and delivered
aim/range/geometry/occlusion. Effective finite `evasion` cancels a whole hostile contact after
before-hit payment; category AND element filters apply. Self/environment/periodic effects are
unaffected. Thus evasion cancels no-error hits; seal suppresses it normally.

`reveal` adds HP-ratio buckets and declared-action ID/phase through active opponent zero-radius
sight rays. Respect visibility/ward, precision/delay/duration; never expose future decisions/RNG.
Freeze preserves the sampled payload and observer delay/expiry. Capture visibility is retained,
not rechecked through later geometry; release outcomes get new stamps. AI uses delivered data.
See companion `perceptionConcepts` for bounds.

## 6. Implementation and acceptance

Internal scalar timers cache global projections, rebased once on thaw; bound subject deadlines
stay constant and original global stamps are retained. Required replay features are
`subject-clocks-v1`/`deferred-contacts-v1`. Checkpoints retain control counts and pending causal
receipts after consumed shots. Validate identities/clocks/exactly-once release engine-free;
normal finality has no pending control, errors retain committed partial state.

Queue bytes count canonical UTF-8 interned contact templates, payloads and ordinal pairs,
including released entries. Structural record maximum12,003 covers initial +6,000 intervals
+6,000 boundaries +one timeout release +terminal; match/work/byte limits remain unchanged.

ADR0010 classification: additive, spatial-v1.22 unchanged. No-concept clocks/control fields are
absent; preserve published definitions and seven fixed corpus expectations. New experimental
rules/seven characters use new IDs; explicitly review implementation restamping and saved reads.
Companion C1–C13/D1–D6/I1–I5/X1–X6 remain mandatory, not satisfied by arithmetic alone.
Executed corpus/pair bindings, Worker/SQLite/viewer seek/loop, quality/verify, clean-source,
review and Linux PR/main CI govern acceptance. Preserve Markdown170000 and published hashes.

By the owner's order, complete all skills before official milestone dry-run/compute/publication;
keep the same20 participants. Experimental rankings/manual execution stay separate; their actual
publication is optional. Do not close #155 while acceptance or official milestones remain.
