-- Existing rows receive NULL pairs, which satisfy both checks. Enforce every
-- subsequent INSERT/UPDATE without scanning the catalog under ACCESS EXCLUSIVE.
-- Leave historical validation outside this bounded deployment transaction.
ALTER TABLE "connector_catalog_entries" ADD COLUMN "skill_content_bundle" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "skill_content_bundle_source_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "skill_content_bundle" jsonb;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD COLUMN "skill_content_bundle_source_version_id" varchar(64);--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD CONSTRAINT "connector_catalog_entries_skill_content_bundle_check" CHECK ((
          ("connector_catalog_entries"."skill_content_bundle" IS NULL AND "connector_catalog_entries"."skill_content_bundle_source_version_id" IS NULL)
          OR (
            "connector_catalog_entries"."skill_content_bundle" IS NOT NULL
            AND "connector_catalog_entries"."skill_content_bundle_source_version_id" IS NOT NULL
            AND "connector_catalog_entries"."skill_content_bundle_source_version_id" ~ '^[0-9a-f]{64}$'
            AND "connector_catalog_entries"."skill"->>'kind' = 'bundled'
            AND "connector_catalog_entries"."skill"->>'versionId' = "connector_catalog_entries"."skill_content_bundle_source_version_id"
            AND jsonb_typeof("connector_catalog_entries"."skill_content_bundle") = 'object'
            AND "connector_catalog_entries"."skill_content_bundle" ?& ARRAY['sha256', 'archiveBytes']
            AND ("connector_catalog_entries"."skill_content_bundle" - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof("connector_catalog_entries"."skill_content_bundle"->'sha256') = 'string'
            AND "connector_catalog_entries"."skill_content_bundle"->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof("connector_catalog_entries"."skill_content_bundle"->'archiveBytes') = 'number'
              THEN ("connector_catalog_entries"."skill_content_bundle"->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc(("connector_catalog_entries"."skill_content_bundle"->>'archiveBytes')::numeric) = ("connector_catalog_entries"."skill_content_bundle"->>'archiveBytes')::numeric
                AND "connector_catalog_entries"."skill_content_bundle"->>'archiveBytes' = "connector_catalog_entries"."skill"->>'archiveSize'
              ELSE false
            END
          )
        ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE "org_custom_connectors" ADD CONSTRAINT "org_custom_connectors_skill_content_bundle_check" CHECK ((
          ("org_custom_connectors"."skill_content_bundle" IS NULL AND "org_custom_connectors"."skill_content_bundle_source_version_id" IS NULL)
          OR (
            "org_custom_connectors"."skill_content_bundle" IS NOT NULL
            AND "org_custom_connectors"."skill_content_bundle_source_version_id" IS NOT NULL
            AND "org_custom_connectors"."skill_content_bundle_source_version_id" ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof("org_custom_connectors"."skill_content_bundle") = 'object'
            AND "org_custom_connectors"."skill_content_bundle" ?& ARRAY['sha256', 'archiveBytes']
            AND ("org_custom_connectors"."skill_content_bundle" - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof("org_custom_connectors"."skill_content_bundle"->'sha256') = 'string'
            AND "org_custom_connectors"."skill_content_bundle"->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof("org_custom_connectors"."skill_content_bundle"->'archiveBytes') = 'number'
              THEN ("org_custom_connectors"."skill_content_bundle"->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc(("org_custom_connectors"."skill_content_bundle"->>'archiveBytes')::numeric) = ("org_custom_connectors"."skill_content_bundle"->>'archiveBytes')::numeric
              ELSE false
            END
          )
        ) IS TRUE) NOT VALID;
