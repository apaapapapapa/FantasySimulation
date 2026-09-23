# Old-code persistence fixtures

SQL exports and replay bytes captured with the source commit/engine in each
`metadata.json`, pinned Node 24.19.0/pnpm 11.19.0 and frozen dependencies.
`v1.10` predates #57; `v1.11` contains its surveyed scenario variants.

Reproduction: checkout that commit; seed `readSampleRevisions()`. Create
`catalogManifest('archer','guardian','flat',25)`, rename its rules ID/reference to
`compat-fixture-rules`, seed the closure, submit through BattleRuntime and await
completion. Close runtime; submit two uncached jobs and claim one (time/lease 100).
Checkpoint WAL, close Store, export SQLite `iterdump()` with gzip mtime 0; copy
replays and metadata. Regeneration requires separate review.

CI restores disposable DBs; only stopped runtime-owner host/path is relocated.
Store identity and all game data stay intact. No user DB or old engine runs in CI.

`stamina-v1.11.json`: PR #73 head `e21bbc3`, `combatManifest(10)` → `prepareBattle` →
`runBattle`. Both actors: stamina100/recovery0, self shield startup costs100;
approach/no skills. Preserves pre-G-04 stamina-only motion/display without re-execution.
