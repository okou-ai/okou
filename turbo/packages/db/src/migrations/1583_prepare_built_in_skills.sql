CREATE TABLE "built_in_skills" (
	"url" text PRIMARY KEY NOT NULL,
	"version_hash" varchar(64) NOT NULL,
	"content_bundle" jsonb NOT NULL,
	"content_bundle_source_version_hash" varchar(64) NOT NULL,
	"commit_sha" varchar(40),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	CONSTRAINT "built_in_skills_bundle_version_check" CHECK ("built_in_skills"."version_hash" ~ '^[0-9a-f]{64}$'
        AND "built_in_skills"."content_bundle_source_version_hash" = "built_in_skills"."version_hash")
);
--> statement-breakpoint
INSERT INTO "built_in_skills" (
  "url", "version_hash", "content_bundle", "content_bundle_source_version_hash",
  "commit_sha", "updated_at"
)
SELECT "url", "version_hash", "content_bundle", "content_bundle_source_version_hash",
  "commit_sha", "updated_at"
FROM "skills"
WHERE "url" IN (
  'https://github.com/okou-ai/okou-skills/tree/main/computer-use',
  'https://github.com/okou-ai/okou-skills/tree/main/gen',
  'https://github.com/okou-ai/okou-skills/tree/main/workflow-setup'
)
  AND "content_bundle" IS NOT NULL
  AND "content_bundle_source_version_hash" = "version_hash"
ON CONFLICT ("url") DO NOTHING;
