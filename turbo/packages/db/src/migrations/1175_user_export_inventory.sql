CREATE TABLE "user_export_entries" (
	"job_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"path" text NOT NULL,
	"source_key" text NOT NULL,
	"size" bigint NOT NULL,
	"crc32" bigint DEFAULT 0 NOT NULL,
	"scanned_bytes" bigint DEFAULT 0 NOT NULL,
	"local_offset" bigint DEFAULT 0 NOT NULL,
	"central_offset" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_export_entries_job_id_ordinal_pk" PRIMARY KEY("job_id","ordinal"),
	CONSTRAINT "user_export_entries_ordinal_check" CHECK ("user_export_entries"."ordinal" >= 0),
	CONSTRAINT "user_export_entries_bytes_check" CHECK ("user_export_entries"."size" BETWEEN 0 AND 9007199254740991 AND
          "user_export_entries"."scanned_bytes" BETWEEN 0 AND "user_export_entries"."size" AND
          "user_export_entries"."local_offset" BETWEEN 0 AND 9007199254740991 AND
          "user_export_entries"."central_offset" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "user_export_entries_crc32_check" CHECK ("user_export_entries"."crc32" BETWEEN 0 AND 4294967295)
);
--> statement-breakpoint
CREATE TABLE "user_export_parts" (
	"job_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	CONSTRAINT "user_export_parts_job_id_part_number_pk" PRIMARY KEY("job_id","part_number"),
	CONSTRAINT "user_export_parts_number_check" CHECK ("user_export_parts"."part_number" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "user_export_entries" ADD CONSTRAINT "user_export_entries_job_id_export_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_export_parts" ADD CONSTRAINT "user_export_parts_job_id_export_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_export_entries_path" ON "user_export_entries" USING btree ("job_id","path");--> statement-breakpoint
CREATE INDEX "idx_user_export_entries_local_offset" ON "user_export_entries" USING btree ("job_id","local_offset");--> statement-breakpoint
CREATE INDEX "idx_user_export_entries_central_offset" ON "user_export_entries" USING btree ("job_id","central_offset");--> statement-breakpoint
CREATE INDEX "idx_user_export_entries_source_key" ON "user_export_entries" USING btree ("source_key");