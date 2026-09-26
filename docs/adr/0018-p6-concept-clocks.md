# ADR 0018: P6 concept clocks and finite defeat protection

**Proposed; owner approval required before Group3 implementation.** Refs #155 §8/P6-09, #1.
Baseline `39c769091133dc94907f7090dead65d052e3d383` (#204, after #196). Design only:
no runtime/schema/catalog/identity/publication change. Approval, implementation and verified
delivery remain; P6-09 is NOT complete. P6-10 implements stop later; P6-11 is separate.
[ADR0016](0016-p6-foundation.md), [ADR0017](0017-p6-spatial-mechanics.md) and
[reactions](../rules/reactions.md) still govern existing mechanics. This is an experimental
extension proposal, not retroactive standard rules or a waiver of tests/review/publication.

## 1. Clock ownership

Keep the existing 20ms `simulate.ts` boundary/interval coordinator and StepTransaction.
`step` is monotonically increasing simulation time, never host wall time; the ruleset's
maxSteps (6000/120s for the current full duel) is never paused or increased by an ability.
Budget/cast/reaction/event counters also never pause. Do not add a second scheduler.

Use integer subject clocks/deadlines; compare only within their domain, without per-tick
rewriting. No-stop progression remains identical; thaw never produces catch-up bursts.

| Domain | Owner and covered progress | Proposed first time-stop profile |
| --- | --- | --- |
| Global | Match bound, record step/sequence, stop expiry, detached spatial-object lifetime/pulses, work limits | Always advances |
| Motion | Actor translation/velocity integration/gravity/forces, posture/dodge movement | Frozen target: delta=0; preserve state, do not accumulate skipped gravity |
| Cognition | Actor perception sampling/delivery delay, decision readiness, knowledge ageing | Frozen target neither samples nor delivers nor decides |
| Action | Actor cast/stage/recovery/cooldown, reaction readiness and paid counter release | Frozen target does not advance or emit |
| Status/resource | Target's status lifetime/pulses, regeneration and status-resource updates | Frozen target does not expire, pulse or regenerate |
| Projectile | Detached projectile movement/lifetime/homing update, controlled by current projectile owner | Frozen owner's projectiles do not advance or collide |

P6-10 first admits this fixed profile, not arbitrary user-authored masks. Current owner after
deflection determines projectile freezing; original launch power/provenance is unchanged.
Contacted/deferred projectiles stay consumed; thaw cannot hit a second time or reset ledgers.
Frozen actors keep their capsule as collision geometry. Other actors and unfrozen shots can
contact it. Actor-attached melee/beams do not emit while their owner's action/motion is frozen.
Fixed barriers/areas are detached: their global lifetime, blocking and scheduled pulses continue,
even when the owner is frozen. Following barriers hold pose and attached attack emission pauses;
barrier lifetime remains global. This distinction must be tested, not inferred from ownership.
Phasing exit protection's finite safety counter uses global executed intervals, never a frozen
status clock: stop cannot extend the existing50-interval bound. No extra exit work at termination.

Seal alone still suppresses effects without pausing expiry/pulse origin. If time-stop also
freezes status/resource time, that pause belongs to time-stop, not seal. Dispel/refresh/transform
retain existing cohort semantics; no retroactive missed pulses. Immortality duration uses the
status domain, with the match and cumulative stop bounds still providing a finite global end.
Time-stop's control lifetime is global and cannot freeze itself. Its resistance/control is
explicitly typed, not an ordinary status accidentally governed by its target's frozen clock.

Queued observations retain their sampled payload and remaining subjective delay; thaw never
replaces them with live enemy state or delivers skipped samples. Other actors observe through
their ordinary delays. Decision-state hashes include all clocks/deadlines/freeze provenance;
record timestamps remain global. Old input/record omission means no freeze/new clock payload.

## 2. Stop activation and settlement contract (for P6-10)

A paid stop released in interval n requests activation at boundary n+1. Recheck source
eligibility and target stop resistance from the shared activation snapshot. Invalid requests
fizzle without refund. If both opposing requests remain eligible, BOTH fizzle; actor IDs,
array order, speed or random streams never break this tie. A resisted request cannot cancel
an otherwise valid opposing request. No nested/reapplied stop, additive duration or refresh:
requests targeting an already frozen actor fizzle and cannot reset any counter.

Proposed semantic bounds: duration1..100 global intervals (<=2s), at most4 successful stop
activations and300 frozen-target intervals per match (<=6s total for this 1v1 profile).
Admission rejects an out-of-range authored duration. Exhausted semantic allowance fizzles
with a reason before activation, never truncates a requested duration. These are proposed
rules, not measured performance claims. Work limits are separate and overflow as truncated.
The last interval cannot activate a new stop; retain the existing battle-ended command rule.

### Contact capture and one release wave

During freeze, ordinary geometry establishes contact at its actual global step. Consume the
ordinary per-target hit ledger at contact. Defer the complete accepted hostile contact payload
(damage, defeat, status/force/elemental effects), not just a sum of damage. Store bounded launch
snapshot, effect ordinal, target, contact step, rule/revisions and valid cause references.
Target before-hit reactions are unavailable: no parry/deflection is executed then or replayed
retroactively on thaw. Already committed before-hit protection from earlier waves is ordinary
state. Source costs/uses were already paid and are not paid/refunded again at settlement.

On release, combine all pending contacts for all released targets into ONE simultaneous root
wave. Damage power uses each original launch snapshot; shields, defense, resistance, absorption,
instant-death predicates/resistance and immortality use the release wave's opening state.
The target does not dodge old contact because its pose later changes. Release contacts reuse
shared damage allocation/shields/drain/reaction machinery; no per-contact HP clamp. After-damage
and before-defeat/revival operate normally, including both actors' simultaneous defeat.
New status applications begin at the existing commit/activation boundary, not the old contact
time. Force starts at release; it does not retroactively integrate over the frozen duration.
Newly applied protection/cleanse/seals cannot rewrite another contact in that same wave.

At a normal boundary: remove expired global objects; end due stop controls; expire statuses
according to their subject clocks; collect existing due resource/periodic effects and thawed
contacts; settle through the existing boundary reaction transaction; then verdict/spatial
commands/observations as before. Defenses sample after due expiry, before that root wave.
Advancing/thawing a clock never adds a bonus tick. A same-boundary stop activates only after
that settlement, so it cannot recapture the batch being released.

Before ANY terminal verdict, pending contacts must be flushed together, even when the stopper
has just lost HP or control and the nominal stop deadline has not arrived. Resolve the normal
wave/revival first; when termination would otherwise follow, perform a same-global-time
release-only settlement and reconsider the verdict. A released victim may revive or kill the
other actor; both HP0 after permitted revivals means mutual-defeat. No invisible queue can
prolong a finished duel or be discarded to award victory. End all stop controls on this flush;
if both survive before maxSteps, ordinary simulation resumes without a bonus clock advance.

At maxSteps use a release-only terminal transaction after the last committed interval: thaw,
apply due expiry only for release-state sampling, flush the entire queue, resolve reactions/
revival, then decide defeat or normal time-limit outcome. Do NOT run another boundary pulse,
regeneration, AI decision, spatial activation, movement or new interval. Global event steps
never decrease. Distinguish a release-only record/phase from an ordinary boundary for readers.

### Bounded pending state

Propose hard limits256 pending contacts/match and4096 deferred payload operations/match;
count all simultaneous incoming contacts before committing any. Also enforce existing record/
transaction byte, cause, event, object and reaction budgets; no unbounded copied definitions.
Exact limit succeeds, +1 fails atomically as truncated with resource/observed/limit/causes.
Overflow rolls back the entire attempted transaction's clocks, queues, costs, HP, RNG, IDs,
ledgers and records; attempted work and previously committed transactions remain. Capture
ADR0016 diagnostics before rollback, without dangling references or silently missing attacks.
P6-10 must verify these limits against corpus/load/record gates; changes need explicit review.

## 3. Instant death (P6-09 implementation after approval)

Add a strict `defeat` contact effect, permission `instant-death`. It requests HP0, not a new
unrevivable defeat state and not infinite damage. First increment supports active opponent
contacts only; reject startup/self/reactive defeat and probability/revival-blocking options.
Optional target prerequisites are bounded wound-stage/status predicates, evaluated from one
root-wave opening target snapshot. A wound or status created by that wave cannot satisfy its
own prerequisite. These engine predicates are not new live information available to AI.
During stop their evaluation belongs to the release wave, not the historical contact step.

Explicit innate resistance is represented by a passive starting status with defeat immunity;
temporary status immunity uses the same capability. Both require instant-death permission.
The target's effective opening capabilities decide resistance; sealed/suppressed immunity
has no effect. Ordinary defense/resistance/shields/absorption do not cancel defeat. Geometry,
barriers and whole-contact parry can stop the contact; damage-only parry cannot remove defeat.
Deflection changes the eventual target/ownership while preserving the payload/launch snapshot.
No probability draw is added. Names alone never imply immunity, immortality or bypass.

After the ordinary incoming damage/heal/absorption totals, any eligible unresisted defeat
request fixes provisional HP at0: same-wave healing cannot undo it. Coalesce multiple requests
per target, preserving bounded causes rather than choosing one by ordering. Resolve finite
immortality protection below before before-defeat; then reuse the existing grouped revival
eligibility/payment/reset. Revival remains max4/actor/match, one ability/loadout including
equipment; defeated actors cannot be resurrected by ordinary heals or a recursive counter.
The last allowed interval follows this same rule. Pure defeat creates no synthetic damage
for after-damage, absorption or drain. Existing positive post-shield damage can still trigger
its normal after-damage reaction even when final HP loss is clipped/protected.

For mixed numeric damage+defeat, retain numeric attribution separately. Drainable HP loss
cannot exceed what the numeric components would cause under the same HP floor and existing
healing/allocation rules; the remaining non-damage HP removal grants no drain/absorption.
Use the existing exact allocator with the final floor, not a fake HP restoration that would
inflate drain. Chain waves complete before ordinary before-defeat/revival/verdict, as today.

## 4. Finite immortality and explicit interference

Permission `immortality` admits a nonstacking status capability with a finite positive duration
(1..6000 status steps) and protection count1..4. It is not universal victory or an immunity
to contact: an eligible living target whose combat settlement would reach HP0 instead reaches
HP1. One protection is consumed per target/root wave, not per attack, damage component or
cause. It covers numeric lethal damage and eligible defeat in that same wave. No consumption
on a nonlethal/resisted/cancelled attempt. No raising HP0 back to1 after an earlier defeat.

At most one distinct immortality status revision is admitted in a loadout's resolved closure;
reject conflicting variants, including dormant grants/equipment. Existing same-status cohort
rules apply. Maintain one cumulative per-actor protection ledger for the whole match, capped4;
refresh, regrant, expiry, dispel, seal, revival or new cohort IDs cannot refill it. Per-grant
count can restrict remaining protection further, never restore consumed allowance. Exhaustion
removes protection normally, not truncated. It cannot subsidize unaffordable HP costs, prevent
input errors, rewrite truncated/unresolved, defeat the time limit or reset revival uses.

Expired/dispelled/sealed protection does not apply. Due expiry is processed before opening
wave sampling. Same-wave new protection does not rescue that wave; existing protection remains
eligible until the usual status commit. Seal has its existing next-boundary effect. Restoration
after unsealing retains duration and spent counts. Freeze pauses duration only as specified
in §1, never lifetime/cumulative work limits. Emit protection use before any final verdict;
revival activates only if HP is still0 after protection, never spends a use on HP1.

Put rules in domain `interference.json` with independent executed fixtures for EVERY accepted
ordered/self/conditional pair. This proposal is not coverage; reserved cells stay unimplemented:

| Interaction | Proposed rule |
| --- | --- |
| defeat / finite immortality | Eligible opening protection floors HP1 and consumes once; otherwise HP0 |
| defeat / revive | HP0 enters ordinary before-defeat, with grouped finite payment; no revival bypass |
| defeat / heal, absorb, drain | Defeat survives same-wave healing; no synthetic damage/recovery/drain |
| defeat / parry, deflect, barrier | Whole contact cancellation/interception wins; damage-only does not; deflected defeat returns |
| immortality / damage, status damage | Same final floor and finite ledger, not a heal; preserve real damage triggers |
| immortality / seal, dispel, expiry | Opening effective state and next-boundary status rules; spent counts never reset |
| concept / time-stop | Contact capture then release snapshot, one wave and no retroactive before-hit |

Undefined experimental collisions need ADR0016 unresolved fixtures, never implicit precedence.
Unimplemented variants remain rejected even with permission: P6-09 enables neither time-stop
nor probabilistic/unrevivable defeat.

## 5. Integration, compatibility and observability

Extend owning strict unions/exhaustive switches, not a parallel resolver/resource scheduler.
Use prepare/job/retry/league admission on the full resolved ability/status/equipment closure,
including dormant branches/transforms, BEFORE reservations. Missing permission identifies
mechanic/revision; standard rules cannot discard concept fields. New experimental rules/sample
IDs and separate rankings/catalogs/Pages labels are mandatory. Preserve all140 published
definitions/stored results. No official recalculation, R2 write or publication in this task.

Definition-driven AI uses own costs/uses and delivered public wounds/statuses/activation cues;
unknown immunity/counts remain uncertainty. No ability-ID switches, unused enemy definitions,
live/pending observations or replay truth. Preserve bounded decision/knowledge provenance.

Add domain StreamRecord/ReplayState defeat eligibility/resistance, guard-use/revival causes;
P6-10 adds stop reason/domains, bounded pending count/contents and atomic release. Hash all
clocks/counters/queues. Validate references/global time/finite counts engine-free. Worker/SQLite
and checkpoints must round-trip; forward/reverse/loop seeks never rerun combat or apply queued
HP early. Both viewers render or explicitly reject unsupported records; cognition stays separate.

ADR0010/0013 govern implementation version/identity review: changed judgement needs a new rules
version and ruleset IDs. Preserve old readability, not old execution. Independently review fixed
corpus/standard no-concept digests; never derive expectations or automatic restamps from failures.

## 6. Acceptance plan and delivery boundary

The following are REQUIRED future tests, not a report of executed or passing tests:

| ID | Independently expected behavior |
| --- | --- |
| C1 | No-stop domain progression equals legacy; ID/slot/position/RNG permutations do not choose winners |
| C2 | Frozen motion/action/status/projectile/cognition stay fixed; world time/object pulses advance; no catch-up |
| C3 | Seal alone ages statuses; seal+freeze pauses only status time; global expiry and phase-exit cap terminate |
| C4 | Simultaneous valid stops both fizzle; resistance removes only its request; nesting/refresh cannot extend |
| C5 | All queued contacts use launch power and one release-state defense snapshot; shield shared once |
| C6 | Stop before-hit unavailable; normal after-damage/revival works on release; causes/ledgers never replay |
| C7 | Timeout and early terminal flush release all targets; mutual defeat/revival resolved before verdict; no extra pulse |
| D1 | Pure defeat ignores shield/ordinary resistance; explicit effective immunity prevents it, no damage/drain |
| D2 | Starting HP10, numeric damage3+defeat+heal5 => HP0 absent guard; pure defeat+revive7 => HP7 |
| D3 | Starting HP10, damage20+defeat with guard => HP1, one charge, no revive, at most9 drainable HP |
| D4 | Same-opening wound/status predicates; new same-wave wound cannot qualify; returned defeat hits original source |
| I1 | Two simultaneous lethal contacts consume one protection; next lethal wave consumes next; fifth cannot protect |
| I2 | Expiry/refresh/dispel/regrant/seal/revival cannot reset spent counts; new same-wave guard is not retroactive |
| X1 | Missing flags/dormant unsupported variants/conflicting immortal revisions rejected before job/league reservation |
| X2 | Every accepted ordered matrix cell has an independent executed fixture; missing-cell/fixture negative controls |
| X3 | Pending contact256/257, operations4096/4097 and byte/reaction budgets: exact succeeds, +1 atomic truncated |
| X4 | Repeat all hashes; rollback clocks/IDs/RNG/resources/queue/world; saved old/new data, Worker/SQLite, both viewers |
| X5 | Delayed AI privacy, pending display versus cognition, forward/reverse/loop seek and partial record rejection |

P6-09a stays Proposed until owner approval. P6-09b delivers defeat/immortality end-to-end
(admission, resolution, AI, records/viewers, matrix and C1/D1-4/I1-2/X1-2/X4-5 tests).
No unused clock state changing standard hashes. P6-10 adds C2-7/X3 and all cross-cases;
one owner integrates shared schema/settlement/identity. P6-11 remains separate.
Quality/verify, clean-source, reviewed corpus/load, PR review and Linux PR/main CI remain
required. Compaction preserves pinned ADR0017; Markdown170000 stays fixed. Refs #155/#1,
no auto-close/completion declaration while P6 acceptance or official milestones remain.
