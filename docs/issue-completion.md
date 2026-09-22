# Issue completion through the harness

## Required development finish step

Finishing an Issue includes updating its checklist and completion evidence and
closing it, not merely merging code or reporting completion in chat. Use the
existing source harness for verification, then include a reviewed declaration
at `.github/issue-completions/<number>.json` in the final PR. Partial PRs use
`Refs #number`; do not use GitHub's `Closes`/`Fixes`/`Resolves` keywords because
those can close an Issue at merge time, before main validation succeeds.

Review the latest Issue body, discussion, all acceptance criteria, linked PRs,
sub-Issues and external setup. Update partial progress directly in the Issue;
do not register a completion declaration until every requirement is met.
Issue #8's pending App/admin work, for example, is not waived by this workflow.

With a read-capable `GITHUB_TOKEN` in the environment, generate a draft:

```sh
node scripts/harness.ts issue-plan 25
```

The output contains the live body's SHA-256, updated timestamp and recognized
checklist items. Copy it to the declaration file, fill in a summary, all PR
numbers and nonempty evidence for every acceptance item. Set `complete` to
`true` and `remainingWork` to an empty array only after reviewing the full
scope. Evidence should identify tests, implementation paths, external setup
records or validation results; never include credentials. PR CI validates all
committed declarations. They intentionally need no future main SHA: the
post-CI harness supplies and verifies the actual main SHA and run ID.

If the Issue contains task lists, the declaration must match **every** task
exactly, including previously checked items. Duplicate task text is rejected.
Fenced code examples and HTML comments are not tasks. For Issues without a
checklist, provide an explicit nonempty acceptance list; this is a reviewed
attestation of full scope, not something inferred from a green build.

## Automated execution

`Issue completion` runs after a successful `CI` workflow on main. Its own token
has only repository/actions/PR read and Issue write permissions. PR workflows
never invoke this writer; no production secrets, new PAT or package install
is required. It checks the completed CI's path, repository, event, branch,
SHA and attempt, all eleven expected jobs, both source-runner reports and
actual `vp run verify` command receipts through the existing report contract.
Artifacts are downloaded only from that exact run and never executed.

The handler requires all declared PRs to be merged to this repository's main
and their merge commits to be ancestors of the tested SHA. It refuses newer
untested main state, a changed Issue body/timestamp, uncovered acceptance,
open sub-Issues and failed/skipped/missing evidence. It then reads the Issue
again, updates its original checklist, appends the implementation summary,
PR/main/CI links and acceptance evidence, and sets `state=closed` with
`state_reason=completed` in **one** API request. The response and a subsequent
read must confirm the update. The output uses the common harness report schema.

The completion marker makes retries no-ops after success. Already closed
Issues are left alone. An Issue reopened by a maintainer is not silently
closed again. Other Issue metadata is not replaced. Processing is serialized.
GitHub's Issue update API has no documented atomic compare-and-swap operation;
the immediate re-read detects observed edits but cannot eliminate an edit in
the tiny interval between that read and the PATCH. Review the audit history
when concurrent manual edits occur.

## Failures and retries

A blocked candidate remains open and its check becomes `unknown`; one blocked
Issue cannot be reported as completed. Read the `issue-completion-*` artifact
and the failed workflow. After a requirements change, fetch and review the
new Issue, then revise the declaration in a new PR. Do not blindly refresh
the body hash or remove a remaining requirement just to pass the gate.

When newer main supersedes a run, its next successful CI retries the reviewed
declarations. For transient failures on unchanged main, rerun the failed
`Issue completion` workflow. To verify a newer main explicitly, run `CI` on
main with `workflow_dispatch`. The writer CLI defaults to dry-run without
`--apply`, but both modes still require the trusted workflow-run context and
live CI evidence; it is not an offline command for bypassing the gate.

Automatic CI can verify technical evidence, not whether an external approval
was genuinely granted or prose requirements are semantically satisfied.
Agents and reviewers remain responsible for the truth of the declaration.
