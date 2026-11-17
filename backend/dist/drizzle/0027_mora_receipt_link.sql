--
-- The receipt a «Cargar mora» or a «Perdonar» was entered with, when it came
-- from «Registrar un pago» (the mora changed with that payment). Null for the
-- ones entered on the contract, which is every row before this. Voiding the
-- receipt removes them too. See `moraManualCharges` in src/db/schema.ts.
--
ALTER TABLE `mora_forgiveness` ADD `receipt_id` text REFERENCES receipts(id);--> statement-breakpoint
ALTER TABLE `mora_manual_charges` ADD `receipt_id` text REFERENCES receipts(id);