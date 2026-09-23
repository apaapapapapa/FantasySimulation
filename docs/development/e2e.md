# Local browser evidence (#12)

```sh
vp install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH=.generated/playwright vp exec playwright install --with-deps chromium --only-shell
vp run test:e2e
vp run harness ui .generated/harness/ui-unique
```

Linux/Chromium covers the heading, API health/error responses and blocked external
requests. Dirty trees are diagnostic only. Each run seeds current domain revisions
into a temporary SQLite DB and binds its own loopback API/web ports. Vite previews
temporary builds without HMR or `.env`; child environments exclude DB/API overrides
and credentials. Timeout/SIGINT/SIGTERM stops the owned process group before cleanup.
Contexts block foreign HTTP origins, WebSockets and service workers; this is not OS
sandboxing. Temporary DB/replays are never in the uploaded artifact directory.

`execution.json` records sample revisions, Playwright/browser revision and settings
from `e2e/contract.ts`, including lockfile-pinned Noto Sans JP 400. Browser caches use
OS/architecture/Playwright version. Full CI plans require UI; wording-only PRs skip it.

Reports bind source SHA, CI attempt, test ID, retry, browser and raw artifact hashes.
Failed first attempts and traces/screenshots survive retries; flaky, missing,
skipped, unstarted or stale execution cannot pass. Relocated CI files are rechecked.

Separate `diagnostics/startup`, `timeout` and `crash` probes exercise partial API/web
startup failure, a real test timeout and Chromium process crash. The diagnostic
checks require failure evidence, the pre-crash image, trace and successful cleanup.
They cannot satisfy smoke coverage. Missing probes fail `ui:diagnostics` in the gate.

`static-fixtures.ts` serves existing saved replay bytes through `ReplayManifestSchema`
without API/DB/engine. Static browser coverage remains `unknown` until #81 publication
schemas and #79/#80 screens land. Reuse those domain types and web's
`ReplaySource`/`OpenedReplay`; add WebKit and selection/play/seek flows with the screens.
P4 editor/job/cancel/result tests remain pending; #12 stays open. #9 owns engine
correctness independently of screenshots.

Source: HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80` UI harness.
