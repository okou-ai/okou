-- okou:non-transactional
-- Existing writers already serialize one destination per asset/operation.
-- Build that business identity without blocking file-delivery writes. Until
-- this migration is journaled, the previous writer still owns that invariant.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- Retrying an interrupted build must not retain an invalid index.
DROP INDEX CONCURRENTLY IF EXISTS "canonical_asset_deliveries_asset_operation_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "canonical_asset_deliveries_asset_operation_unique" ON "canonical_asset_deliveries" USING btree ("asset_id","operation_id");
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
