# ADR 0015: Immutable leagues

Refs #134, #1. Additive tooling; the battle engine and actor-stream-v1 are unchanged.
The user selected daily differential publication plus manual dispatch (2026-09-25).
Only the same successful main-CI SHA may run; calculation has no production keys.

League definitions pin revision closure, exact rational weights, two placements,
trial count/master seed, scoring version and initial/retry budgets. Unknown fields,
duplicate character/scenario IDs, unsupported rules and invalid hashes fail before
execution. Up to 64,000 slots; partition into existing <=1,000-slot batch plans.

Normalize character/scenario/revision ordering and rational weights. inputHash binds
the definition and engine/digest; leagueHash additionally binds execution source SHA.
An unchanged input with completed work needs no new publication for a docs-only commit.
Never replace a published definition; result snapshots retain the original slot denominator.

league-trial-v1 uses the first 32 bits of SHA-256 of canonical JSON containing
version, masterSeed, zero-based trial and purpose=battle. No pair, scenario, league,
execution order or time enters the seed. Character ID order assigns streams 0/1;
placement swaps participant slots/starts/facing while each actor retains its stream.
Slot hashes bind character revisions, scenario, starts, placement and trial, excluding
league identity. Adding a participant preserves all unrelated manifests.

Publication retains existing capacity limits pending measured review. Execution,
publication and UI remain follow-up work under #134.
