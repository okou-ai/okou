UPDATE "org_plan_entitlements"
SET "can_buy_credits" = true, "updated_at" = now()
WHERE "plan_key" = 'limited-free-1' AND "can_buy_credits" = false;
