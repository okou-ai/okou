-- Discard incompatible, disposable active cards before requiring complete custom context.
-- Preserve terminal receipts; the next curation can regenerate the discarded identities.
UPDATE "agent_suggestions"
SET "entries" = COALESCE((
  SELECT jsonb_agg(item)
  FROM jsonb_array_elements("entries") AS item
  WHERE item->>'status' <> 'active' OR item ? 'customOption'
), '[]'::jsonb)
WHERE jsonb_path_exists("entries", '$[*] ? (@.status == "active" && !exists(@.customOption))');
--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_custom_context" CHECK (NOT jsonb_path_exists("agent_suggestions"."entries", '$[*] ? (@.status == "active" && !exists(@.customOption))'));