CREATE TABLE `account_emails` (
	`email` text PRIMARY KEY NOT NULL,
	`company_id` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_emails_company_idx` ON `account_emails` (`company_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
