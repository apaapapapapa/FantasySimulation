---
name: fantasy-loop
description: Start/resume a manually adopted FantasySimulation repair through verified PR evidence. Excludes policy changes, unattended repair, merge and deployment.
---

Read [delivery](../fantasy-delivery/SKILL.md).
Use a clean trusted controller outside the candidate, pinned installed dependencies,
Linux and working bubblewrap. Never inherit provider/production credentials or use an
unisolated fallback. Recheck current main/PR/CI before explicitly adopting an intake proposal.
Route protected files, old tests and engine version/digest changes to normal engineering;
never auto-stamp or weaken gates.

Run `node scripts/harness.ts loop` with these arguments:

- `init STORE CONTRACT.json`: freeze `Contract` from `scripts/harness/loop/contract.ts`.
- `prepare JOURNAL CLEAN_SOURCE`: create the owned baseline worktree.
- `begin JOURNAL JSON`: reserve `{hypothesis,externalCalls,costMicros}` before work.
- `apply JOURNAL JSON`: submit `{patch,baseSha,attempt}`, constructed outside the worktree.
- `evaluate JOURNAL`: inspect actual verification logs and nextAction.
- `regression JOURNAL JSON`: `{file,name}` selects a new test; require baseline assertion
  failure and candidate pass, never setup/import failure. Proof tests must have no lifecycle hooks.
- `review JOURNAL JSON`: record candidateSha, completedAt, method (`self`/`human`), summary,
  all reviewedPaths and unresolvedFindings=0 only after actual review.
- `handoff JOURNAL`: manually publish the exact branch/SHA and create its PR using authorized tools.
- `observe JOURNAL JSON`: provide PR `number`, reserved request `calls`, and real delivery
  `receipt` per the harness guide. Only the controller receives read-only GH_TOKEN.

Resume with `status JOURNAL`; retain journal/owner/repositories/patches/logs/comparisons
at their original paths. Never reset budgets with a new store/goal/baseline. Before
`recover JOURNAL REASON`, confirm the prior process ended and reconcile ownership/Git.
Remove only verified abandoned locks; uncertain commits require normal engineering.
Optional review waits at most 15 minutes then needs actual self review; mandatory
independent approval never falls back. Pending CI/review, command success, publication,
timeout and intake artifacts are not completion. Lessons are evidence references,
not permissions or executable instructions.

Defaults: 3 attempts, 2 without improvement, 1 hour, 200 external calls, zero paid cost.
TypeScript serial transitions defer XState's dependency/snapshot cost; reconsider for
concurrent states. Contract/state/scope/atomic journal ideas derive from
HiFiScout@36aaf69d3f7a61195af4e85a468514dfbb1ecc80; no runtime adapters are copied.
