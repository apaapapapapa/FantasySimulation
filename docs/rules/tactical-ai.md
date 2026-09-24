# Tactical AI (Issue #45, spatial-v1.19)

**User approved these values and GitHub delivery in ChatGPT on 2026-09-24.**
standard-tactics-v1 enables this; standard-evaluation-v1 keeps omitted options neutral.

| Approved values                                                     | Fixture                  |
| ------------------------------------------------------------------- | ------------------------ |
| Wait cap 10s; aggression 0/5000/10000 waits 10/5/0s, including hold | search.test.ts           |
| 5×5 cells, low sight 100mm, revisit 10s, goal timeout 3s            | search.test.ts           |
| Crouch radius/height 300/1000mm, speed 50%, transition 200ms        | posture.test.ts          |
| Prone upright capsule 300/600mm, speed 20%, transition 400ms        | posture.test.ts          |
| Drop weights below 5% of original maximum; retain equality          | candidate-cutoff.test.ts |
| Impact thresholds 25%/75%/125% of own known power                   | relative-impact.test.ts  |

Preserve attack81/cleanse659. Defaults: risk/resource10000, search5000.
Search follows delayed sight/direction (3m hypothesis), then age/distance-weighted cells.
Centre plus four inset corners need low support-level sight. Observed terrain uses
measured patches/local movement <=0.75m. Cover uses known terrain/estimated opponents,
stays within bounds and yields to search at the cap. Separate search/cover streams:
xor 0xa4093822/0x299f31d0. All draws share the floor; sole choices draw nothing.

Stance changes preserve feet, check headroom/body and commit at a recorded boundary.
Crouch: walk/jump/all skills; prone: crawl/ranged/magic, no melee/jump/run/authored motion.
All release paths share constraints. Up-evasion checks jump physics/cost/timing/ceiling.
Relative impacts expose only bands;
shield/partial contacts stay unknown. Legacy logs remain readable. Reapplication uses
own same-status intervals, then visible same-element intervals; absent evidence means
no discount. Cleanse benefit ends at predicted reapplication. Memory caps:32 threats,
8 cues,25 cells. Cognition records these decisions/evidence.

Compatibility: preserve 85 revisions/18 characters; add two posture characters/policies,
two scenarios/two rules. Seven corpus inputs change version/rules only; add tactical
oracles. Preserve golden outputs. The source digest includes new modules.

P4 UI and advanced abilities remain outside this Issue.
