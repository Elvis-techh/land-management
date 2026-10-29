--
-- «Perdonar»: mora forgiven on one cuota of one contract, with the day it was
-- entered and a reason. Replayed after the payments already entered that day;
-- removed by setting `removed_*`, never by deleting. See `moraForgiveness` in
-- src/db/schema.ts and src/lib/mora.ts.
--
CREATE TABLE `mora_forgiveness` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`installment` integer NOT NULL,
	`forgiven_on` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`recorded_by` text NOT NULL,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`removed_at` text,
	`removed_by` text,
	`removal_reason` text,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mora_forgiveness_contract_idx` ON `mora_forgiveness` (`contract_id`);
