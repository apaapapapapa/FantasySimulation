# Local browser evidence (#12 preparation)

```sh
vp install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH=.generated/playwright vp exec playwright install --with-deps chromium --only-shell
vp run test:e2e
# Or choose a fresh evidence directory:
vp run harness ui .generated/harness/ui-unique
```

Linux/Chromium tests the actual heading, API connection, HTTP/invalid-response errors
and blocked external requests. Dirty trees provide diagnostics but cannot pass SHA-bound evidence.

The existing API/store/runtime seeds current domain revisions into a new OS temporary
DB. API and web bind kernel-assigned loopback ports; no server reuse or port-probe gap.
Vite builds/previews temporary assets without HMR or `.env`; child environments
exclude DB/API overrides and credentials.
Timeout/SIGINT/SIGTERM kills the owned process group before removing temporary data.
Browser contexts block foreign HTTP origins, WebSockets and service workers. These
request guards are not OS sandboxing.

`execution.json` records sample revisions, Playwright/browser revision and settings:
fixed settings from `e2e/contract.ts` and lockfile-pinned Noto Sans JP 400.
Cache identity is OS/architecture/Playwright version.

The common report binds SHA and coverage to command, raw JSON/logs, test ID, retry,
browser version and attachment hashes. Failure traces/screenshots survive retries;
flaky tests fail. Missing/skipped tests, browser startup failure or stale data cannot
pass. CI requires this job for full plans; wording-only PRs explicitly skip it.
Only evidence is uploaded, named by run/attempt; temporary DB/replays are excluded.

`static-fixtures.ts` is unit-tested read-only infrastructure using existing saved
replay bytes/provenance and `ReplayManifestSchema`; it starts no API/DB/engine.
Static browser coverage stays `unknown` until #81's reviewed publication schemas and
#79/#80 screens land. Import those shared catalog/set/page types without duplication;
keep `ReplaySource`/`OpenedReplay` in web. Add WebKit and actual selection/play/seek
flows then. P4 editor/job/cancel/result tests remain later PRs; #12 remains open.
#9 owns engine correctness, independently of screenshots.

Source: HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80` local UI harness.
