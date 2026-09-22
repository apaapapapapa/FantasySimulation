# Explicit SQLite schema generations (superseded)

Status: superseded by [ADR 0004](0004-drizzle-kit.md).

The user requested complete replacement of the application-owned migration system
with Drizzle Kit. The old runner, schema generation declaration, checksum receipts,
reset command and generation-specific verification have been removed. They must not
be reintroduced as a compatibility layer. The previous decision remains in Git history.
