-- Fill missing personal Instructions when the workspace has one source.
-- Keep a saved personal version, including a deliberately empty one.
INSERT INTO instructions (org_id, user_id, content, bundle)
SELECT member.org_id, member.user_id, source.instructions, source.instructions_bundle
FROM agents AS source
JOIN org_members_cache AS member ON member.org_id = source.org_id
WHERE (source.owner = member.user_id OR
       (source.visibility = 'public' AND source.name = 'default-agent'))
  AND source.instructions_bundle IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agents AS other
    WHERE other.org_id = source.org_id AND other.id <> source.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM instructions AS saved
    WHERE saved.org_id = member.org_id AND saved.user_id = member.user_id
  )
ON CONFLICT (org_id, user_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE "chat_thread_events" DROP COLUMN "event_executor_id";
