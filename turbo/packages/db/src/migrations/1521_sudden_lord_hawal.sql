CREATE TABLE "friend_referral_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friend_referrals" (
	"invitee_user_id" text PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"registered_at" timestamp NOT NULL,
	"paid_org_id" text,
	"stripe_invoice_id" text,
	"credit_grant_id" uuid,
	"granted_at" timestamp,
	"expires_at" timestamp,
	CONSTRAINT "chk_friend_referral_grant" CHECK (
      ("friend_referrals"."granted_at" IS NULL AND "friend_referrals"."expires_at" IS NULL AND "friend_referrals"."credit_grant_id" IS NULL AND "friend_referrals"."stripe_invoice_id" IS NULL AND "friend_referrals"."paid_org_id" IS NULL)
      OR ("friend_referrals"."granted_at" IS NOT NULL AND "friend_referrals"."expires_at" = "friend_referrals"."granted_at" + interval '1 month'
        AND "friend_referrals"."expires_at" IS NOT NULL AND "friend_referrals"."credit_grant_id" IS NOT NULL AND "friend_referrals"."stripe_invoice_id" IS NOT NULL AND "friend_referrals"."paid_org_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "friend_referrals" ADD CONSTRAINT "friend_referrals_link_id_friend_referral_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."friend_referral_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_friend_referral_link_owner" ON "friend_referral_links" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_friend_referrals_link" ON "friend_referrals" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_friend_referral_credit_grant" ON "friend_referrals" USING btree ("credit_grant_id");