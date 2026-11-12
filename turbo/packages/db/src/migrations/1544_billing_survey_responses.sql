CREATE TABLE "billing_survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"survey" varchar(32) NOT NULL,
	"answer" varchar(32) NOT NULL,
	"detail" text,
	"checkout_kind" varchar(32),
	"reward_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_billing_survey_responses_survey" CHECK ("billing_survey_responses"."survey" IN ('credits_exhausted', 'checkout_abandoned')),
	CONSTRAINT "chk_billing_survey_responses_reward" CHECK ("billing_survey_responses"."reward_credits" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_billing_survey_responses_member" ON "billing_survey_responses" USING btree ("org_id","user_id","survey");--> statement-breakpoint
CREATE INDEX "idx_billing_survey_responses_survey_created" ON "billing_survey_responses" USING btree ("survey","created_at");