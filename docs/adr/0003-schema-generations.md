# Explicit SQLite schema generations

Accepted for Issue #7. The current API schema is `local-v1`, declared in
`db/schema.json`. This labels the existing SQL; it does not replace the P3 schema.
The P3 change must choose its own generation and a reviewed ADR when replacing
this schema. Historical engine execution and old-database compatibility are not gates.

Within one generation, existing numbered SQL is append-only. Startup rejects missing,
reordered or checksum-mismatched applied migrations. All initialization and upgrades
use the existing application runner, now shared with disposable verification.

A database without generation metadata, or with another generation, is unsupported.
Startup reports that condition and never erases it or guesses an upgrade. Empty DBs
initialize transactionally; a failed migration rolls back its schema and receipts.

Development reset is explicit and requires a new, nonexisting destination:

```sh
vp run db:reset ./data/fantasy-new.sqlite --confirm-generation local-v1
```

Set `DATABASE_PATH=./data/fantasy-new.sqlite` to use it, then seed if needed.
The original database remains available. Existing targets (including symlinks) are
refused before opening SQLite; normal startup never invokes reset. CI only opens
throwaway databases and uses the same runner for initialization and reexecution.

To replace a generation, change `db/schema.json` to a distinct identifier and a new
ADR describing the replacement and explicit reset. Review both in an ordinary PR.
The guard verifies the new schema from empty state and permits removal of obsolete
SQL and fixtures; it does not demand old-runtime or old-DB compatibility tests.
