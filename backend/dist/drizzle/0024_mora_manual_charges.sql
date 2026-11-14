--
-- «Cargar mora»: mora put on one contract by hand, for one cuota, with the day
-- it was charged or agreed and a reason. Replayed beside the automatic mora;
-- removed by setting `removed_*`, never by deleting. See `moraManualCharges`
-- in src/db/schema.ts and src/lib/mora.ts.
--
CREATE TABLE `mora_manual_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`installment` integer NOT NULL,
	`incurred_on` text NOT NULL,
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
CREATE INDEX `mora_manual_charges_contract_idx` ON `mora_manual_charges` (`contract_id`);