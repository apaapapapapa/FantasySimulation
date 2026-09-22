# Development evidence harness

This development-only harness reuses `vp run verify`. It is not a second test engine,
production service, OS sandbox, or authorization to merge/deploy. Controller, CI,
acceptance policy and migration changes follow an ordinary reviewed engineering PR.

## Source evidence

Record baseline SHA, affected boundary and acceptance criteria before editing. Use focused
tests during development, commit the candidate, and invoke the collector from the root:

```sh
node scripts/harness.ts source .generated/harness/source-01 <full-baseline-sha>
node scripts/harness.ts report .generated/harness/source-01/report.json
```

Use the project-pinned Node/Vite+ environment. The baseline is optional and recorded as null
when absent; a supplied baseline must be an available ancestor. Use a fresh output directory
per attempt. `.generated/` is Git-ignored. Traversal and symlink paths are rejected.
The collector refuses dirty source instead of assigning uncommitted changes to HEAD. It
executes existing read-only `vp run verify` once and records the real process, Node/OS/arch,
exit status, SHA, logs and artifact digests. Do not duplicate that aggregate's components.

Process-tree deadline: 10 minutes; captured output budget: 2 MiB. Failed startup is unknown;
timeout/overflow fails. Verification must leave the committed source unchanged. Environment
inheritance is allowlisted, excluding GitHub/cloud tokens, NODE_OPTIONS and production DB
configuration. Known token patterns are redacted after concatenating bounded chunks. This
is not complete DLP: never use secret-bearing fixtures or real user data. Upload only the
report, receipt and redacted log, not the workspace.

## Semantics

Reports use the existing Zod version and strict TypeScript, full source SHA, explicitly nullable
baseline/PR-head/test-merge/deployment SHAs, producer, execution interval and unique check IDs.
Collectors own their required-check list; missing IDs become unknown.

- `pass`: all required checks have matching evidence (exit 0).
- `fail`: a required check failed (exit 1).
- `unknown`: missing/stale evidence, required skip, invalid input or unavailable collection (exit 2).
- `skipped`: a particular check did not execute; a required skip never completes delivery.

The parser validates structure/identity, not arbitrary assertions' truth. Prefer executable
collectors and retain underlying evidence. Source success, PR review, main CI and release are
separate milestones. This initial collector does not collect GitHub review or deployment;
the remainder of Issue #5 stays open pending the delivery collector and skill.

## Provenance

The status/evidence model and required-check binding adapt HiFiScout at
`36aaf69d3f7a61195af4e85a468514dfbb1ecc80`, `scripts/harness/report.ts` and
`.github/harness/README.md`:
<https://github.com/apaapapapapa/HiFiScout/tree/36aaf69d3f7a61195af4e85a468514dfbb1ecc80>.
The requesting owner maintains both repositories. No third-party vendored skill is copied;
upstream dependency licenses remain in their packages. No Cloudflare/production collector,
`src/types`, credentials or historical-engine compatibility requirement is imported.

Pinned Node/pnpm/Vite+ and the current SQLite runner remain canonical. Root manifest/lockfile
changes conservatively change the engine digest: review and restamp it without changing
rules or rewriting unrelated physics fixture expectations.
