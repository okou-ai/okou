ALTER TABLE "org_members_metadata" ADD COLUMN "recent_workflow_ids" jsonb;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD CONSTRAINT "org_members_metadata_recent_workflow_ids_check" CHECK ("org_members_metadata"."recent_workflow_ids" IS NULL OR (
          jsonb_typeof("org_members_metadata"."recent_workflow_ids") = 'array'
          AND NOT jsonb_path_exists("org_members_metadata"."recent_workflow_ids", '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))')
        ));