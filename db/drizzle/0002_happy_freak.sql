CREATE TABLE `attempt_metrics` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`progress_step` integer DEFAULT 0 NOT NULL,
	`metrics_json` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `simulation_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_progress" CHECK("attempt_metrics"."progress_step" BETWEEN 0 AND 6000),
	CONSTRAINT "attempt_metrics_json" CHECK("attempt_metrics"."metrics_json" IS NULL OR json_valid("attempt_metrics"."metrics_json"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `runtime_owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`artifact_root` text NOT NULL,
	`hostname` text NOT NULL,
	`pid` integer NOT NULL,
	`token` text NOT NULL,
	CONSTRAINT "runtime_singleton" CHECK("runtime_owner"."id" = 1)
) STRICT;
