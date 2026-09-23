-- GPT-6 Luna becomes the seed for new organizations. Existing policies are not changed.
INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES ('gpt-6-luna', true)
ON CONFLICT ("model") DO UPDATE
SET "allow_new_org_policy" = EXCLUDED."allow_new_org_policy",
    "updated_at" = now()
WHERE "run_model_catalog"."allow_new_org_policy" IS DISTINCT FROM true;
