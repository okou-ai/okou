-- Reject unprepared consumers and unexpected retained payload before contraction.
DO $c11$
DECLARE
  generation_table regclass := 'public.storage_publication_generations'::regclass;
  token_table regclass := 'public.storage_publication_tokens'::regclass;
  columns text[];
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.delete_agent_rows(uuid,text,text,boolean)'::regprocedure)
      IS DISTINCT FROM '4130c8ccb1453502ee738244c961aed0'
    OR (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.delete_workflow_rows(text,uuid,boolean,text)'::regprocedure)
      IS DISTINCT FROM '58aacbf9b312b8369002b5504da92f2f' THEN
    RAISE EXCEPTION 'C11: deletion functions do not match the prepared contract';
  END IF;
  SELECT array_agg(attname || ':' || format_type(atttypid, atttypmod) ORDER BY attnum)
  INTO columns FROM pg_attribute
  WHERE attrelid = generation_table AND attnum > 0 AND NOT attisdropped;
  IF columns IS DISTINCT FROM ARRAY[
    'org_id:text', 'agent_id:uuid', 'subject:text', 'generation:bigint',
    'updated_at:timestamp without time zone'
  ] THEN
    RAISE EXCEPTION 'C11: unexpected generation-table payload';
  END IF;
  SELECT array_agg(attname || ':' || format_type(atttypid, atttypmod) ORDER BY attnum)
  INTO columns FROM pg_attribute
  WHERE attrelid = token_table AND attnum > 0 AND NOT attisdropped;
  IF columns IS DISTINCT FROM ARRAY[
    'org_id:text', 'agent_id:uuid', 'subject:text', 'publication_key:text',
    'generation:bigint', 'token:uuid',
    'created_at:timestamp without time zone', 'updated_at:timestamp without time zone'
  ] THEN
    RAISE EXCEPTION 'C11: unexpected token-table payload';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.prokind IN ('f', 'p')
      AND p.prosrc ~* 'storage_publication_(generations|tokens)'
  ) THEN
    RAISE EXCEPTION 'C11: a persisted routine still references publication storage';
  END IF;
  IF EXISTS (SELECT 1 FROM public.storage_publication_tokens
      WHERE publication_key !~ '^workflow:[a-f0-9-]{36}$') THEN
    RAISE EXCEPTION 'C11: retained publication state belongs to another protocol';
  END IF;
  -- Owned objects can disappear even under RESTRICT. Reject unexpected additions;
  -- external dependencies are additionally protected by DROP RESTRICT.
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE (i.indrelid = generation_table
        AND c.relname <> 'storage_publication_generations_pk')
      OR (i.indrelid = token_table AND c.relname NOT IN (
        'storage_publication_tokens_pk', 'storage_publication_tokens_token_idx'
      ))
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint c
    -- PostgreSQL 18 catalogs ordinary column NOT NULL constraints separately.
    WHERE (c.contype <> 'n' AND (
      (c.conrelid = generation_table AND c.conname NOT IN (
        'storage_publication_generations_pk',
        'storage_publication_generations_generation_check'
      )) OR (c.conrelid = token_table AND c.conname NOT IN (
        'storage_publication_tokens_pk', 'storage_publication_tokens_generation_check'
      ))
    )) OR (c.contype = 'f' AND c.confrelid IN (generation_table, token_table))
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid IN (generation_table, token_table) AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite
    WHERE ev_class IN (generation_table, token_table)
  ) THEN
    RAISE EXCEPTION 'C11: unexpected owned object on publication storage';
  END IF;
END;
$c11$;
--> statement-breakpoint
DROP TABLE public.storage_publication_tokens RESTRICT;
--> statement-breakpoint
DROP TABLE public.storage_publication_generations RESTRICT;
