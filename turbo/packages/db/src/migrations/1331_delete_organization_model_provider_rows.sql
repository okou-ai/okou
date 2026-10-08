-- Organization-owned model provider rows have no reader or writer: model
-- execution uses the code-owned Auto route or a member's personal
-- subscription provider.
DELETE FROM "model_providers" WHERE "user_id" = '__org__';
