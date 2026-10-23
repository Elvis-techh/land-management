--
-- Constancias de cancelación total: the document that says a paid-off contract
-- owes nothing. A new table only; nothing existing changes. See `constancias`
-- in src/db/schema.ts.
--
CREATE TABLE `constancias` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`code` text NOT NULL,
	`lookup_code` text NOT NULL,
	`contract_id` text NOT NULL,
	`issued_on` text NOT NULL,
	`issued_by` text NOT NULL,
	`voided_at` text,
	`void_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `constancias_number_unique` ON `constancias` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `constancias_code_unique` ON `constancias` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `constancias_lookup_code_unique` ON `constancias` (`lookup_code`);--> statement-breakpoint
CREATE INDEX `constancias_contract_idx` ON `constancias` (`contract_id`);