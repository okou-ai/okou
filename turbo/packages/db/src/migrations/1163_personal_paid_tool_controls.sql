CREATE TABLE "user_disabled_paid_tools" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_disabled_paid_tools_org_id_user_id_tool_id_pk" PRIMARY KEY("org_id","user_id","tool_id")
);
--> statement-breakpoint
CREATE INDEX "idx_user_disabled_paid_tools_user_id" ON "user_disabled_paid_tools" USING btree ("user_id");