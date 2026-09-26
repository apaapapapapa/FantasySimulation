# Content authoring

`*.json` files here are the authoring source; `data/spatial/catalog.json` is generated.
`builtin-v1.json` preserves the previously published snapshot. Add independent files,
not branches in the simulator or edits to published revisions.

A file contains one revision or an array. Required: `kind`, `id`, `revision`,
`definition`; `schemaVersion` defaults to 1. Omit `contentHash` for a new revision.
A supplied hash must match; ordinary `{id, revision, contentHash}` references stay pinned.
Use `{"$ref":"status:soaked-v1:1"}` for a named reference resolved by the compiler.
Forward references work; missing references, cycles and duplicate identities fail.

Agents run `node scripts/spatial-catalog.ts --write`, review the generated diff,
then `vp run verify`. No owner PC is required. The compiler reuses shared schemas,
revision closure/hash rules and the published-history guard. Generated data is never
an authoring dependency. Existing fixture expectations must not be regenerated.
