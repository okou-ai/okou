-- Release 7: the main direct-message conversation of each integration identity
-- maps to exactly one chat thread. Route keys used to embed the agent and model
-- ('direct-message:<agentId>:<model>[:priority]'), so one identity could own
-- several DM threads. Keep only the most recently used DM route per identity
-- (chat_threads.last_message_at), rewrite its key to the fixed constant
-- 'direct-message:main', and delete the other DM route rows. The chat threads
-- themselves are kept as history. DM reply threads, group chats, channels and
-- platform topics never use the 'direct-message:' prefix and are untouched.
-- Replays are no-ops: afterwards every identity has one 'direct-message:main'
-- route. Self-hosted Telegram (telegram_user_link_id) routes are left alone;
-- that integration is retired in the same release.
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."connection_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "slack_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."thread_ts" LIKE 'direct-message:%'
)
DELETE FROM "slack_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "slack_chat_thread_routes" AS "route"
SET "thread_ts" = 'direct-message:main'
WHERE "route"."thread_ts" LIKE 'direct-message:%'
  AND "route"."thread_ts" <> 'direct-message:main';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."connection_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "feishu_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."thread_id" LIKE 'direct-message:%'
)
DELETE FROM "feishu_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "feishu_chat_thread_routes" AS "route"
SET "thread_id" = 'direct-message:main'
WHERE "route"."thread_id" LIKE 'direct-message:%'
  AND "route"."thread_id" <> 'direct-message:main';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."connection_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "teams_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."thread_id" LIKE 'direct-message:%'
)
DELETE FROM "teams_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "teams_chat_thread_routes" AS "route"
SET "thread_id" = 'direct-message:main'
WHERE "route"."thread_id" LIKE 'direct-message:%'
  AND "route"."thread_id" <> 'direct-message:main';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."connection_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "discord_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."session_key" LIKE 'direct-message:%'
)
DELETE FROM "discord_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "discord_chat_thread_routes" AS "route"
SET "session_key" = 'direct-message:main'
WHERE "route"."session_key" LIKE 'direct-message:%'
  AND "route"."session_key" <> 'direct-message:main';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."telegram_official_user_link_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "telegram_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."root_message_id" LIKE 'direct-message:%'
      AND "route"."telegram_official_user_link_id" IS NOT NULL
)
DELETE FROM "telegram_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "telegram_chat_thread_routes" AS "route"
SET "root_message_id" = 'direct-message:main'
WHERE "route"."root_message_id" LIKE 'direct-message:%'
      AND "route"."telegram_official_user_link_id" IS NOT NULL
  AND "route"."root_message_id" <> 'direct-message:main';
--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "route"."id",
    row_number() OVER (
      PARTITION BY "route"."agentphone_user_link_id"
      ORDER BY "thread"."last_message_at" DESC, "route"."created_at" DESC, "route"."id" DESC
    ) AS "rank"
  FROM "agentphone_chat_thread_routes" AS "route"
  JOIN "chat_threads" AS "thread" ON "thread"."id" = "route"."chat_thread_id"
  WHERE "route"."root_message_id" LIKE 'direct-message:%'
)
DELETE FROM "agentphone_chat_thread_routes"
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);
--> statement-breakpoint
UPDATE "agentphone_chat_thread_routes" AS "route"
SET "root_message_id" = 'direct-message:main'
WHERE "route"."root_message_id" LIKE 'direct-message:%'
  AND "route"."root_message_id" <> 'direct-message:main';

--> statement-breakpoint
-- Installations remain physically compatible with outgoing API instances.
-- The organization default cannot change or be deleted; rebinding the retired
-- column prevents its existing ON DELETE CASCADE from following a former choice.
UPDATE "feishu_org_installations" AS "installation"
SET "default_agent_id" = "org"."default_agent_id"
FROM "org_metadata" AS "org"
WHERE "installation"."org_id" = "org"."org_id"
  AND "installation"."default_agent_id" IS DISTINCT FROM "org"."default_agent_id";
