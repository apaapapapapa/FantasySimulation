# ADR 0012: Stages, motion and reactions

Approved in [PR #86](https://github.com/apaapapapapa/FantasySimulation/pull/86#issuecomment-5792777109).
Refs #61 G-06, #45, #59, #1 P6. [Original design/examples](https://github.com/apaapapapapa/FantasySimulation/blob/6ea13284e6c7845c7badef202054a951be7144b6/docs/adr/0012-stages-and-reactions.md).
Later #45/#59/#61/#155 decisions prevail.

## Implemented contracts

[Stage/motion rules](../rules/stages-motion.md) own G-07; [reaction rules](../rules/reactions.md)
own G-08. One 20ms coordinator, shared ledger, bounded atomic waves, grouped current-resource
payment, old-cohort union, shared shield/clamp and delayed visible observations. No duplicate
loops/recursive callbacks/contact-order HP/character scripts/future prepayment. Boundary
interruption; finer timing needs versioning. Caps 64/transaction, 1024/match, depth8 include
cross-interval ancestry; overflow rolls back fully. Existing geometry/record caps remain.
Replay validates saved display without engine. Future shapes/P6 require their own acceptance.

## P6 hooks (unimplemented)

[Issue #155](https://github.com/apaapapapapa/FantasySimulation/issues/155), owner decision
2026-09-26, withdraws numeric damage reflection and its example. Reflection means before-hit
projectile deflection only: aim at delayed observed attacker or reverse incoming direction;
transfer ownership, preserve launch power/speed/gravity/lifetime, no homing, resume next
interval. No explosion there/re-deflection; exclude melee/hitscan/explosions/periodic damage.
Absorption converts post-modifier/pre-shield damage to same-wave healing, total <=100%.
Drain uses actual HP lost; explicit revival follows healing/all waves, finite <=4/actor/match.
Reaction caps/rollback apply. [ADR0016](0016-p6-foundation.md) proposes the foundation;
its approval is pending. Implementation follows #155 §2-C and the delivery skill; original
design approval is not implementation approval. Preserve coordinator/domain/log ownership.
