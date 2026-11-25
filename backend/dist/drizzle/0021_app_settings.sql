--
-- The Configuración screen: one row per section of settings (mora, contracts,
-- business details), as JSON. Empty until somebody saves; until then the
-- defaults in src/lib/settings.ts apply, which are the values that used to be
-- hardcoded. See `appSettings` in src/db/schema.ts.
--
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
