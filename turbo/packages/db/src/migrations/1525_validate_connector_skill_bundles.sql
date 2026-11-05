-- 1524 commits nullable columns and immediately enforced NOT VALID checks first.
-- Validate historical rows under SHARE UPDATE EXCLUSIVE instead of retaining
-- the preparation transaction's ACCESS EXCLUSIVE locks through a heap scan.
-- The production-clone scan exceeded 10s; bound only this online validation.
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
ALTER TABLE "connector_catalog_entries"
  VALIDATE CONSTRAINT "connector_catalog_entries_skill_content_bundle_check";
--> statement-breakpoint
ALTER TABLE "org_custom_connectors"
  VALIDATE CONSTRAINT "org_custom_connectors_skill_content_bundle_check";
