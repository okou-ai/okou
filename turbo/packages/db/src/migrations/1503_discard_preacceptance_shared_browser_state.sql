-- BrowserSharedOwner remains disabled during this pre-acceptance cutover.
-- Discard only shared metadata with no legacy instance. New chat state starts empty.
WITH removed AS (
  DELETE FROM browser_session_screenshots
  WHERE chat_thread_id IN (SELECT b.chat_thread_id
    FROM browser_sessions b
    JOIN browser_owner_profiles p ON p.org_id = b.org_id AND p.user_id = b.user_id
    WHERE b.status = 'active'
      AND b.browser_profile_id IS NULL AND b.browser_thread_profile_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM browser_session_instances i WHERE i.chat_thread_id = b.chat_thread_id
      ))
  RETURNING object_key, chat_thread_id, created_at
)
INSERT INTO browser_session_screenshot_deletions (object_key, chat_thread_id, created_at)
SELECT object_key, chat_thread_id, created_at FROM removed
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM browser_session_tab_snapshots
WHERE chat_thread_id IN (SELECT b.chat_thread_id
    FROM browser_sessions b
    JOIN browser_owner_profiles p ON p.org_id = b.org_id AND p.user_id = b.user_id
    WHERE b.status = 'active'
      AND b.browser_profile_id IS NULL AND b.browser_thread_profile_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM browser_session_instances i WHERE i.chat_thread_id = b.chat_thread_id
      ));
--> statement-breakpoint
DELETE FROM browser_sessions
WHERE chat_thread_id IN (SELECT b.chat_thread_id
    FROM browser_sessions b
    JOIN browser_owner_profiles p ON p.org_id = b.org_id AND p.user_id = b.user_id
    WHERE b.status = 'active'
      AND b.browser_profile_id IS NULL AND b.browser_thread_profile_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM browser_session_instances i WHERE i.chat_thread_id = b.chat_thread_id
      ))
  AND status = 'active' AND browser_profile_id IS NULL AND browser_thread_profile_id IS NULL;
--> statement-breakpoint
-- Keep the empty relation for outgoing GA deletion/cron SQL until #42932.
DELETE FROM browser_owner_windows;
--> statement-breakpoint
-- The reconciler must confirm provider stop before an old shared instance is replaced.
UPDATE browser_owner_profiles SET status = 'stopping', updated_at = now() WHERE status = 'active';
--> statement-breakpoint
