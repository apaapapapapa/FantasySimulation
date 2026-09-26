# ADR 0017: P6 spatial mechanics

**Owner-approved 2026-09-26.** Refs #155 §7/Q-9/Q-10, #1, #61, #45, #10.
[Full accepted contract](https://github.com/apaapapapapa/FantasySimulation/blob/39c769091133dc94907f7090dead65d052e3d383/docs/adr/0017-p6-spatial-mechanics.md)
remains authoritative for ALL predicates, limits, timing and fixtures. Read it for
implementation; this navigation summary changes no rule/approval/acceptance requirement.
P6-05: #182 head fa1b7850b5aabed2ea12d18cc949be012943110e; implementation: #196.
Official Group2 publication is separate, not implied complete. [ADR0016](0016-p6-foundation.md)
owns admission/diagnostics/publication. [Stages](../rules/stages-motion.md) and
[reactions](../rules/reactions.md) retain ownership; [ADR0018](0018-p6-concept-clocks.md)
is an unapproved proposal, not an amendment yet.

## Scope and decisions

Standard teleport/barrier/area/beam/phasing, exactly two actors. Objects have no minds,
actor RNG or victory eligibility. Unimplemented variants remain rejected.

## One coordinator and an atomic world

StepTransaction validates/journals a full candidate world before atomic swap; rollback
preserves attempted-work accounting. Shared snapshots/query contexts/meters; ordering
never chooses winners. Preserve the full contract's boundary/activation/terminal order.

## Teleport contract (P6-06)

Frozen self/delivered-visible-enemy offset, release n -> n+1, whole-body solid endpoints.
All conflicting proposals fail; no occupied-start swaps/fallback. Preserve forces/clocks,
detached objects and ledgers; no connecting movement/attack trace or knowledge leak.

## Objects, barriers and contact resolution (P6-07)

Finite geometry/durability/lifetime, owner-aware layers, shared blocker/tie/blast rules.
Conflicting followers hold; no pushing. Aggregate durability, remove next boundary.
No same-interval passthrough or actor reactions on objects.

### Persistent areas and beams

Shared finite pulse/stage/visibility/hit/separation ledgers. Preserve exact attached versus
detached interruption rules, clipped traces and costs; no refresh reset/reflection.

## Phasing and safe exit (P6-08)

Independent material/floor body/attack masks; arena remains solid. Embedded expiry/seal
retains ONLY collision safety. No refresh reset: retry after50 extended intervals still
embedded -> truncated phase-exit-steps (51/50), not ejection/defeat/draw.

## Bounded work, interference and records

Defaults64 objects/64 commands, allowed1..256. Existing budgets and atomic rollback,
ordered/self/conditional matrix, bounded records/hashes, old reads and AI privacy remain.

## Delivery ownership and acceptance

One shared integration owner. ALL T1-3/B1-4/A1-2/P1-2/X1-3 fixtures in the full contract
remain required, including bounds, symmetry, Worker/SQLite/viewers and old compatibility.
ADR0010/0013 version/identity, corpus/load, quality/verify/clean-source, review and Linux
PR/main CI remain gates. Official same20-participant milestone follows ADR0016. #155 stays open.
