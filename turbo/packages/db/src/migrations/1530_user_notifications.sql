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
	CONSTRAINT "chk_user_notification_payload" CHECK ((
    jsonb_typeof("user_notifications"."payload") = 'object'
    AND "user_notifications"."payload"->>'type' = 'rich_text'
    AND jsonb_typeof("user_notifications"."payload"->'markdown') = 'string'
    AND length("user_notifications"."payload"->>'markdown') BETWEEN 1 AND 50000
    AND (NOT ("user_notifications"."payload" ? 'action') OR (
      jsonb_typeof("user_notifications"."payload"->'action') = 'object'
      AND jsonb_typeof("user_notifications"."payload"->'action'->'label') = 'string'
      AND length(trim("user_notifications"."payload"->'action'->>'label')) BETWEEN 1 AND 80
      AND jsonb_typeof("user_notifications"."payload"->'action'->'url') = 'string'
      AND "user_notifications"."payload"->'action'->>'url' ~ '^https://'
      AND length("user_notifications"."payload"->'action'->>'url') <= 2048
    ))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX "idx_user_notifications_inbox" ON "user_notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_notifications_unread" ON "user_notifications" USING btree ("user_id","created_at") WHERE "user_notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_notifications_delivery" ON "user_notifications" USING btree ("user_id","delivery_key");