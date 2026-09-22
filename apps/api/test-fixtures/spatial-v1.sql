CREATE TABLE published_revisions (
  kind TEXT NOT NULL CHECK (kind IN ('character','ability','equipment','policy','status','ruleset','scenario')),
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_hash TEXT NOT NULL,
  revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, definition_id, revision)
) STRICT;
CREATE TRIGGER published_revisions_no_update BEFORE UPDATE ON published_revisions BEGIN
  SELECT RAISE(ABORT, 'Published revisions are immutable');
END;
CREATE TRIGGER published_revisions_no_delete BEFORE DELETE ON published_revisions BEGIN
  SELECT RAISE(ABORT, 'Published revisions cannot be deleted');
END;

CREATE TABLE definition_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('character','ability','equipment','policy','status','ruleset','scenario')),
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  published_json TEXT CHECK (published_json IS NULL OR json_valid(published_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE battle_specs (
  simulation_hash TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER battle_specs_no_update BEFORE UPDATE ON battle_specs BEGIN
  SELECT RAISE(ABORT, 'Battle specifications are immutable');
END;
CREATE TRIGGER battle_specs_no_delete BEFORE DELETE ON battle_specs BEGIN
  SELECT RAISE(ABORT, 'Battle specifications cannot be deleted');
END;

-- Existing drafts without a base cannot supersede an existing definition.
ALTER TABLE definition_drafts ADD COLUMN base_revision_json TEXT
  CHECK (base_revision_json IS NULL OR json_valid(base_revision_json));

CREATE TABLE schema_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
INSERT INTO schema_generation VALUES (1, 'spatial-v1');
INSERT INTO schema_migrations VALUES ('002_spatial_revisions.sql', 'fixture-002');
INSERT INTO schema_migrations VALUES ('003_draft_base.sql', 'fixture-003');
