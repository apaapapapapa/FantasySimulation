# ADR 0014: Explicit duel scope

Status: accepted for Issue #106 D-3/R-09; dependent-entity amendment accepted by
delegated technical decision for Issue #228, 2026-09-30.

The product supports exactly two opposing participants. `DuelPair`, streams 0/1,
participant A/B controls, victory and first-participant camera keep that meaning.
Reject missing, duplicate or extra participants; never choose an arbitrary enemy.
The prior lookup identity transition remains recorded in its implementation artifact.

## Dependent-entity amendment

[ADR 0021](0021-dependent-summons.md) owns the accepted contract. Two participants
remain; teams and free-for-all are excluded.
