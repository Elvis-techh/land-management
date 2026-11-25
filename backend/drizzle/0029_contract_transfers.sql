CREATE TABLE `contract_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`from_customer_id` text NOT NULL,
	`to_customer_id` text NOT NULL,
	`effective_on` text NOT NULL,
	`reason` text NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contract_transfers_contract_idx` ON `contract_transfers` (`contract_id`);