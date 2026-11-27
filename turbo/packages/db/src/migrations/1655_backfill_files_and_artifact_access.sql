-- okou:non-transactional
-- Bounded UUID-batched backfill for files, artifacts.visibility, artifacts.category,
-- and artifact_user_shares, followed by non-blocking constraint validation and
-- concurrent index build on artifacts.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
-- 1. Idempotent same-UUID backfill of real binary files from run_uploaded_files into files.
-- Excludes hosted-site placeholder pseudo-rows and guarantees non-empty org_id.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		ruf."id",
		ruf."external_id",
		ruf."org_id",
		ruf."chat_thread_id",
		ruf."run_id",
		ruf."user_id",
		ruf."url",
		ruf."storage_key",
		ruf."filename",
		ruf."content_type",
		ruf."size_bytes",
		ruf."checksum_sha256",
		ruf."classification",
		ruf."metadata",
		ruf."created_at",
		ruf."deleted_at"
	FROM "run_uploaded_files" ruf
	WHERE ($1::uuid IS NULL OR ruf."id" > $1::uuid)
	ORDER BY ruf."id"
	LIMIT 1000
),
resolved AS (
	SELECT
		ruf."id",
		COALESCE(
			NULLIF(ruf."org_id", ''),
			NULLIF(ct."org_id", ''),
			NULLIF(ar."org_id", ''),
			NULLIF(art."org_id", '')
		) AS "resolved_org_id",
		ruf."user_id",
		COALESCE(
			NULLIF(ruf."storage_key", ''),
			NULLIF(ruf."metadata"->>'s3Key', '')
		) AS "storage_key",
		ruf."filename",
		ruf."content_type",
		ruf."size_bytes",
		ruf."checksum_sha256",
		CASE
			WHEN ruf."metadata"->>'purpose' IN ('hosted-preview', 'browser-screenshot', 'marketing-handoff')
				OR (
					ruf."url" IS NULL
					AND ruf."storage_key" LIKE 'private-artifacts/%'
					AND ruf."classification" IS NULL
				)
				THEN 'system'
			WHEN ruf."classification" = 'input'
				OR (
					ruf."run_id" IS NULL
					AND ruf."classification" IS DISTINCT FROM 'published-output'
				)
				THEN 'user'
			ELSE 'agent'
		END AS "origin",
		ruf."created_at",
		ruf."deleted_at"
	FROM batch ruf
	LEFT JOIN "chat_threads" ct ON ct."id" = ruf."chat_thread_id"
	LEFT JOIN "agent_runs" ar ON ar."id" = ruf."run_id"
	LEFT JOIN LATERAL (
		SELECT a."org_id"
		FROM "artifacts" a
		WHERE a."projection_file_id" = ruf."id"
		LIMIT 1
	) art ON true
	WHERE NOT (ruf."metadata" ? 'siteId')
		AND COALESCE(ruf."metadata"->>'generatedBy', '') <> 'zero-official-website'
		AND NOT (
			NULLIF(ruf."storage_key", '') IS NULL
			AND EXISTS (
				SELECT 1
				FROM "run_uploaded_files" real_file
				WHERE real_file."id" = CASE
						WHEN ruf."external_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
						THEN ruf."external_id"::uuid
						ELSE NULL
					END
					AND real_file."id" <> ruf."id"
					AND NULLIF(real_file."storage_key", '') IS NOT NULL
			)
		)
),
inserted AS (
	INSERT INTO "files" (
		"id",
		"org_id",
		"owner_user_id",
		"storage_key",
		"filename",
		"content_type",
		"size_bytes",
		"checksum_sha256",
		"origin",
		"created_at",
		"deleted_at"
	)
	SELECT
		resolved."id",
		resolved."resolved_org_id",
		resolved."user_id",
		resolved."storage_key",
		resolved."filename",
		resolved."content_type",
		resolved."size_bytes",
		resolved."checksum_sha256",
		resolved."origin",
		resolved."created_at",
		resolved."deleted_at"
	FROM resolved
	WHERE resolved."resolved_org_id" IS NOT NULL
	ON CONFLICT ("id") DO NOTHING
	RETURNING "id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 2a. Backfill artifacts.visibility from hosted_site_visibility for site-backed artifacts.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT hsv."site_id", hsv."visibility"
	FROM "hosted_site_visibility" hsv
	WHERE ($1::uuid IS NULL OR hsv."site_id" > $1::uuid)
	ORDER BY hsv."site_id"
	LIMIT 1000
),
updated AS (
	UPDATE "artifacts" a
	SET "visibility" = batch."visibility"
	FROM batch
	WHERE a."visibility" = 'private'
		AND batch."visibility" <> 'private'
		AND (
			(a."kind" = 'hosted-site' AND a."entity_id" = batch."site_id")
			OR (
				a."kind" = 'presentation'
				AND EXISTS (
					SELECT 1
					FROM "presentation_artifacts" pa
					WHERE pa."id" = a."entity_id"
						AND pa."hosted_site_id" = batch."site_id"
				)
			)
			OR a."logical_key" = 'site:' || batch."site_id"::text
		)
	RETURNING a."id"
)
SELECT (SELECT "site_id" FROM batch ORDER BY "site_id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 2b. Backfill artifacts.visibility = 'public' for non-deleted published hosted sites
-- that have no hosted_site_visibility row (matching hosted-site-access.service.ts default).
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT hs."id", hs."active_deployment_id", hs."deleted_at"
	FROM "hosted_sites" hs
	WHERE ($1::uuid IS NULL OR hs."id" > $1::uuid)
	ORDER BY hs."id"
	LIMIT 1000
),
eligible AS (
	SELECT batch."id" AS "site_id"
	FROM batch
	WHERE batch."deleted_at" IS NULL
		AND EXISTS (
			SELECT 1
			FROM "hosted_deployments" hd
			WHERE hd."id" = batch."active_deployment_id"
				AND hd."site_id" = batch."id"
				AND hd."status" = 'ready'
				AND NOT (hd."manifest" ? 'access')
		)
		AND NOT EXISTS (
			SELECT 1
			FROM "hosted_site_visibility" hsv
			WHERE hsv."site_id" = batch."id"
		)
),
updated AS (
	UPDATE "artifacts" a
	SET "visibility" = 'public'
	FROM eligible
	WHERE a."visibility" = 'private'
		AND (
			(a."kind" = 'hosted-site' AND a."entity_id" = eligible."site_id")
			OR (
				a."kind" = 'presentation'
				AND EXISTS (
					SELECT 1
					FROM "presentation_artifacts" pa
					WHERE pa."id" = a."entity_id"
						AND pa."hosted_site_id" = eligible."site_id"
				)
			)
			OR a."logical_key" = 'site:' || eligible."site_id"::text
		)
	RETURNING a."id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 3. Backfill artifacts.category for single-table Library catalog queries.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT
		art."id",
		art."kind",
		art."display_kind",
		art."entity_id",
		art."logical_key",
		art."projection_file_id",
		art."title"
	FROM "artifacts" art
	WHERE ($1::uuid IS NULL OR art."id" > $1::uuid)
		AND art."category" IS NULL
	ORDER BY art."id"
	LIMIT 1000
),
computed AS (
	SELECT
		art."id",
		CASE
			WHEN effective."effective_kind" IN ('avatar', 'shared-thread') THEN 'other'
			WHEN effective."effective_kind" = 'presentation' THEN 'presentation'
			WHEN effective."effective_kind" = 'hosted-site' THEN 'website'
			WHEN effective."effective_kind" = 'image' THEN 'image'
			WHEN effective."effective_kind" = 'video' THEN 'video'
			WHEN effective."ct" LIKE 'image/%'
				OR effective."fname" ~ '[.](avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$'
				THEN 'image'
			WHEN effective."ct" LIKE 'video/%'
				OR effective."fname" ~ '[.](avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$'
				THEN 'video'
			WHEN effective."ct" LIKE 'audio/%'
				OR effective."fname" ~ '[.](aac|aiff?|flac|m4a|mp3|mpga|oga|ogg|opus|wav|wma)$'
				THEN 'audio'
			WHEN effective."ct" LIKE 'application/vnd.ms-powerpoint%'
				OR effective."ct" LIKE 'application/vnd.openxmlformats-officedocument.presentationml.%'
				OR effective."ct" LIKE 'application/vnd.oasis.opendocument.presentation%'
				OR effective."fname" ~ '[.](odp|pot|potm|potx|pps|ppsm|ppsx|ppt|pptm|pptx)$'
				THEN 'presentation'
			WHEN effective."ct" IN ('text/csv', 'text/tab-separated-values')
				OR effective."ct" LIKE 'application/vnd.ms-excel%'
				OR effective."ct" LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml.%'
				OR effective."ct" LIKE 'application/vnd.oasis.opendocument.spreadsheet%'
				OR effective."fname" ~ '[.](csv|numbers|ods|tsv|xls|xlsb|xlsm|xlsx|xlt|xltm|xltx)$'
				THEN 'spreadsheet'
			WHEN effective."ct" IN ('text/html', 'application/xhtml+xml')
				OR effective."fname" ~ '[.](html?|xhtml)$'
				THEN 'website'
			WHEN effective."ct" LIKE 'text/%'
				OR effective."ct" IN (
					'application/pdf',
					'application/msword',
					'application/rtf',
					'application/json',
					'application/xml',
					'application/yaml',
					'application/x-yaml'
				)
				OR effective."ct" LIKE 'application/vnd.ms-word%'
				OR effective."ct" LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml.%'
				OR effective."ct" LIKE 'application/vnd.oasis.opendocument.text%'
				OR effective."fname" ~ '[.](doc|docm|docx|dot|dotm|dotx|json|markdown|md|odt|pdf|rtf|txt|xml|ya?ml)$'
				THEN 'document'
			ELSE 'other'
		END AS "category"
	FROM batch art
	LEFT JOIN "run_uploaded_files" ruf
		ON ruf."id" = COALESCE(art."projection_file_id", CASE WHEN art."kind" = 'file' THEN art."entity_id" ELSE NULL END)
	CROSS JOIN LATERAL (
		SELECT
			CASE
				WHEN art."kind" = 'file'
					AND art."logical_key" NOT LIKE 'shared-thread:%'
					AND lower(art."title") LIKE '%.pptx'
					THEN 'presentation'
				ELSE COALESCE(
					art."display_kind",
					CASE
						WHEN art."kind" = 'file' AND art."logical_key" LIKE 'shared-thread:%'
							THEN 'shared-thread'
						ELSE art."kind"
					END
				)
			END AS "effective_kind",
			lower(trim(split_part(COALESCE(ruf."content_type", ''), ';', 1))) AS "ct",
			lower(COALESCE(ruf."filename", ruf."external_id", art."title", '')) AS "fname"
	) effective
),
updated AS (
	UPDATE "artifacts" a
	SET "category" = computed."category"
	FROM computed
	WHERE a."id" = computed."id"
		AND a."category" IS NULL
	RETURNING a."id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 4. Backfill claimed per-user file shares into artifact_user_shares.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT afs."id", afs."file_id", afs."email", afs."user_id", afs."created_at"
	FROM "artifact_file_shares" afs
	WHERE ($1::uuid IS NULL OR afs."id" > $1::uuid)
	ORDER BY afs."id"
	LIMIT 1000
),
inserted AS (
	INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
	SELECT
		afs."user_id",
		a."org_id",
		a."id",
		afs."email",
		afs."created_at"
	FROM batch afs
	INNER JOIN "artifacts" a
		ON a."deleted_at" IS NULL
		AND (
			a."projection_file_id" = afs."file_id"
			OR (a."kind" = 'file' AND a."entity_id" = afs."file_id")
			OR (
				a."kind" = 'image'
				AND EXISTS (
					SELECT 1
					FROM "image_artifacts" ia
					WHERE ia."id" = a."entity_id"
						AND ia."file_id" = afs."file_id"
				)
			)
		)
	WHERE afs."user_id" IS NOT NULL
	ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 5. Backfill claimed per-user hosted-site shares into artifact_user_shares.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
	SELECT hss."id", hss."site_id", hss."email", hss."user_id", hss."created_at"
	FROM "hosted_site_shares" hss
	WHERE ($1::uuid IS NULL OR hss."id" > $1::uuid)
	ORDER BY hss."id"
	LIMIT 1000
),
inserted AS (
	INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
	SELECT
		hss."user_id",
		a."org_id",
		a."id",
		hss."email",
		hss."created_at"
	FROM batch hss
	INNER JOIN "artifacts" a
		ON a."deleted_at" IS NULL
		AND (
			(a."kind" = 'hosted-site' AND a."entity_id" = hss."site_id")
			OR (
				a."kind" = 'presentation'
				AND EXISTS (
					SELECT 1
					FROM "presentation_artifacts" pa
					WHERE pa."id" = a."entity_id"
						AND pa."hosted_site_id" = hss."site_id"
				)
			)
			OR a."logical_key" = 'site:' || hss."site_id"::text
		)
	WHERE hss."user_id" IS NOT NULL
	ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING
	RETURNING "artifact_id"
)
SELECT (SELECT "id" FROM batch ORDER BY "id" DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- 6. Validate artifacts.visibility CHECK under SHARE UPDATE EXCLUSIVE and build
-- the catalog index concurrently after backfill completes.
SET statement_timeout = '10min';
--> statement-breakpoint
ALTER TABLE "artifacts" VALIDATE CONSTRAINT "artifacts_visibility_check";
--> statement-breakpoint
-- Recover even when an interrupted concurrent build left an invalid index.
DROP INDEX CONCURRENTLY IF EXISTS "artifacts_author_category_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "artifacts_author_category_created_idx" ON "artifacts" USING btree ("org_id","author_user_id","category","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "artifacts"."deleted_at" IS NULL;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
