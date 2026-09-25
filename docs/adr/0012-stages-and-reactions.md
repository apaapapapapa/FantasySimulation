# ADR 0012: Stages, motion and reactions

Status: design approved in [PR #86](https://github.com/apaapapapapa/FantasySimulation/pull/86#issuecomment-5792777109).
Refs #61 G-06/§2-E,F, #45, #59, #1 P6.
[Design history](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0012-stages-and-reactions.md)
retains implementation order and tabletop examples. Later #45/#59/#61 decisions prevail.

## Implemented contracts

One 20ms clock, stage/shared ledger and bounded transactional waves compose existing
category/damage/status/resource/geometry/view rules. No duplicate loops, recursive
callbacks, contact-order HP, character scripts or future prepayment. Interrupt at
boundaries; finer timing needs versioning.

[Stage/motion rules](../rules/stages-motion.md) own G-07 clocks, costs, interruption,
shapes, forces, movement and simultaneous resource selection. G-08's
[reaction rules](../rules/reactions.md) own before-hit/after-damage/before-defeat,
grouped current-resource payment, old-cohort status union, shared shield/clamp,
whole/damage parry and paid deferred counters. They own the executable acceptance
matrix, atomicity, delayed visible observations and saved clocks/queues/geometry.
Replay validation does not execute the engine.

Reaction limits remain 64/transaction, 1024/match, depth 8 with cross-interval
ancestry and complete rollback; existing geometry/record limits remain.
Future emitter/beam/area/teleport extensions remain rejected until their own
acceptance work. Existing crouch/prone postures follow [tactical AI](../rules/tactical-ai.md).
Reflection/absorption/revival and P4/P5 remain separate.

## P6 design hooks (not implemented here)

- Absorption diverts post-modifier/pre-shield damage into same-wave healing; that
  portion cannot drain shields or reflect. Competing absorbers need a fraction rule.
- Reflection uses hostile post-defense/resistance/shield damage, before remaining-HP
  clipping or simultaneous healing. Exclude costs, environmental/nonhostile damage
  and reflections. Attribute components rationally; floor once per owner/source/
  component after reflection Bps, without new attack scaling/dealt bonus. Recipient
  defense/resistance/shield apply; preserve causes at HP0. Reflections may be defended
  but never reflected again.
- Same-wave healing precedes before-defeat. Revival restores explicitly, never via
  ordinary heal/counter recursion. Gather all HP0 owners and reserve all-or-none per
  owner. Use finite uses/explicit competition rules; cap revival at 4/actor/match.
  Undefined revival/annihilation or competing replacements remain unresolved.

For example, HP10/shield5 taking30/healing8 gives reflection basis25 and HP0;
50% reflection deals12, with no re-reflection. Revival to7 can then decide victory.
The 65th eligible reaction under cap64 rolls back all costs/PRNG/hits; undefined
parry-versus-pierce stays unresolved, never silently omits a reaction to award a win.

## Compatibility and delivery

[ADR 0010](0010-battle-version-compatibility.md) owns additive schemas, published
identity preservation, versioned mechanics, reviewed digest/corpus inputs and old
readers/execution rejection. No historical engine or DB conversion. #61 §2-I,
independent fixtures, replay/Worker round trips, Linux verify/clean-source,
latest-head review and main CI apply. Preserve one owner for coordinator/domain/log
changes and reuse existing adapters. Design approval above is distinct from
implementation delivery; PRs record head/reviewer/findings, and self-review is not approval.
