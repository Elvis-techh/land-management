--
-- One contract's own mora rule («Regla propia» or «Sin mora»), as a history:
-- each version in force from the day after it was saved, one per contract and
-- day. Back to the general rule is one more version. See `moraContractRules`
-- in src/db/schema.ts and `contractHistory` in src/lib/mora.ts.
--
CREATE TABLE `mora_contract_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`mode` text NOT NULL,
	`value` text,
	`reason` text NOT NULL,
	`recorded_by` text NOT NULL,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mora_contract_rules_contract_day_unique` ON `mora_contract_rules` (`contract_id`,`effective_from`);