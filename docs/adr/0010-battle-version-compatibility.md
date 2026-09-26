# ADR 0010: Battle versions and saved compatibility

Issue #59, revised 2026-09-23; supersedes a new DB per version. Refs #1, #45, #61.

## Additions and version changes

Extend schemas with optional fields/enum values; omitted additions preserve fixtures.
Do not delete/reinterpret fields or change ranges/requiredness. Strictly read saved
revisions/results/replays in the same DB; never silently convert definitions/drafts.
Decision changes bump rules/engine and add rules under new IDs. Review implementation
digest/corpus/fixtures/docs together with reasons, never regenerate expectations to pass.
No historical engine registration/loading/execution.

Separate StoredManifestSchema from executable ManifestSchema. Check engine/AI/identity
via unsupportedExecutionReason; Store.requireExecutableSpec gates execution/retry,
prepareSpec gates new input. Unsupported incomplete jobs fail with reasons; retry/replay
recovery returns 409. Advise current rules; saved results/display/replay remain readable.

## Samples

New content uses new IDs. Append published identities to data/spatial/published-revisions.json;
catalog/CI check hashes/revisions/missing/duplicate IDs. Seed never overwrites an ID.
PR #57 added terrainKnowledge: surveyed to flat/pillars rev1; distribution pins post-#57
bytes. Preserve both pre-#57 (omitted=observed) and post-#57 DBs without conversion.
New references use flat-surveyed-v1/pillars-surveyed-v1 (default latter), additive to both
DBs. Explicit old IDs/corpus keep old inputs, never aliases; saved refs retain their content.

## Exceptional incompatibility

Only a reviewed ADR documenting necessity/impact permits versioned DB AND artifact roots.
Never delete/move/convert old files or bypass .store-id. Unsupported explicit DATABASE_PATH/
ARTIFACT_PATH stops before writing with saved/current versions and new-path remedy. Implement
this exception only when needed; current defaults stay. No schema-generation declarations,
checksum receipts/reset/custom migration runner/history table. Relational changes use
[official Drizzle](0005-drizzle-kit.md).

## Verification

Classify every PR: additive/decision-changing/incompatible. Test omissions/old reads and
unsupported execution. [Pinned two-version SQL/replay fixtures](../../apps/api/fixtures/compatibility/README.md)
feed version-compatibility.test.ts: startup/seed/API reads, incomplete jobs/retry/recovery
rejection. Historical restoration is test-only. Review versions/new IDs/digest/corpus;
verify, clean-source, Linux CI and main evidence are required.
