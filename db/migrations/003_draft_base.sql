-- Existing drafts without a base cannot supersede an existing definition.
ALTER TABLE definition_drafts ADD COLUMN base_revision_json TEXT
  CHECK (base_revision_json IS NULL OR json_valid(base_revision_json));
