-- Keep each owner's original full-precision created_at/id order. Nullable ranks
-- remain legal for outgoing API instances that insert after this migration.
-- Sequence reservation, metadata changes and replayable receipts commit together;
-- an older immutable snapshot therefore converges through its normal event tail.
WITH ranked AS MATERIALIZED (
  SELECT id, user_id, org_id,
    'a0' || lpad(row_number() OVER (
      PARTITION BY user_id, org_id ORDER BY created_at, id
    )::text, 17, '0') || '1' AS sort_order
  FROM projects
), changed AS (
  UPDATE projects p SET sort_order = r.sort_order, updated_at = timezone('UTC', now())
  FROM ranked r WHERE p.id = r.id AND p.sort_order IS NULL
  RETURNING p.id, p.user_id, p.org_id, p.name, p.sort_order
), reserved AS (
  INSERT INTO project_event_sequences (user_id, org_id, last_seq_id)
  SELECT user_id, org_id, count(*) FROM changed GROUP BY user_id, org_id
  ON CONFLICT (user_id, org_id) DO UPDATE
    SET last_seq_id = project_event_sequences.last_seq_id + EXCLUDED.last_seq_id
  RETURNING user_id, org_id, last_seq_id
)
INSERT INTO project_events (
  id, user_id, org_id, seq_id, project_id, kind, name, sort_order
)
SELECT gen_random_uuid(), c.user_id, c.org_id,
  r.last_seq_id - count(*) OVER (PARTITION BY c.user_id, c.org_id)
    + row_number() OVER (PARTITION BY c.user_id, c.org_id ORDER BY c.sort_order COLLATE "C", c.id),
  c.id, 'sort_updated'::project_event_kind, c.name, c.sort_order
FROM changed c JOIN reserved r USING (user_id, org_id);
