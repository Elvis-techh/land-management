--
-- The mora rules as a history: one row per version, in force from its own day.
-- A charge is worked out with the rules of the day it was made, so changing the
-- rules never rewrites a mora already charged. See `moraRules` in
-- src/db/schema.ts and src/lib/mora.ts.
--
CREATE TABLE `mora_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`effective_from` text NOT NULL,
	`value` text NOT NULL,
	`recorded_by` text,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mora_rules_effective_from_unique` ON `mora_rules` (`effective_from`);
--> statement-breakpoint
-- The rules already saved on the Configuración screen, if any, become the first
-- version, from the day they were saved. Nothing could have been charged before
-- that day anyway: «Desde» was today or later when they were saved, and only
-- cuotas falling due from «Desde» on carry mora.
INSERT INTO `mora_rules` (`id`, `effective_from`, `value`, `recorded_by`, `recorded_at`)
SELECT lower(hex(randomblob(16))), substr(`updated_at`, 1, 10), `value`, `updated_by`, `updated_at`
FROM `app_settings`
WHERE `key` = 'mora';