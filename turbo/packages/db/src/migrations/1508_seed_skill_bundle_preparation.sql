ALTER TABLE "skills" ADD COLUMN "content_bundle" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "content_bundle_source_version_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_content_bundle_check" CHECK ((
          ("skills"."content_bundle" IS NULL AND "skills"."content_bundle_source_version_hash" IS NULL)
          OR (
            "skills"."content_bundle" IS NOT NULL
            AND "skills"."content_bundle_source_version_hash" IS NOT NULL
            AND "skills"."content_bundle_source_version_hash" ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof("skills"."content_bundle") = 'object'
            AND "skills"."content_bundle" ?& ARRAY['sha256', 'archiveBytes']
            AND ("skills"."content_bundle" - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof("skills"."content_bundle"->'sha256') = 'string'
            AND "skills"."content_bundle"->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof("skills"."content_bundle"->'archiveBytes') = 'number'
              THEN ("skills"."content_bundle"->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc(("skills"."content_bundle"->>'archiveBytes')::numeric) = ("skills"."content_bundle"->>'archiveBytes')::numeric
              ELSE false
            END
          )
        ));