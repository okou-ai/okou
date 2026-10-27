CREATE TABLE "halloween_2026_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"captured_at" timestamp NOT NULL,
	"captured_by" text NOT NULL,
	"participants" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "halloween_2026_exposures" (
	"user_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "halloween_2026_reviews" (
	"user_id" text PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp DEFAULT now() NOT NULL,
	"notified_at" timestamp,
	"rewarded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "halloween_2026_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"questions" jsonb NOT NULL,
	"question_index" integer DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"selected_id" text,
	"outcome" text DEFAULT 'playing' NOT NULL,
	"user_id" text,
	"org_id" text,
	"email" text,
	"linked_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "halloween_2026_rounds_correct" CHECK ("halloween_2026_rounds"."correct" between 0 and 5),
	CONSTRAINT "halloween_2026_rounds_question_index" CHECK ("halloween_2026_rounds"."question_index" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "halloween_2026_reviews" ADD CONSTRAINT "halloween_2026_reviews_batch_id_halloween_2026_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."halloween_2026_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "halloween_2026_rounds_user" ON "halloween_2026_rounds" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "halloween_2026_rounds_interrupted" ON "halloween_2026_rounds" USING btree ("outcome","updated_at");