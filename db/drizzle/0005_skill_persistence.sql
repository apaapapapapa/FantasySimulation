CREATE TABLE `skill_catalog_revisions` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`catalog_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`id`, `revision`),
	CONSTRAINT "skill_catalog_revisions_positive_revision" CHECK("skill_catalog_revisions"."revision" > 0),
	CONSTRAINT "skill_catalog_revisions_valid_json" CHECK(json_valid("skill_catalog_revisions"."catalog_json"))
) STRICT;
--> statement-breakpoint
CREATE TRIGGER skill_catalog_revisions_no_update BEFORE UPDATE ON skill_catalog_revisions BEGIN
  SELECT RAISE(ABORT, 'published skill catalog revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER skill_catalog_revisions_no_delete BEFORE DELETE ON skill_catalog_revisions BEGIN
  SELECT RAISE(ABORT, 'published skill catalog revisions cannot be deleted');
END;
--> statement-breakpoint
CREATE TABLE `skill_loadout_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`latest_revision` integer NOT NULL,
	`latest_content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`id`,`latest_revision`) REFERENCES `skill_loadout_revisions`(`id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "skill_loadout_heads_positive_version" CHECK("skill_loadout_heads"."version" > 0 AND "skill_loadout_heads"."latest_revision" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `skill_loadout_revisions` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_hash` text NOT NULL,
	`catalog_id` text NOT NULL,
	`catalog_revision` integer NOT NULL,
	`character_json` text NOT NULL,
	`configuration_json` text NOT NULL,
	`resolved_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`id`, `revision`),
	FOREIGN KEY (`catalog_id`,`catalog_revision`) REFERENCES `skill_catalog_revisions`(`id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "skill_loadout_revisions_positive_revision" CHECK("skill_loadout_revisions"."revision" > 0),
	CONSTRAINT "skill_loadout_revisions_valid_character" CHECK(json_valid("skill_loadout_revisions"."character_json")),
	CONSTRAINT "skill_loadout_revisions_valid_configuration" CHECK(json_valid("skill_loadout_revisions"."configuration_json")),
	CONSTRAINT "skill_loadout_revisions_valid_resolved" CHECK(json_valid("skill_loadout_revisions"."resolved_json"))
) STRICT;
--> statement-breakpoint
CREATE TRIGGER skill_loadout_revisions_no_update BEFORE UPDATE ON skill_loadout_revisions BEGIN
  SELECT RAISE(ABORT, 'skill loadout revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER skill_loadout_revisions_no_delete BEFORE DELETE ON skill_loadout_revisions BEGIN
  SELECT RAISE(ABORT, 'skill loadout revisions cannot be deleted');
END;
