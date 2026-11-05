-- Suggestions is staff-only. Preserve feedback identities, revisions and timestamps
-- while removing the retired classification from cards and feedback snapshots.
UPDATE "agent_suggestion_items"
SET
  "content" = "content" - 'feedbackScope',
  "feedbacks" = (
    SELECT COALESCE(
      jsonb_agg(entry.value #- '{context,scope}' ORDER BY entry.ordinality),
      '[]'::jsonb
    )
    FROM jsonb_array_elements("feedbacks") WITH ORDINALITY AS entry(value, ordinality)
  )
WHERE "content" ? 'feedbackScope'
   OR jsonb_path_exists("feedbacks", '$[*].context.scope');
