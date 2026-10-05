CREATE TABLE "connector_catalog" (
	"schema_version" integer PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"activated_at" timestamp NOT NULL,
	"catalog_version" text,
	"catalog_header" jsonb NOT NULL,
	"entry_slugs" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_catalog_entries" (
	"hash" text NOT NULL,
	"slug" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "connector_catalog_entries_hash_slug_pk" PRIMARY KEY("hash","slug")
);
