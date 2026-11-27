SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
-- 1. Idempotent same-UUID backfill of real binary files from run_uploaded_files into files.
-- Excludes hosted-site placeholder pseudo-rows and guarantees non-empty org_id.
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
FROM (
	SELECT
		ruf."id",
		COALESCE(
			NULLIF(ruf."org_id", ''),
			NULLIF(ct."org_id", ''),
			NULLIF(ar."org_id", ''),
			NULLIF(art."org_id", '')
		) AS "resolved_org_id",
		ruf."user_id",
		ruf."storage_key",
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
	FROM "run_uploaded_files" ruf
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
) resolved
WHERE resolved."resolved_org_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- 2a. Backfill artifacts.visibility from hosted_site_visibility for site-backed artifacts.
UPDATE "artifacts" a
SET "visibility" = hsv."visibility"
FROM "hosted_site_visibility" hsv
WHERE a."visibility" = 'private'
	AND hsv."visibility" <> 'private'
	AND (
		(a."kind" = 'hosted-site' AND a."entity_id" = hsv."site_id")
		OR (
			a."kind" = 'presentation'
			AND EXISTS (
				SELECT 1
				FROM "presentation_artifacts" pa
				WHERE pa."id" = a."entity_id"
					AND pa."hosted_site_id" = hsv."site_id"
			)
		)
		OR a."logical_key" = 'site:' || hsv."site_id"::text
	);
--> statement-breakpoint
-- 2b. Backfill artifacts.visibility = 'public' for non-deleted published hosted sites
-- that have no hosted_site_visibility row (matching hosted-site-access.service.ts default).
UPDATE "artifacts" a
SET "visibility" = 'public'
FROM "hosted_sites" hs
WHERE a."visibility" = 'private'
	AND hs."deleted_at" IS NULL
	AND EXISTS (
		SELECT 1
		FROM "hosted_deployments" hd
		WHERE hd."id" = hs."active_deployment_id"
			AND hd."site_id" = hs."id"
			AND hd."status" = 'ready'
			AND NOT (hd."manifest" ? 'access')
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "hosted_site_visibility" hsv
		WHERE hsv."site_id" = hs."id"
	)
	AND (
		(a."kind" = 'hosted-site' AND a."entity_id" = hs."id")
		OR (
			a."kind" = 'presentation'
			AND EXISTS (
				SELECT 1
				FROM "presentation_artifacts" pa
				WHERE pa."id" = a."entity_id"
					AND pa."hosted_site_id" = hs."id"
			)
		)
		OR a."logical_key" = 'site:' || hs."id"::text
	);
--> statement-breakpoint
-- 3. Backfill artifacts.category for single-table Library catalog queries.
UPDATE "artifacts" a
SET "category" = computed."category"
FROM (
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
	FROM "artifacts" art
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
	WHERE art."category" IS NULL
) computed
WHERE a."id" = computed."id"
	AND a."category" IS NULL;
--> statement-breakpoint
-- 4. Backfill claimed per-user file shares into artifact_user_shares.
INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
SELECT
	afs."user_id",
	a."org_id",
	a."id",
	afs."email",
	afs."created_at"
FROM "artifact_file_shares" afs
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
ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING;
--> statement-breakpoint
-- 5. Backfill claimed per-user hosted-site shares into artifact_user_shares.
INSERT INTO "artifact_user_shares" ("user_id", "org_id", "artifact_id", "email", "created_at")
SELECT
	hss."user_id",
	a."org_id",
	a."id",
	hss."email",
	hss."created_at"
FROM "hosted_site_shares" hss
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
ON CONFLICT ("user_id", "org_id", "artifact_id") DO NOTHING;
