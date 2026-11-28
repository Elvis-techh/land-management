CREATE TABLE `contract_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`returned_on` text,
	`method` text,
	`reference` text,
	`returned_by` text,
	`returned_at` text,
	`removed_at` text,
	`removed_by` text,
	`removal_reason` text,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`returned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contract_refunds_contract_idx` ON `contract_refunds` (`contract_id`);--> statement-breakpoint
ALTER TABLE `payments` ADD `transferred_from_contract_id` text REFERENCES contracts(id);--> statement-breakpoint
CREATE INDEX `payments_transferred_from_idx` ON `payments` (`transferred_from_contract_id`);