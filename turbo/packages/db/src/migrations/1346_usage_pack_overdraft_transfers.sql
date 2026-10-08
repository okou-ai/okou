CREATE TABLE "usage_pack_overdraft_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"credit_grant_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_overdraft_transfers_amount" CHECK ("usage_pack_overdraft_transfers"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_usage_pack_overdraft_transfers_org" ON "usage_pack_overdraft_transfers" USING btree ("org_id","created_at");
--> statement-breakpoint
-- One atomic transfer per retained negative grant, including expired packages.
-- No usage replay, debt forgiveness, or change to grant/payment provenance.
DO $$
DECLARE
  wallet_org text;
BEGIN
  FOR wallet_org IN
    SELECT DISTINCT org_id FROM usage_pack_credit_grants
    WHERE remaining_amount < 0 ORDER BY org_id
  LOOP
    PERFORM org_id FROM org_metadata WHERE org_id = wallet_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Usage pack overdraft has no organization wallet: %', wallet_org;
    END IF;
    -- Preserve the existing expiration-before-new-debit rule before moving debt.
    WITH expired AS MATERIALIZED (
      SELECT id, remaining FROM credit_expires_record
      WHERE org_id = wallet_org AND remaining > 0 AND expires_at <= now()
      ORDER BY id FOR UPDATE
    ), cleared_expiry AS (
      UPDATE credit_expires_record AS lots SET remaining = 0
      FROM expired WHERE lots.id = expired.id
      RETURNING expired.remaining
    ), expired_amount AS (
      SELECT COALESCE(sum(remaining), 0) AS amount FROM cleared_expiry
    )
    UPDATE org_metadata SET credits = GREATEST(credits - expired_amount.amount, 0),
      updated_at = now()
    FROM expired_amount WHERE org_id = wallet_org AND expired_amount.amount > 0;
    WITH negative AS MATERIALIZED (
      SELECT id, org_id, user_id, -remaining_amount AS amount
      FROM usage_pack_credit_grants
      WHERE org_id = wallet_org AND remaining_amount < 0
      ORDER BY id FOR UPDATE
    ), cleared AS (
      UPDATE usage_pack_credit_grants AS grants SET remaining_amount = 0
      FROM negative WHERE grants.id = negative.id
      RETURNING negative.id, negative.org_id, negative.user_id, negative.amount
    ), audited AS (
      INSERT INTO usage_pack_overdraft_transfers (org_id, user_id, credit_grant_id, amount)
      SELECT org_id, user_id, id, amount FROM cleared
      RETURNING amount
    )
    UPDATE org_metadata SET credits = credits - COALESCE((SELECT sum(amount) FROM audited), 0),
      updated_at = now()
    WHERE org_id = wallet_org;
  END LOOP;
END $$;