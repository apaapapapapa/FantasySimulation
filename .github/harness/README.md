# Development evidence harness

Issue #5, first increment. Development-only code under `scripts/harness/` must not
be imported by application runtime code. The CLI currently implements source
verification and source-report assessment; GitHub delivery collection follows in
a separate PR. Nothing here merges PRs or deploys software.

## Commands

Use the repository-pinned Node, pnpm and Vite+ and install the frozen lockfile.
Commit the candidate first; retain a clean checkout. From the repository root:

```sh
vp run test:harness
vp run harness source my-unique-run
vp run harness source another-run FULL_BASELINE_SHA
vp run harness report .generated/harness/my-unique-run/report.json
```

`source` executes the existing `vp run verify` once without formatting fixes.
`verify` also includes the small Node-native harness tests; existing application
Vitest suites, engine identity, type checks and both application builds remain.
The runner rejects a dirty checkout or a Node version different from
`.node-version`. It does not reset files, change budgets, update fixture hashes,
install packages, read production databases, or pass production credentials to
its subprocess. Use a disposable, secret-free checkout: environment filtering
is not an OS sandbox and cannot make an arbitrary source tree trustworthy.

Each run creates a new `.generated/harness/<run-id>/` directory. Keep the report,
receipt and redacted `verify.log` together; the receipt contains log/lockfile
SHA-256, actual command, execution interval, OS and actual exit status. Reusing a
run ID fails rather than overwriting evidence. In CI, a fresh run/attempt/OS ID is
used and evidence is uploaded even on failure. Missing artifacts fail the upload.

`sourceSha` is the actual checked-out commit. `candidateSha` is the PR head when
`HARNESS_CANDIDATE_SHA` is supplied by CI. The runner verifies that this head is
the second parent of the tested merge and records its actual first-parent base;
it never substitutes PR head for the tested tree. Main push verification records
the real main SHA. The source command alone does not establish review, merge,
release or deployment completion.

## Assessment contract

The model is adapted from `apaapapapapa/HiFiScout` commit
`36aaf69d3f7a61195af4e85a468514dfbb1ecc80`, `scripts/harness/report.ts` and the
source-evidence principles in `.github/harness/README.md`. HiFiScout's application
helper dependencies and Cloudflare deployment policy were not imported.
The owner requested this cross-repository adaptation; no additional third-party
code or new package dependency is vendored by this increment.

Statuses remain `pass`, `fail`, `unknown`, `skipped`. A consumer supplies the
required check IDs independently of observed data. Missing checks, required
skips, missing evidence and stale SHAs cannot pass. Exit codes are 0 for required
passes, 1 for failures and 2 for incomplete or invalid input. The source assessor
requires `source-clean`, `toolchain`, and `verify`.

Structural validation is not proof that arbitrary JSON tells the truth: retain
producer logs and CI identities and inspect them. This increment deliberately
uses a small development-only validator adapted from the source instead of
importing app modules or a second copy of Zod. It does not attest signatures or
prove the contents of remote URLs. Evidence URLs cannot contain credentials or
query strings; local references cannot escape the repository.

Process output is bounded, known credential values are redacted, and timeouts
terminate the process group on POSIX or process tree on Windows. A timeout or
output-limit termination is a failure even if a process exits with zero.
Tests run only against temporary repositories and local subprocesses.

Issue #5's Octokit delivery collector, full review pagination and delivery skill
are not implemented by this increment. Issues #6 and #7 add their own scoped
producers and gates without changing this source-verification meaning.
