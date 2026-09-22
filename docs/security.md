# Security checks (H4 / Issue #8)

## Scope and provenance

These development-only checks protect the existing Node/pnpm/Vite+ workspace.
They do not install production credentials or replace semantic-release.
The design was adapted from HiFiScout commit
`36aaf69d3f7a61195af4e85a468514dfbb1ecc80`, specifically
`.github/workflows/secret-scan.yml`, `codeql.yml` and `renovate.json5`.
The implementation here is independent; no HiFiScout runtime code, ignore list,
Markdown exclusion, old Actions pin or automatic merge policy was copied.

## Secret scan

Every PR (including Markdown-only PRs) and main CI calls `security.yml`.
The same workflow can be started manually and runs weekly on main.
It scans the full fetched Git history and the current working tree, including
merge-resolution changes. `fetch-depth: 0` is mandatory. Remote refs not fetched
by the checkout and inaccessible GitHub PR refs are outside that history scope.

Gitleaks 8.30.1 is downloaded with a repository-pinned SHA-256 checksum.
Its standard detection rules are enabled. A synthetic canary is generated only
in a temporary directory: the test checks Markdown, default provider rules,
ignored inline annotations, a clean tree and a deleted historical credential.
No real credential is used. Repository `.gitleaksignore` and inline
`gitleaks:allow` bypasses are disabled by the runner.

Run with the pinned project Node and Gitleaks on PATH:

```sh
vp run security:test
node scripts/security/secrets.ts --self-test
vp run security:secrets
```

`security:test` also runs as part of `vp run verify` and Linux/Windows CI.
The real Gitleaks binary scan is a separate Linux job, not an offline unit test.
Missing executables, incomplete history, scanner errors, missing or invalid
reports and disagreeing exit codes are `unknown` (exit 2), never `pass`.
Detected, unexcepted secrets are `fail` (exit 1); only verified success exits 0.

## Detection output and exceptions

The runner captures stdout/stderr without forwarding them. Raw detector reports
are temporary and deleted; they are never uploaded. Public output includes only
rule ID, line number, a SHA-256 location identifier and a SHA-256 fingerprint.
Do not paste a suspected credential, raw detector report or source line into
an Issue, PR, artifact or public log. Locate it in a private local investigation,
revoke/rotate a genuine credential first, then remove it and investigate exposure.
Deleting a current file does not remove the finding from its history.

`.github/security/secret-exceptions.json` starts empty. An exception requires
exactly one `fingerprintSha256`, a meaningful `reason`, a GitHub `reviewer`,
`reviewedAt` and `expiresAt` in ISO date-time format. The maximum interval is
30 days; expiry, duplicate IDs or invalid review metadata fail the check.
There is no directory-wide, rule-wide or automatic exception mechanism.
The reviewer field is an audit record, not proof of a GitHub approval: require
an independent human review of the exception PR and do not self-approve it.

## Evidence and repository settings

Sanitized JSON receipts identify the checked Git SHA, PR head/base where known,
run ID, attempt, timestamp, status and counts. PR test-merge SHA is deliberately
not relabelled as the PR head. Receipts appear in the step summary and the
`security-secrets-<run>-<attempt>` artifact (14-day retention).
A missing receipt upload fails the job. Setup failures can have no receipt;
the aggregate `security-gate` still fails because the required job did not pass.

Main release requires both platform verification and the security workflow.
Required checks must additionally be configured in repository branch rules;
a workflow dependency alone does not prevent an administrator from merging.
Require `Security / security-gate` (use the exact name shown by the first run)
and both existing `Verify (...)` checks, and protect workflow/policy changes
with review. Do not remove old required checks before confirming the new names.

At implementation baseline `92df8bbbe5b33d36fc5047c5f31843f8dbbc83de`,
the repository is public. The connected integration returned HTTP 403 for
branch-protection reads. Branch protection is therefore **unverified**, not
installed or confirmed by this change. No repository administration was changed.

H1 (#5) report schema and H2 (#6) aggregate CI gate were not present on that
baseline. H4 receipts are a separate, explicitly named producer, not invented
H1 receipts. When those features land, register all required H4 checks and bind
these receipts to the actual tested SHA; do not treat missing evidence as green.
CodeQL/dependency audit and Renovate activation are separate follow-up PRs for
#8. Keep the Issue open until their runtime and external setup criteria are met.
