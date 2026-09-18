CREATE TABLE "feishu_platform_user_agent_preferences" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"platform" varchar(16) NOT NULL,
	"selected_agent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_platform_user_agent_preferences_pk" PRIMARY KEY("user_id","org_id","platform"),
	CONSTRAINT "chk_feishu_platform_user_agent_preferences_platform" CHECK ("feishu_platform_user_agent_preferences"."platform" IN ('feishu', 'lark'))
);
--> statement-breakpoint
ALTER TABLE "feishu_platform_user_agent_preferences" ADD CONSTRAINT "feishu_platform_user_agent_preferences_selected_agent_id_agents_id_fk" FOREIGN KEY ("selected_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;