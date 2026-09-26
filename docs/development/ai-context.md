# AI context policy

Start with [AGENTS](../../AGENTS.md), `node scripts/harness.ts context list`, then
`context <topic>` (e.g. engine); use each relevant topic. Navigation <=2,000 UTF-8 bytes,
Node-only, no install/AI/API/write. Changes use the delivery skill.

Use rg before bounded owning schema/code/test/instruction reads; no routine document/log
preloads. Review full diffs; focused checks never replace delivery evidence.

Keep logs in .generated; inspect exit/receipt/report and failure excerpts, not search
hits alone. Preserve CI markers. Repeat checks only for remaining risks/gates. Handoffs
retain goal, head, changes, evidence, blockers/next action; keep evidence SHA-bound.

README owns startup; AGENTS rules; local-usage commands; ADRs decisions; harness evidence.
Link, do not copy. Archive history immutably; retain current contracts/reproduction/tasks
and repair moved/deleted links.

`node scripts/harness.ts context check` checks tracked/untracked md/mdx/markdown bytes,
per-document/instruction/entrypoint/total budgets, navigation and local inline links;
not external URLs/anchors/reference links. [context.ts](../../scripts/harness/context.ts)
owns limits. Bytes are not tokens/prices/API usage. Exit 0=pass, 1=violation, 2=incomplete;
sizes/findings remain in quality/Docs artifacts. Required quality:context (quality/verify/
source) and docs:context (Docs CI) feed ci-gate/delivery; missing/failing never passes.

#106 D-4 retains 170,000 bytes including ADRs. Condense duplication/history first; no
exclusions/raised caps to pass. Extensions need justified review and boundary/overflow
tests. Preserve historical measurements/SHAs. Size reductions are not measured API savings.
