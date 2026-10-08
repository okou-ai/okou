-- Connector catalog Release 2 contraction. Release 1 (#37820, #37861) moved
-- every business, runtime, App and staff reader onto the pointer and immutable
-- entries (hash, slug, payload). Its writer is the last API code that touches
-- the legacy stores dropped here, so this migration may only run after a
-- Release 1 API is serving production and every older API instance and
-- background task has drained. APIs built before this migration cannot be
-- rolled back to once it is applied; see docs/deployment-compatibility.md.
--
-- Drop dependents before their parents. The only foreign keys involving these
-- tables point from the legacy children to connector_catalog_sync_state (and
-- from runtime projections to their sets), so no CASCADE is needed; an
-- unexpected dependency fails the migration instead of being dropped silently.
DROP TABLE "connector_catalog_runtime_projections";--> statement-breakpoint
DROP TABLE "connector_catalog_runtime_projection_sets";--> statement-breakpoint
DROP TABLE "connector_catalog_compatibility_evaluation";--> statement-breakpoint
DROP TABLE "connector_catalog_active_snapshot";--> statement-breakpoint
DROP TABLE "connector_catalog_sync_state";--> statement-breakpoint
ALTER TABLE "connector_catalog" DROP COLUMN "activated_at";--> statement-breakpoint
ALTER TABLE "connector_catalog" DROP COLUMN "catalog_version";--> statement-breakpoint
ALTER TABLE "connector_catalog" DROP COLUMN "catalog_header";--> statement-breakpoint
ALTER TABLE "connector_catalog" DROP COLUMN "entry_slugs";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "auth_methods";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "firewall";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "storage_name";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "version_id";--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" DROP COLUMN "mcp_endpoint";
