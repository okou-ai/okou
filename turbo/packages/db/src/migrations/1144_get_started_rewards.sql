CREATE TABLE "get_started_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"beneficiary_user_id" text,
	"quest_key" varchar(20) NOT NULL,
	"source_key" text NOT NULL,
	"reward_key" text,
	"reward_slot" integer,
	"reward_target" varchar(8) NOT NULL,
	"reward_amount" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"invitation_id" text,
	"invitee_user_id" text,
	"source_event_id" uuid,
	"run_id" uuid,
	"workflow_id" uuid,
	"post_url" text,
	"evidence_text" text,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"member_credit_grant_id" uuid,
	"org_credit_record_id" uuid,
	"completed_at" timestamp,
	"reviewed_at" timestamp,
	"granted_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "get_started_quest_check" CHECK ("get_started_claims"."quest_key" IN ('connector', 'slack', 'workflow', 'invite', 'share', 'checkin')),
	CONSTRAINT "get_started_status_check" CHECK ("get_started_claims"."status" IN ('pending', 'reviewing', 'granted', 'rejected', 'ineligible')),
	CONSTRAINT "get_started_target_check" CHECK (("get_started_claims"."quest_key" = 'slack' AND "get_started_claims"."reward_target" = 'org' AND "get_started_claims"."beneficiary_user_id" IS NULL) OR ("get_started_claims"."quest_key" <> 'slack' AND "get_started_claims"."reward_target" = 'user' AND "get_started_claims"."beneficiary_user_id" IS NOT NULL)),
	CONSTRAINT "get_started_grant_check" CHECK (("get_started_claims"."status" = 'granted' AND "get_started_claims"."reward_key" IS NOT NULL AND "get_started_claims"."granted_at" IS NOT NULL AND "get_started_claims"."expires_at" IS NOT NULL AND "get_started_claims"."expires_at" = "get_started_claims"."granted_at" + interval '168 hours' AND (("get_started_claims"."reward_target" = 'user' AND "get_started_claims"."member_credit_grant_id" IS NOT NULL AND "get_started_claims"."org_credit_record_id" IS NULL) OR ("get_started_claims"."reward_target" = 'org' AND "get_started_claims"."org_credit_record_id" IS NOT NULL AND "get_started_claims"."member_credit_grant_id" IS NULL))) OR ("get_started_claims"."status" <> 'granted' AND "get_started_claims"."reward_key" IS NULL AND "get_started_claims"."granted_at" IS NULL AND "get_started_claims"."expires_at" IS NULL AND "get_started_claims"."member_credit_grant_id" IS NULL AND "get_started_claims"."org_credit_record_id" IS NULL)),
	CONSTRAINT "get_started_slot_check" CHECK (("get_started_claims"."status" <> 'granted' AND "get_started_claims"."reward_slot" IS NULL) OR ("get_started_claims"."status" = 'granted' AND (("get_started_claims"."quest_key" = 'invite' AND "get_started_claims"."reward_slot" BETWEEN 1 AND 15 AND "get_started_claims"."reward_slot" IS NOT NULL) OR ("get_started_claims"."quest_key" IN ('workflow', 'share') AND "get_started_claims"."reward_slot" = 1 AND "get_started_claims"."reward_slot" IS NOT NULL) OR ("get_started_claims"."quest_key" IN ('connector', 'slack', 'checkin') AND "get_started_claims"."reward_slot" IS NULL)))),
	CONSTRAINT "get_started_amount_check" CHECK ("get_started_claims"."reward_amount" = CASE "get_started_claims"."quest_key" WHEN 'slack' THEN 2000 WHEN 'share' THEN 2000 WHEN 'workflow' THEN 1000 ELSE 100 END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_get_started_claim_source" ON "get_started_claims" USING btree ("actor_user_id","quest_key","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_get_started_reward_key" ON "get_started_claims" USING btree ("reward_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_get_started_reward_slot" ON "get_started_claims" USING btree ("beneficiary_user_id","quest_key","reward_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_get_started_slack_org" ON "get_started_claims" USING btree ("org_id") WHERE "get_started_claims"."quest_key" = 'slack' AND "get_started_claims"."status" = 'granted';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_get_started_invitation" ON "get_started_claims" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "idx_get_started_user" ON "get_started_claims" USING btree ("beneficiary_user_id","quest_key","status");--> statement-breakpoint
CREATE INDEX "idx_get_started_org" ON "get_started_claims" USING btree ("org_id","quest_key","status");--> statement-breakpoint
CREATE INDEX "idx_get_started_pending" ON "get_started_claims" USING btree ("next_attempt_at") WHERE "get_started_claims"."status" IN ('pending', 'reviewing');