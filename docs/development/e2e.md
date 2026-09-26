# Local browser evidence (#12)

```sh
vp install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH=.generated/playwright vp exec playwright install --with-deps chromium webkit --only-shell
vp run harness ui .generated/harness/ui-unique
```

Linux/Chromium tests fresh SQLite samples, draft save/resume/validate/publish,
async cancellation/retry/results and API errors. Separate Chromium/WebKit tests use
`/FantasySimulation/` and a read-only localhost data origin without API/DB/engine.
Coverage: 1000-row paging, direct URLs, reload, 3D play/pause/repeat/speed/seek/cameras,
partial endings, damaged/missing/oversize/double-gzip logs, late cancellation and
WebGL log fallback. State/hash and reducer tests verify display; #9 owns combat.
League/pair replay. #82: no-WebGL 2D, emulated touch (no real phone), local files, step links.

Owned temporary DB/artifacts/ports only; no existing servers, `.env` or credentials.
Timeout/abort kills owned processes. DB/replays are excluded from uploads.
Contexts allow assigned origins, block WebSockets/service workers; not an OS sandbox.
`execution.json` records lockfile-pinned Playwright/browser revisions, Noto Sans JP 400,
locale/timezone/viewport and software-GL settings. Browser cache identity includes
OS/architecture/Playwright. Main, manual and weekly CI require both suites; PRs skip them.
Static cases run two workers over isolated read-only origins; other scenarios keep one.

Reports bind SHA/CI attempt/case/browser/retry/raw hashes and retain failed traces/images.
Flaky, missing, skipped, unstarted or stale runs fail. The gate rechecks moved artifacts.
Separate startup/timeout/crash probes require failure artifacts and cleanup.
Their expected failures never satisfy normal coverage. Static coverage requires both
browsers and API-free execution.

Fixtures use #81 schemas and unchanged 240-step bytes. `provenance.json` pins the archive;
partial/unexecuted slots are synthetic. Regeneration requires review.
Source pattern: HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80` UI harness.
