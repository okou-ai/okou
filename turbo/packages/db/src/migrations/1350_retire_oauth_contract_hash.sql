ALTER TABLE "connector_account_oauth_bindings" DROP CONSTRAINT "fk_connector_oauth_binding_dcr_owner";--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" DROP CONSTRAINT "uq_connector_dcr_issuer";--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" DROP CONSTRAINT "uq_connector_dcr_owner";--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" DROP CONSTRAINT "chk_connector_oauth_binding_identity";--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" DROP CONSTRAINT "chk_connector_dcr_identity";--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" DROP COLUMN "contract_hash";--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" DROP COLUMN "contract_hash";--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" ADD CONSTRAINT "uq_connector_dcr_owner" UNIQUE("id","org_id","connector_slug","auth_method");--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" ADD CONSTRAINT "fk_connector_oauth_binding_dcr_owner" FOREIGN KEY ("dcr_registration_id","org_id","connector_slug","auth_method") REFERENCES "public"."connector_dcr_registrations"("id","org_id","connector_slug","auth_method") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connector_dcr_issuer" ON "connector_dcr_registrations" USING btree ("org_id","connector_slug","auth_method","issuer");--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" ADD CONSTRAINT "chk_connector_oauth_binding_identity" CHECK ("connector_account_oauth_bindings"."storage_version" > 0 AND btrim("connector_account_oauth_bindings"."endpoint") <> '' AND btrim("connector_account_oauth_bindings"."issuer") <> '' AND btrim("connector_account_oauth_bindings"."resource") <> '' AND btrim("connector_account_oauth_bindings"."token_endpoint") <> '' AND btrim("connector_account_oauth_bindings"."client_id") <> '');--> statement-breakpoint
ALTER TABLE "connector_dcr_registrations" ADD CONSTRAINT "chk_connector_dcr_identity" CHECK (btrim("connector_dcr_registrations"."issuer") <> '' AND btrim("connector_dcr_registrations"."client_id") <> '');--> statement-breakpoint
-- Authorization state is text, so guard JSON decoding without touching malformed
-- or unrelated provider contexts. Preserve every other field and account reference.
WITH contexts AS MATERIALIZED (
  SELECT "id", CASE WHEN "oauth_context" IS JSON OBJECT THEN "oauth_context"::jsonb END AS context
  FROM "connector_oauth_states"
)
UPDATE "connector_oauth_states" AS state
SET "oauth_context" = (contexts.context - 'contractHash')::text
FROM contexts
WHERE state."id" = contexts."id"
  AND contexts.context ->> 'kind' = 'connector-mcp-automatic'
  AND contexts.context ? 'contractHash';
