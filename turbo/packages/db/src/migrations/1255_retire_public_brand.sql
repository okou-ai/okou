ALTER TABLE "artifact_shares" RENAME COLUMN "public_brand" TO "link_layout_segment";--> statement-breakpoint
ALTER TABLE "hosted_deployments" RENAME COLUMN "public_brand" TO "link_layout_segment";--> statement-breakpoint
ALTER TABLE "hosted_sites" RENAME COLUMN "public_brand" TO "link_layout_segment";--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" RENAME COLUMN "public_brand" TO "link_layout_segment";--> statement-breakpoint
ALTER TABLE "shared_threads" RENAME COLUMN "public_brand" TO "link_layout_segment";--> statement-breakpoint
ALTER TABLE "hosted_sites" RENAME CONSTRAINT "idx_hosted_sites_id_public_brand" TO "idx_hosted_sites_id_link_layout_segment";--> statement-breakpoint
ALTER TABLE "hosted_deployments" RENAME CONSTRAINT "fk_hosted_deployments_site_public_brand" TO "fk_hosted_deployments_site_link_layout_segment";--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" RENAME CONSTRAINT "fk_private_hosted_deployments_site_public_brand" TO "fk_private_hosted_deployments_site_link_layout_segment";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_automation_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_discord_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_feishu_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_github_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_slack_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_teams_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "chat_telegram_context" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "discord_chat_ingress" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "export_jobs" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "feishu_org_connections" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "feishu_org_installations" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN "setup_public_brand";--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "slack_org_installations" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "socialkit_download_jobs" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "teams_org_installations" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "telegram_installations" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "telegram_official_user_links" DROP COLUMN "public_brand";--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" DROP COLUMN "public_brand";