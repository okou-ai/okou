CREATE TYPE "public"."project_event_kind" AS ENUM('created', 'renamed', 'deleted');--> statement-breakpoint
CREATE TABLE "project_event_sequences" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"last_seq_id" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_event_sequences_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"seq_id" bigint NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_event_kind" NOT NULL,
	"name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_snapshots" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"latest_event_id" uuid,
	"latest_event_seq_id" bigint,
	"object_key" text,
	"content_digest" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_snapshots_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_user_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "project_events_user_org_seq_unique" ON "project_events" USING btree ("user_id","org_id","seq_id");--> statement-breakpoint
CREATE INDEX "project_events_project_idx" ON "project_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_user_org_created_idx" ON "projects" USING btree ("user_id","org_id","created_at","id");--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_project_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."projects"("id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;
