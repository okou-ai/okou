CREATE TABLE "member_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"object_prefix" text NOT NULL,
	"content_size" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"head_version_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "member_memories_member_key" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memory_version_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"version_id" varchar(64) NOT NULL,
	"parent_version_id" varchar(64) NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"object_prefix" text NOT NULL,
	"content_size" bigint DEFAULT 0 NOT NULL,
	"archive_size" bigint NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_versions_memory_id_id_key" UNIQUE("memory_id","id"),
	CONSTRAINT "memory_versions_archive_size_nonnegative" CHECK ("memory_versions"."archive_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "member_memories" ADD CONSTRAINT "member_memories_head_owned_fk" FOREIGN KEY ("id","head_version_id") REFERENCES "public"."memory_versions"("memory_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_version_lineage" ADD CONSTRAINT "memory_version_lineage_memory_id_member_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."member_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_member_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."member_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_memories_org_idx" ON "member_memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memory_version_lineage_version_idx" ON "memory_version_lineage" USING btree ("memory_id","version_id");--> statement-breakpoint
CREATE INDEX "memory_version_lineage_parent_idx" ON "memory_version_lineage" USING btree ("memory_id","parent_version_id");--> statement-breakpoint
CREATE INDEX "memory_version_lineage_run_idx" ON "memory_version_lineage" USING btree ("run_id");