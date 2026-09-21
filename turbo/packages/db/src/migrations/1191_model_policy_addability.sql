CREATE TABLE "run_model_catalog" (
	"model" varchar(255) PRIMARY KEY NOT NULL,
	"allow_new_org_policy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES
	('claude-fable-5-1', true),
	('claude-opus-5', true),
	('claude-opus-4-8', true),
	('claude-sonnet-5', true),
	('claude-sonnet-4-6', true),
	('gpt-6-astra', true),
	('gpt-6-sol', false),
	('gpt-5.6-sol', true),
	('gpt-5.6-terra', true),
	('gpt-5.6-luna', true),
	('deepseek-v4.1-flash', true),
	('deepseek-v4-pro', true),
	('deepseek-v4-flash', true)
ON CONFLICT ("model") DO NOTHING;
