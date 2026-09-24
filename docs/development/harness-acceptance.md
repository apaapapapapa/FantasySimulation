# Harness H1–H3 acceptance record

Issues #5–#7 were implemented in PRs #13/#22/#23/#32/#33/#35/#37/#38/#39.
The [original acceptance record](https://github.com/apaapapapapa/FantasySimulation/blob/4618f3cc78942b354e1b8271f845f288cd4582c6/docs/development/harness-acceptance.md)
retains exact heads, PR/main runs, collector limitations and the historical Linux/Windows results.
[Timing observations](ci-measurements.json) are observational, not causal speedup evidence.
Old reset/schema-generation/OS details describe those commits, not current requirements.

Current contracts: [source/review evidence](../../.github/harness/README.md),
[Linux CI and measurements](ci.md), [quality guards](quality.md),
[Drizzle migrations](../adr/0005-drizzle-kit.md),
[saved-data compatibility](../adr/0010-battle-version-compatibility.md),
[Issue completion](../issue-completion.md).
Workflow code does not establish repository protection; require live settings evidence.
Quality policy changes still require explicit review and regression tests.
