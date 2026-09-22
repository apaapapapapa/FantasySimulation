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
