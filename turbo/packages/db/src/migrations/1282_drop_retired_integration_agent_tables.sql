-- Contract step for the release 7 integration cleanup (#37200). Release 7
-- stopped reading and writing the per-user integration agent preferences, the
-- Feishu/Lark installation default agent and the self-hosted Telegram bot
-- tables; every integration runs the org default agent and only the official
-- Telegram bot remains. The API rollback floor is release 7, so no rollback
-- target reads them.
--
-- Self-hosted Telegram rows in the shared route and message tables are removed
-- first: their owner columns and one-owner checks go away, and the official
-- owner becomes NOT NULL. Chat threads of retired routes remain as history.
-- The tables are then dropped leaf-first; no other table references them once
-- the owner columns are gone.
DELETE FROM "telegram_chat_thread_routes"
WHERE "telegram_user_link_id" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "telegram_messages"
WHERE "installation_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" DROP CONSTRAINT "chk_telegram_chat_thread_routes_one_owner";--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" DROP COLUMN "telegram_user_link_id";--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ALTER COLUMN "telegram_official_user_link_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_messages" DROP CONSTRAINT "chk_telegram_messages_one_owner";--> statement-breakpoint
ALTER TABLE "telegram_messages" DROP COLUMN "installation_id";--> statement-breakpoint
ALTER TABLE "telegram_messages" ALTER COLUMN "official_org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" DROP COLUMN "default_agent_id";--> statement-breakpoint
DROP TABLE "telegram_user_links";--> statement-breakpoint
DROP TABLE "telegram_installations";--> statement-breakpoint
DROP TABLE "agentphone_user_agent_preferences";--> statement-breakpoint
DROP TABLE "discord_user_agent_preferences";--> statement-breakpoint
DROP TABLE "feishu_platform_user_agent_preferences";--> statement-breakpoint
DROP TABLE "feishu_user_agent_preferences";--> statement-breakpoint
DROP TABLE "slack_user_agent_preferences";--> statement-breakpoint
DROP TABLE "teams_user_agent_preferences";--> statement-breakpoint
DROP TABLE "telegram_user_agent_preferences";
