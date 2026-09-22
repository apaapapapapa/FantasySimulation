-- Adopt the existing spatial-v1 (002 + 003) schema without replacing its rows.
-- STRICT and immutable triggers are reviewed SQLite additions to Kit-generated SQL.
CREATE TABLE IF NOT EXISTS `battle_specs` (
	`simulation_hash` text PRIMARY KEY NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "battle_specs_valid_json" CHECK(json_valid("battle_specs"."manifest_json"))
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `definition_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`definition_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition_json` text NOT NULL,
	`published_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`base_revision_json` text,
	CONSTRAINT "definition_drafts_kind" CHECK("definition_drafts"."kind" IN ('character','ability','equipment','policy','status','ruleset','scenario')),
	CONSTRAINT "definition_drafts_positive_version" CHECK("definition_drafts"."version" > 0),
	CONSTRAINT "definition_drafts_valid_json" CHECK(json_valid("definition_drafts"."definition_json")),
	CONSTRAINT "definition_drafts_valid_published" CHECK("definition_drafts"."published_json" IS NULL OR json_valid("definition_drafts"."published_json")),
	CONSTRAINT "definition_drafts_valid_base" CHECK("definition_drafts"."base_revision_json" IS NULL OR json_valid("definition_drafts"."base_revision_json"))
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `published_revisions` (
	`kind` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`revision_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`kind`, `definition_id`, `revision`),
	CONSTRAINT "published_revisions_kind" CHECK("published_revisions"."kind" IN ('character','ability','equipment','policy','status','ruleset','scenario')),
	CONSTRAINT "published_revisions_positive_revision" CHECK("published_revisions"."revision" > 0),
	CONSTRAINT "published_revisions_valid_json" CHECK(json_valid("published_revisions"."revision_json"))
) STRICT;

--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS published_revisions_no_update BEFORE UPDATE ON published_revisions BEGIN
  SELECT RAISE(ABORT, 'Published revisions are immutable');
END;

--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS published_revisions_no_delete BEFORE DELETE ON published_revisions BEGIN
  SELECT RAISE(ABORT, 'Published revisions cannot be deleted');
END;

--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS battle_specs_no_update BEFORE UPDATE ON battle_specs BEGIN
  SELECT RAISE(ABORT, 'Battle specifications are immutable');
END;

--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS battle_specs_no_delete BEFORE DELETE ON battle_specs BEGIN
  SELECT RAISE(ABORT, 'Battle specifications cannot be deleted');
END;

--> statement-breakpoint
DROP TABLE IF EXISTS schema_migrations;
--> statement-breakpoint
DROP TABLE IF EXISTS schema_generation;
