--
-- «Pagado por»: the name of whoever handed over the money when it was not the
-- customer. Printed on the receipt in place of the customer's name; the
-- contract and its balance stay the customer's. Null on every receipt issued
-- before this, which is what they were: paid by the customer. See
-- `receipts.paidBy` in src/db/schema.ts.
--
ALTER TABLE `receipts` ADD `paid_by` text;
