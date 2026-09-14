ALTER TABLE "morning_brief_enrollments" ADD COLUMN "workflow_id" uuid;
--> statement-breakpoint
-- Adopt one installation per enrollment: the one on the org's current default
-- Agent, otherwise the oldest. Installations that are not adopted stay in place
-- and keep running; they simply stop being the one the preference manages.
-- Idempotent through the IS NULL guard, and free of a table lock because no
-- reader consumes this column before the release that adds it.
WITH "adopted" AS (
	SELECT DISTINCT ON ("enrollment"."org_id", "enrollment"."user_id")
		"enrollment"."org_id" AS "org_id",
		"enrollment"."user_id" AS "user_id",
		"workflow"."id" AS "workflow_id"
	FROM "morning_brief_enrollments" AS "enrollment"
	INNER JOIN "workflows" AS "workflow"
		ON "workflow"."org_id" = "enrollment"."org_id"
		AND "workflow"."owner_user_id" = "enrollment"."user_id"
		AND "workflow"."visibility" = 'private'
		AND "workflow"."official_definition_name" = 'morning-brief'
	LEFT JOIN "org_metadata" AS "metadata"
		ON "metadata"."org_id" = "enrollment"."org_id"
	WHERE "enrollment"."workflow_id" IS NULL
	ORDER BY
		"enrollment"."org_id",
		"enrollment"."user_id",
		CASE
			WHEN "workflow"."agent_id" = "metadata"."default_agent_id" THEN 0
			ELSE 1
		END,
		"workflow"."created_at",
		"workflow"."id"
)
UPDATE "morning_brief_enrollments" AS "target"
SET "workflow_id" = "adopted"."workflow_id"
FROM "adopted"
WHERE "target"."org_id" = "adopted"."org_id"
	AND "target"."user_id" = "adopted"."user_id"
	AND "target"."workflow_id" IS NULL;
