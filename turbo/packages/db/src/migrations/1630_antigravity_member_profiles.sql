CREATE TABLE "antigravity_member_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "antigravity_member_profiles_machine_id_unique" UNIQUE("machine_id"),
	CONSTRAINT "antigravity_member_profiles_org_id_user_id_unique" UNIQUE("org_id","user_id")
);
