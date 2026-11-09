CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_key" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp (3) with time zone,
	CONSTRAINT "chk_user_notification_title" CHECK (length(trim("user_notifications"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "chk_user_notification_summary" CHECK (length("user_notifications"."summary") <= 500),
	CONSTRAINT "chk_user_notification_payload" CHECK ((jsonb_typeof("user_notifications"."payload") = 'object' AND CASE
    WHEN "user_notifications"."payload"->>'type' = 'rich_text' THEN (
      jsonb_typeof("user_notifications"."payload"->'markdown') = 'string'
      AND length("user_notifications"."payload"->>'markdown') BETWEEN 1 AND 50000
    )
    WHEN "user_notifications"."payload"->>'type' = 'carousel' AND jsonb_typeof("user_notifications"."payload"->'pages') = 'array' THEN (
      jsonb_array_length("user_notifications"."payload"->'pages') BETWEEN 2 AND 10
      AND (("user_notifications"."payload"->'pages'->0) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->0)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->0)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->0)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->1) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->1)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->1)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->1)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->2) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->2)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->2)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->2)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->3) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->3)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->3)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->3)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->4) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->4)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->4)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->4)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->5) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->5)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->5)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->5)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->6) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->6)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->6)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->6)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->7) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->7)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->7)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->7)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->8) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->8)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->8)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->8)->>'markdown') BETWEEN 1 AND 50000
    )) AND (("user_notifications"."payload"->'pages'->9) IS NULL OR (
      jsonb_typeof(("user_notifications"."payload"->'pages'->9)) = 'object'
      AND jsonb_typeof(("user_notifications"."payload"->'pages'->9)->'markdown') = 'string'
      AND length(("user_notifications"."payload"->'pages'->9)->>'markdown') BETWEEN 1 AND 50000
    ))
    )
    ELSE false END) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX "idx_user_notifications_inbox" ON "user_notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_notifications_unread" ON "user_notifications" USING btree ("user_id","created_at") WHERE "user_notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_notifications_delivery" ON "user_notifications" USING btree ("user_id","delivery_key");