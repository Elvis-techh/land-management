--
-- Combined constancias: one constancia can now speak for several contracts.
-- A new link table, and every constancia already issued gets its one row in
-- it, so the table alone says which constancias cover a contract. Nothing
-- existing is rewritten. See `constanciaContracts` in src/db/schema.ts.
--
CREATE TABLE `constancia_contracts` (
	`constancia_id` text NOT NULL,
	`contract_id` text NOT NULL,
	FOREIGN KEY (`constancia_id`) REFERENCES `constancias`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `constancia_contracts_unique` ON `constancia_contracts` (`constancia_id`,`contract_id`);--> statement-breakpoint
CREATE INDEX `constancia_contracts_contract_idx` ON `constancia_contracts` (`contract_id`);--> statement-breakpoint
INSERT INTO `constancia_contracts` (`constancia_id`, `contract_id`)
SELECT `id`, `contract_id` FROM `constancias`;
