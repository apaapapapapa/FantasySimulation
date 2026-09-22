CREATE TABLE `battle_results` (
	`id` text PRIMARY KEY NOT NULL,
	`simulation_hash` text NOT NULL,
	`canonical_hash` text,
	`attempt_id` text NOT NULL,
	`result_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`replay_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`simulation_hash`) REFERENCES `battle_specs`(`simulation_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `simulation_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "result_json" CHECK(json_valid("battle_results"."result_json"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `result_canonical` ON `battle_results` (`canonical_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `result_attempt` ON `battle_results` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `replay_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`manifest_checksum` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `simulation_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifact_state" CHECK("replay_artifacts"."state" IN ('ready','missing','corrupt','quarantined')),
	CONSTRAINT "artifact_bytes" CHECK("replay_artifacts"."bytes" > 0 AND "replay_artifacts"."bytes" <= 20971520)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_attempt` ON `replay_artifacts` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `simulation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`number` integer NOT NULL,
	`token` text NOT NULL,
	`state` text NOT NULL,
	`budget_json` text NOT NULL,
	`lease_until` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`replay_id` text,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `simulation_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_state" CHECK("simulation_attempts"."state" IN ('running','completed','failed','cancelled','expired','conflict')),
	CONSTRAINT "attempt_budget_json" CHECK(json_valid("simulation_attempts"."budget_json"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_number` ON `simulation_attempts` (`job_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_token` ON `simulation_attempts` (`token`);--> statement-breakpoint
CREATE INDEX `attempt_lease` ON `simulation_attempts` (`state`,`lease_until`);--> statement-breakpoint
CREATE TABLE `simulation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`simulation_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`budget_json` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`current_attempt_id` text,
	`result_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`simulation_hash`) REFERENCES `battle_specs`(`simulation_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_state" CHECK("simulation_jobs"."state" IN ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "job_attempt_limit" CHECK("simulation_jobs"."attempts" >= 0 AND "simulation_jobs"."attempts" <= "simulation_jobs"."max_attempts" AND "simulation_jobs"."max_attempts" BETWEEN 1 AND 3),
	CONSTRAINT "job_budget_json" CHECK(json_valid("simulation_jobs"."budget_json"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `job_idempotency` ON `simulation_jobs` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `job_queue` ON `simulation_jobs` (`state`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER battle_results_no_update BEFORE UPDATE ON battle_results BEGIN SELECT RAISE(ABORT, 'battle results are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER battle_results_no_delete BEFORE DELETE ON battle_results BEGIN SELECT RAISE(ABORT, 'battle results cannot be deleted'); END;
