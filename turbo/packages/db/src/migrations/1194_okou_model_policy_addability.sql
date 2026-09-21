INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES
	('okou-1.0', true),
	('okou-1.0-pro', true),
	('okou-1.0-max', true)
ON CONFLICT ("model") DO UPDATE
SET
	"allow_new_org_policy" = EXCLUDED."allow_new_org_policy",
	"updated_at" = now();
