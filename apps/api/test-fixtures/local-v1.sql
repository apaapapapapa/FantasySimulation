CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE rulesets (
  version TEXT PRIMARY KEY,
  definition TEXT NOT NULL CHECK (json_valid(definition))
) STRICT;

CREATE TABLE battles (
  id TEXT PRIMARY KEY,
  rules_version TEXT NOT NULL REFERENCES rulesets(version),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX battles_created_at ON battles(created_at DESC, id DESC);

CREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
INSERT INTO schema_generation VALUES (1, 'local-v1');
INSERT INTO schema_migrations VALUES ('001_initial.sql', 'legacy-test-receipt');
