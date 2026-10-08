-- #24941 removed the GitHub direct-chat ingress, the only writer of both tables,
-- and #37079 removed their readers. No table references them; dropping them
-- only removes their own foreign keys to chat_threads and github_installations.
DROP TABLE "chat_github_context";--> statement-breakpoint
DROP TABLE "github_chat_thread_routes";
