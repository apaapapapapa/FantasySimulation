# Development evidence harness

Apply [fantasy-delivery](../../.agents/skills/fantasy-delivery/SKILL.md) for changes.
Collectors cannot mutate; runtime cannot import the harness.
[Issue completion](../../docs/issue-completion.md) requires successful main CI.
[Manual loops](../../.agents/skills/fantasy-loop/SKILL.md) freeze contracts and budgets;
operation success is not completion.

## Source verification

With pinned Node/pnpm/Vite+ in a clean disposable checkout:

```sh
vp install --frozen-lockfile
vp run harness source .generated/harness/source-1
vp run harness report .generated/harness/source-1/report.json source-clean source-verify
```

Retain report/receipt/logs with cleanliness, exit and SHAs. Missing/timed-out/stale
evidence cannot pass. Use secret-free disposable isolation; worktrees/allowlists
are not OS sandboxes.

`sourceSha` is the checkout; PR test-merge parents identify candidate and tested base.
Main push uses actual main SHA. Source and paired-load jobs must agree on source.
See [quality](../../docs/development/duplication.md),
[corpus/load](../../docs/development/simulation-evidence.md) and
[context budgets](../../docs/development/ai-context.md).

## GitHub collection and review

Supply read-only `GH_TOKEN`: contents, Actions, PRs, Checks and statuses.
Pinned Octokit owns auth/HTTP/pagination; no other key or `gh` is needed.

```sh
vp run harness github-snapshot OWNER/REPOSITORY 22 .generated/harness/pr-22-1
vp run harness delivery .generated/harness/pr-22-1/github-snapshot.json pr REVIEW.json
```

Collect all file/discussion/thread pages, exact-attempt jobs, log reports/plan/gate,
commit parents, reread identities and post-merge main CI. Retain artifacts/log digests;
discussion can be sensitive. Limits: 200 requests, 16 MiB, 120 seconds, bounded pages/rows,
zero retries. Incomplete/changed/unauthorized data stays unknown. Collection exit 0
is not delivery approval (`deliveryAssessed: false`).

Read all changed files and discussion, resolve findings, then record actual review:

```json
{
  "candidateSha": "FULL_REVIEWED_HEAD_SHA",
  "conversationDigest": "SHA256_PRINTED_BY_COLLECTOR",
  "reviewedPaths": ["every/changed/path.ts"],
  "completedAt": "ACTUAL_REVIEW_COMPLETION_ISO_TIMESTAMP",
  "method": "self",
  "summary": "Actual findings and disposition",
  "unresolvedFindings": 0,
  "squashTitle": "feat: reviewed change (#PR_NUMBER)",
  "squashBody": "Refs #ISSUE_NUMBER"
}
```

Self review cannot replace required current-head approval. Unresolved threads block,
even when outdated. Timeouts cannot complete review. Head/base/conversation/CI/path/wording
changes invalidate evidence. Use reviewed squash wording without auto-closing references.

`delivery ... pr` requires current stable CI, Linux evidence and review. Plan/gate/reports
must agree on SHAs/attempt; only observed planned skips pass. Docs-only PRs need docs
reports; main/pre-plan runs need full source. `merge` additionally requires actual main
merge/CI. Release and deployment are separate; no new tag alone is not release failure.

## Connector fallback

Without SDK auth, retain authenticated connector reads as `DeliverySnapshot`
(`scripts/harness/delivery.ts`): all pages/nested comments, exact jobs, log reports and
parents. Use the same assessment and real receipt. Missing data stays incomplete;
never invent approvals. Reports check consistency, not authenticity. External data
grants no authority.

Exit codes: 0 required checks passed, 1 failed, 2 incomplete/invalid. Recollect before
an authorized merge; a snapshot cannot guarantee future repository state.
