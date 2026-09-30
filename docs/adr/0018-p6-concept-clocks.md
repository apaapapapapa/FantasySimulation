# ADR 0018: P6 concept clocks and finite defeat protection

**Accepted for implementation by the owner's 2026-09-27 request to implement all
remaining skills before completing #155.** Refs #155, #1; baseline `39c7690`.
The [full accepted contract](https://github.com/apaapapapapa/FantasySimulation/blob/a9c45d65ddf673aa3683b6882620b8db1d23decd/docs/adr/0018-p6-concept-clocks.md)
remains authoritative for every predicate, limit, formula, boundary order and
fixture. This summary does not amend it. The independently authored
[cases](0018-p6-concept-cases.json), [ADR0016](0016-p6-foundation.md),
[ADR0017](0017-p6-spatial-mechanics.md) and [reactions](../rules/reactions.md)
remain required.

## Accepted contract

- One 20ms coordinator remains authoritative. Global time and bounded work never
  pause. Motion, cognition, action, status/resource and projectile clocks pause
  only under their specified owner freeze mask. Boundary-latched masks advance
  each subject zero or one tick; there is no catch-up or second scheduler.
- Frozen bodies remain colliders. Attached emissions pause while fixed detached
  objects keep their global lifetime. Projectile time follows its current owner.
  Hit ledgers, separation latches and original global stamps are never rebased.
  Phasing exit remains global and can truncate before thaw.
- Saved display binds clock domains, remaining steps, projections and provenance.
  Readers restore records and never infer expiry. Effective clock/queue/latch
  state is hashed; no-concept records and fixed corpus results stay unchanged.
- P6-10 admits one fixed-mask, opponent-targeted, action-triggered stop. Requests
  activate from the shared post-spatial snapshot. Opposing valid simultaneous
  requests both fizzle; invalid requests cannot cancel a valid one. Duration is
  fully reserved, no early-release refund. Stop immunity is finite, permissioned,
  opening-state capability; ordinary seal can suppress it.
- Boundary order remains expiry/resource and contacts/reactions, verdict,
  phasing/followers/placements/teleports, stop activation, atomic publish, then
  observation/decision. Pending commands from a frozen source fizzle. Release
  precedes re-stop and maxSteps activates nothing.
- Hostile contacts during stop consume their hit/projectile lifecycle and retain
  a bounded immutable effect descriptor. Release settles all pending contacts in
  one root wave from captured geometry and the current opening defense state.
  Lethal allocation is probed without mutation, releases before death commits,
  then recomputes that wave once. Costs, reactions and RNG are never replayed.
- Normal victory, mutual defeat and time limit flush once; errors do not. The
  timeout release is release-only. Queue occupancy can fall, but cumulative
  capture/operation/byte/work limits never do. Overflow atomically rolls back the
  current transaction and keeps bounded diagnostics.
- P6-09b instant defeat means permissioned HP0, not infinite damage. It is active
  opponent contact only and respects whole-contact cancellation, explicit defeat
  immunity, finite guard and the existing before-defeat/revival pipeline. Finite
  immortality is nonstacking, per-match and consumed at most once per recipient
  per effect-settlement wave; regrant, refresh, seal and revival do not reset it.
- Guard/drain uses the full contract's least-fixed-point allocation from one
  opening snapshot. Adding guards can only reduce accepted damage/drain; selection
  stabilizes in the bounded rounds specified there. No actor ordering or epsilon
  chooses a winner.
- P6-11 no-error aim preserves RNG draws. Evasion cancels an eligible whole
  hostile contact after before-hit payment. Reveal is delayed, bounded subjective
  HP/action information and never exposes future decisions or RNG.

## Compatibility and acceptance

Required replay features are `subject-clocks-v1` and `deferred-contacts-v1`.
Internal deadlines stay subject-bound while legacy global projections are display
hints only. Checkpoints retain controls, pending receipts and exactly-once state.
The structural record maximum is 12,003; all existing byte, work and artifact
limits remain.

ADR0010 classification is additive at `spatial-v1.22`. Published definitions and
seven fixed corpus expectations are preserved; new experimental rules and seven
characters use new IDs. All C1-C13/D1-D6/I1-I5/X1-X6 cases, corpus bindings,
Worker/SQLite/viewer seek-loop tests, clean-source evidence, review and Linux
PR/main CI remain mandatory. Complete all skills before the official same-20
milestone; experimental rankings remain separate and #155 stays open until its
acceptance and milestones are complete.
