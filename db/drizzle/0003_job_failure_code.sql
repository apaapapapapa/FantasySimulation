ALTER TABLE `simulation_jobs` ADD `failure_code` text;
--> statement-breakpoint
-- Preserve the previous retry prohibition while moving its authority out of display text.
UPDATE `simulation_jobs` SET `failure_code` = 'determinism-violation'
WHERE `error` = 'Determinism violation';
