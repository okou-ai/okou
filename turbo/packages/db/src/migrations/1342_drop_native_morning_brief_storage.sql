-- Native readers and writers were retired and drained before this contraction.
-- Drop children first; unexpected dependencies must abort the transaction.
-- Anonymous platform cost receipts and Official workflow/chat/email state remain.
DROP TABLE "morning_brief_native_schedule_skips";--> statement-breakpoint
DROP TABLE "morning_brief_native_occurrences";--> statement-breakpoint
DROP TABLE "morning_brief_native_schedules";--> statement-breakpoint
DROP TABLE "morning_brief_deliveries";--> statement-breakpoint
DROP TABLE "morning_brief_generations";--> statement-breakpoint
DROP TABLE "morning_brief_collection_occurrences";--> statement-breakpoint
DROP TABLE "morning_brief_installed_preferences";
