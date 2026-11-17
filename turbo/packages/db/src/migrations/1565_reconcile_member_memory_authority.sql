-- Protocol C promotion prerequisite (#47043): run only while protocol B is authoritative.
-- All legacy-only (A) initializers, publishers and pinned callbacks must have drained.
-- This final catch-up never runs after C promotion. C owns Memory HEAD and only
-- mirrors legacy Storage for the B rollback window; rerunning legacy backfills
-- after promotion would violate that authority and its lock order.
-- Preserve every immutable field and fail closed on any incomplete reconciliation.
-- Member Memory excludes organization-owned Volumes named memory.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM storages s LEFT JOIN storage_versions v ON v.id=s.head_version_id AND v.storage_id=s.id
    WHERE s.name='memory' AND s.user_id<>'__org__' AND s.head_version_id IS NOT NULL AND v.id IS NULL)
  THEN RAISE EXCEPTION 'Memory authority gate: missing or cross-root legacy HEAD'; END IF;
  IF EXISTS (SELECT 1 FROM storage_versions v JOIN storages s ON s.id=v.storage_id
    WHERE s.name='memory' AND s.user_id<>'__org__' AND v.s3_key<>s.s3_prefix || '/' || v.id)
  THEN RAISE EXCEPTION 'Memory authority gate: immutable object locator mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM storage_version_lineage l JOIN storages s ON s.id=l.storage_id
    LEFT JOIN storage_versions v ON v.id=l.version_id AND v.storage_id=l.storage_id
    LEFT JOIN storage_versions p ON p.id=l.parent_version_id AND p.storage_id=l.storage_id
    WHERE s.name='memory' AND s.user_id<>'__org__' AND (v.id IS NULL OR p.id IS NULL))
  THEN RAISE EXCEPTION 'Memory authority gate: incomplete accepted lineage references'; END IF;
END $$;
--> statement-breakpoint
INSERT INTO member_memories (id,org_id,user_id,object_prefix,content_size,file_count,head_version_id,created_at,updated_at)
SELECT id,org_id,user_id,s3_prefix,0,0,NULL,created_at,updated_at FROM storages
WHERE name='memory' AND user_id<>'__org__' ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO memory_versions (id,memory_id,object_prefix,content_size,archive_size,file_count,message,created_by,created_at)
SELECT v.id,v.storage_id,v.s3_key,v.size,v.archive_size,v.file_count,v.message,v.created_by,v.created_at
FROM storage_versions v JOIN storages s ON s.id=v.storage_id
WHERE s.name='memory' AND s.user_id<>'__org__' ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO memory_version_lineage (id,memory_id,version_id,parent_version_id,run_id,created_at)
SELECT l.id,l.storage_id,l.version_id,l.parent_version_id,l.run_id,l.created_at
FROM storage_version_lineage l JOIN storages s ON s.id=l.storage_id
WHERE s.name='memory' AND s.user_id<>'__org__' ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- Compare the observed business tuple so a concurrent bridge publication wins.
WITH observed AS MATERIALIZED (
  SELECT s.id,s.head_version_id,s.size,s.file_count,s.updated_at,
    m.head_version_id AS observed_head,m.content_size AS observed_size,
    m.file_count AS observed_count,m.updated_at AS observed_updated
  FROM storages s JOIN member_memories m ON m.id=s.id
  WHERE s.name='memory' AND s.user_id<>'__org__'
)
UPDATE member_memories m SET head_version_id=o.head_version_id,
  content_size=o.size,file_count=o.file_count,updated_at=o.updated_at
FROM observed o WHERE m.id=o.id
  AND (m.head_version_id,m.content_size,m.file_count,m.updated_at)
    IS NOT DISTINCT FROM (o.observed_head,o.observed_size,o.observed_count,o.observed_updated)
  AND (m.head_version_id,m.content_size,m.file_count,m.updated_at)
    IS DISTINCT FROM (o.head_version_id,o.size,o.file_count,o.updated_at);
--> statement-breakpoint
-- Compare all immutable metadata, candidates and accepted provenance in both directions.
DO $$ BEGIN
  IF EXISTS (
    (SELECT id,org_id,user_id,s3_prefix,size,file_count,head_version_id,created_at,updated_at FROM storages WHERE name='memory' AND user_id<>'__org__'
      EXCEPT SELECT id,org_id,user_id,object_prefix,content_size,file_count,head_version_id,created_at,updated_at FROM member_memories)
    UNION ALL
    (SELECT id,org_id,user_id,object_prefix,content_size,file_count,head_version_id,created_at,updated_at FROM member_memories
      EXCEPT SELECT id,org_id,user_id,s3_prefix,size,file_count,head_version_id,created_at,updated_at FROM storages WHERE name='memory' AND user_id<>'__org__'))
  THEN RAISE EXCEPTION 'Memory authority gate: root reconciliation is incomplete'; END IF;
  IF EXISTS (
    (SELECT v.id,v.storage_id,v.s3_key,v.size,v.archive_size,v.file_count,v.message,v.created_by,v.created_at FROM storage_versions v JOIN storages s ON s.id=v.storage_id WHERE s.name='memory' AND s.user_id<>'__org__'
      EXCEPT SELECT id,memory_id,object_prefix,content_size,archive_size,file_count,message,created_by,created_at FROM memory_versions)
    UNION ALL
    (SELECT id,memory_id,object_prefix,content_size,archive_size,file_count,message,created_by,created_at FROM memory_versions
      EXCEPT SELECT v.id,v.storage_id,v.s3_key,v.size,v.archive_size,v.file_count,v.message,v.created_by,v.created_at FROM storage_versions v JOIN storages s ON s.id=v.storage_id WHERE s.name='memory' AND s.user_id<>'__org__'))
  THEN RAISE EXCEPTION 'Memory authority gate: immutable revision reconciliation is incomplete'; END IF;
  IF EXISTS (
    (SELECT l.id,l.storage_id,l.version_id,l.parent_version_id,l.run_id,l.created_at FROM storage_version_lineage l JOIN storages s ON s.id=l.storage_id WHERE s.name='memory' AND s.user_id<>'__org__'
      EXCEPT SELECT id,memory_id,version_id,parent_version_id,run_id,created_at FROM memory_version_lineage)
    UNION ALL
    (SELECT id,memory_id,version_id,parent_version_id,run_id,created_at FROM memory_version_lineage
      EXCEPT SELECT l.id,l.storage_id,l.version_id,l.parent_version_id,l.run_id,l.created_at FROM storage_version_lineage l JOIN storages s ON s.id=l.storage_id WHERE s.name='memory' AND s.user_id<>'__org__'))
  THEN RAISE EXCEPTION 'Memory authority gate: accepted lineage reconciliation is incomplete'; END IF;
END $$;
