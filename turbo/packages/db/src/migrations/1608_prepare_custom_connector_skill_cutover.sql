-- Preserve the view identity and grants used by API 2.100.1.
CREATE OR REPLACE VIEW "public"."org_custom_connector_skill_publications" WITH (security_invoker = true) AS (select "id", "org_id", "skill_content_bundle", "skill_content_bundle_source_version_id" from "org_custom_connectors" where "org_custom_connectors"."skill_content_bundle_source_version_id" is not null);--> statement-breakpoint
-- Abort the cutover if an outgoing writer left an unverified publication.
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_custom_connector_skill_cutover_sources" CHECK ("skill_storage_version_id" IS NOT DISTINCT FROM "skill_content_bundle_source_version_id");--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_org_custom_connectors_skill_version_pair";--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "chk_org_custom_connectors_skill_publication_pair" CHECK (("org_custom_connectors"."skill_markdown" IS NULL) = ("org_custom_connectors"."skill_content_bundle_source_version_id" IS NULL));--> statement-breakpoint
ALTER TABLE "org_custom_connectors" DROP CONSTRAINT "chk_custom_connector_skill_cutover_sources";
