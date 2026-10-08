-- DeepSeek memory admission, captured execution and late usage have drained.
-- The supported API rollback floor selects Luna. Preserve catalog metadata,
-- historical model identities and all usage pricing.
DELETE FROM "model_routes" WHERE "model" = 'deepseek-v4.1-flash';
