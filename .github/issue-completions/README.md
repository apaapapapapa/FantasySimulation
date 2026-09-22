# Reviewed Issue completion declarations

Add `<issue-number>.json` only in the final PR for an Issue. Generate a draft
with `node scripts/harness.ts issue-plan <number>`, then review every acceptance
item, fill its evidence and merged-to-main PR numbers (including the final PR),
set `complete: true` and `remainingWork: []`. Do not commit an incomplete draft.
The CI checks the declaration schema; the post-main-CI harness verifies live
state before updating the Issue checklist, appending evidence and closing it.
See [the operational guide](../../docs/issue-completion.md).

These files are reviewed attestations, not an automatic judgment that arbitrary
requirements or external setup are complete. Do not register an Issue while it
has remaining work, including parent/sub-Issue or external administration work.
Keep completed declarations as receipts. Reopened Issues are not closed again
by an existing completion marker. Review and remove the old marker explicitly
before preparing a new declaration for an intentionally repeated completion.
