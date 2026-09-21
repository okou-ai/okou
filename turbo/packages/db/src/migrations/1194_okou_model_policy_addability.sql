INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES
	('okou-1.0', true),
	('okou-1.0-pro', true),
	('okou-1.0-max', true)
ON CONFLICT ("model") DO NOTHING;
