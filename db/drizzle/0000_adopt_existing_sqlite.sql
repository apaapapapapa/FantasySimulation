-- Initial adoption of the existing local-v1 tables without replacing their rows.
-- STRICT is a reviewed SQLite extension not represented by Drizzle 0.45 snapshots.
CREATE TABLE IF NOT EXISTS `battles` (
	`id` text PRIMARY KEY NOT NULL,
	`rules_version` text NOT NULL,
	`record_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`rules_version`) REFERENCES `rulesets`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "battles_record_json_valid" CHECK(json_valid("battles"."record_json"))
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `battles_created_at` ON `battles` (created_at desc,id desc);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "characters_definition_json" CHECK(json_valid("characters"."definition"))
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rulesets` (
	`version` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	CONSTRAINT "rulesets_definition_json" CHECK(json_valid("rulesets"."definition"))
) STRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS `schema_migrations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `schema_generation`;
