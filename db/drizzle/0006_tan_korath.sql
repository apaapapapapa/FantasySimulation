CREATE TABLE `skill_acquisition_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`latest_revision` integer NOT NULL,
	`latest_content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`id`,`latest_revision`) REFERENCES `skill_acquisition_revisions`(`id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "skill_acquisition_heads_positive_version" CHECK("skill_acquisition_heads"."version" > 0 AND "skill_acquisition_heads"."latest_revision" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `skill_acquisition_revisions` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`policy_version` text DEFAULT 'skill-acquisition-v1' NOT NULL,
	`content_hash` text NOT NULL,
	`catalog_id` text NOT NULL,
	`catalog_revision` integer NOT NULL,
	`character_json` text NOT NULL,
	`eligibility_json` text NOT NULL,
	`learned_json` text NOT NULL,
	`capabilities_digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`id`, `revision`),
	FOREIGN KEY (`catalog_id`,`catalog_revision`) REFERENCES `skill_catalog_revisions`(`id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "skill_acquisition_revisions_positive_revision" CHECK("skill_acquisition_revisions"."revision" > 0),
	CONSTRAINT "skill_acquisition_revisions_valid_character" CHECK(json_valid("skill_acquisition_revisions"."character_json")),
	CONSTRAINT "skill_acquisition_revisions_valid_eligibility" CHECK(json_valid("skill_acquisition_revisions"."eligibility_json")),
	CONSTRAINT "skill_acquisition_revisions_valid_learned" CHECK(json_valid("skill_acquisition_revisions"."learned_json"))
) STRICT;
--> statement-breakpoint
CREATE TRIGGER skill_acquisition_revisions_no_update BEFORE UPDATE ON skill_acquisition_revisions BEGIN
  SELECT RAISE(ABORT, 'skill acquisition revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER skill_acquisition_revisions_no_delete BEFORE DELETE ON skill_acquisition_revisions BEGIN
  SELECT RAISE(ABORT, 'skill acquisition revisions cannot be deleted');
END;
