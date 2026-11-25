CREATE TABLE `user_capabilities` (
	`user_id` text NOT NULL,
	`capability` text NOT NULL,
	`enabled` integer NOT NULL,
	`granted_by` text,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_capabilities_unique` ON `user_capabilities` (`user_id`,`capability`);