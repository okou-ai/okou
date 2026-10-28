import {
  JOB_KIND,
  HANDLER_VERSION,
  jobInput,
  type Source,
  type Ready,
} from "./schema";

const versions = `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'id',v.id,'key',v.s3_key,'xmin',v.xmin::text,
  'fingerprint',encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex')) ORDER BY v.id)
  FROM storage_versions v WHERE v.storage_id=s.id),'[]'::jsonb)`;
const legacy = `s.user_id='__org__' AND starts_with(s.name,'custom-skill@')`;

/** One observation statement; no transaction or instruction bodies leave SQL. */
export function inventoryQuery(
  after: string | null,
  limit: number,
  id: string | null,
) {
  return {
    text: `WITH batch AS MATERIALIZED (
      SELECT s.* ,s.xmin::text AS captured_xmin FROM storages s WHERE ${legacy}
        AND ($1::uuid IS NULL OR s.id>$1::uuid) AND ($3::uuid IS NULL OR s.id=$3::uuid)
      ORDER BY s.id LIMIT $2
    ), sources AS (
      SELECT s.id,s.org_id AS "orgId",s.name,s.s3_prefix AS prefix,s.head_version_id AS head,
        s.captured_xmin AS xmin,${versions} AS versions FROM batch s
    )
    SELECT jsonb_build_object(
      'capturedAt',timezone('UTC',clock_timestamp())::text,
      'cutoverInstalled',to_regclass('public.claimed_workflow_attachments') IS NOT NULL,
      'sources',COALESCE((SELECT jsonb_agg(sources ORDER BY id) FROM sources),'[]'::jsonb),
      'workflows',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'orgId',w.org_id,
        'official',w.official_definition_name IS NOT NULL,
        'instructionHash',encode(sha256(convert_to(jsonb_build_array(w.instruction)::text,'UTF8')),'hex'),
        'fingerprint',encode(sha256(convert_to(to_jsonb(w)::text,'UTF8')),'hex'),
        'attachments',w.attachments) ORDER BY w.id) FROM workflows w),'[]'::jsonb),
      'inventory',jsonb_build_object(
        'storages',(SELECT count(*)::int FROM storages s WHERE ${legacy}),
        'versions',(SELECT count(*)::int FROM storage_versions v JOIN storages s ON s.id=v.storage_id WHERE ${legacy}),
        'pendingPublications',(SELECT count(*)::int FROM storage_publication_tokens WHERE starts_with(publication_key,'workflow:')),
        'unconvertedWorkflows',(SELECT count(*)::int FROM workflows WHERE official_definition_name IS NULL AND attachments IS NULL),
        'unfinishedJobs',(SELECT count(*)::int FROM background_jobs WHERE kind=$4 AND status<>'completed')
      )) AS observation`,
    values: [after, limit, id, JOB_KIND],
  };
}

function capturedReference(value: string) {
  return `jsonb_path_exists(COALESCE(${value},'null'::jsonb),
    '$.** ? (@.storageId == $storageId || @.versionId == $versions[*] || @.version == $versions[*] || @.storageVersion == $versions[*])',
    jsonb_build_object('storageId',$1::text,'versions',$3::jsonb))`;
}

function overlaps(key: string) {
  return `(${key}=t.prefix OR starts_with(${key},t.prefix||'/') OR starts_with(t.prefix,${key}||'/'))`;
}

/** $1 identity, $2 exact prefixes, $3 versions, $4 Workflow, $5 organization. */
function referenceCtes(requireDeleted: boolean) {
  return `targets AS MATERIALIZED (SELECT value AS prefix FROM jsonb_array_elements_text($2::jsonb)),
    captured_ids AS MATERIALIZED (SELECT value AS id FROM jsonb_array_elements_text($3::jsonb)),
    live_run_ids AS MATERIALIZED (
      SELECT id FROM agent_runs WHERE status IN('pending','running')
      UNION SELECT run_id FROM active_agent_runs
      UNION SELECT (producer->>'runId')::uuid FROM runner_state rs
        CROSS JOIN LATERAL jsonb_array_elements(rs.active_reuse_producers) AS producer
    ),
    protection AS MATERIALIZED (SELECT array_remove(ARRAY[
      ${requireDeleted ? "CASE WHEN EXISTS(SELECT 1 FROM storages WHERE id=$1::uuid) THEN 'source-still-present' END," : ""}
      CASE WHEN EXISTS(SELECT 1 FROM storages other CROSS JOIN targets t WHERE other.id<>$1::uuid
        AND (${overlaps("other.s3_prefix")} OR other.head_version_id IN(SELECT id FROM captured_ids))) THEN 'other-storage' END,
      CASE WHEN EXISTS(SELECT 1 FROM storage_versions v CROSS JOIN targets t WHERE v.storage_id<>$1::uuid
        AND ${overlaps("v.s3_key")}) THEN 'other-version' END,
      CASE WHEN EXISTS(SELECT 1 FROM skills sk CROSS JOIN targets t WHERE sk.storage_id=$1::uuid
        OR ${overlaps("sk.s3_key")}) THEN 'skill' END,
      CASE WHEN EXISTS(SELECT 1 FROM official_workflow_definition_revisions WHERE storage_id=$1::uuid
        OR storage_version IN(SELECT id FROM captured_ids)) THEN 'official-definition' END,
      CASE WHEN EXISTS(SELECT 1 FROM storage_version_lineage WHERE storage_id=$1::uuid
        OR version_id IN(SELECT id FROM captured_ids) OR parent_version_id IN(SELECT id FROM captured_ids)) THEN 'version-lineage' END,
      CASE WHEN EXISTS(SELECT 1 FROM workflows WHERE id=$4::uuid
        AND (org_id<>$5 OR official_definition_name IS NOT NULL)) THEN 'workflow-owner' END,
      CASE WHEN EXISTS(SELECT 1 FROM workflows w CROSS JOIN targets t WHERE ${overlaps("w.attachments->>'objectKey'")}) THEN 'current-attachment' END,
      CASE WHEN EXISTS(SELECT 1 FROM claimed_workflow_attachments c CROSS JOIN targets t WHERE ${overlaps("c.object_key")}) THEN 'claimed-attachment' END,
      CASE WHEN EXISTS(SELECT 1 FROM export_jobs e CROSS JOIN targets t WHERE ${overlaps("e.s3_key")}
        OR position(t.prefix IN COALESCE(e.artifact_urls::text,''))>0
        OR EXISTS(SELECT 1 FROM captured_ids c WHERE position(c.id IN COALESCE(e.artifact_urls::text,''))>0)) THEN 'export' END,
      CASE WHEN EXISTS(SELECT 1 FROM background_jobs j CROSS JOIN targets t
        WHERE j.kind<>'${JOB_KIND}' AND j.status NOT IN('completed','cancelled')
        AND (position(t.prefix IN j.input::text)>0 OR position(t.prefix IN j.checkpoint::text)>0
          OR ${capturedReference("j.input")} OR ${capturedReference("j.checkpoint")})) THEN 'background-consumer' END,
      CASE WHEN EXISTS(SELECT 1 FROM runner_job_queue q WHERE ${capturedReference("q.execution_context")}) THEN 'queued-consumer' END,
      CASE WHEN EXISTS(SELECT 1 FROM live_run_ids live JOIN agent_runs r ON r.id=live.id WHERE
        (${capturedReference("r.storage_mounts")} OR ${capturedReference("r.official_workflow_provenance")})) THEN 'execution-consumer' END,
      CASE WHEN EXISTS(SELECT 1 FROM workflows WHERE official_definition_name IS NULL AND attachments IS NULL) THEN 'unconverted-workflows' END,
      CASE WHEN EXISTS(SELECT 1 FROM storage_publication_tokens WHERE starts_with(publication_key,'workflow:')) THEN 'workflow-publication' END
    ]::text[],NULL) AS reasons)`;
}

function referenceValues(source: Source, prefixes: readonly string[]) {
  return [
    source.id,
    JSON.stringify(prefixes),
    JSON.stringify(
      source.versions.map((version) => {
        return version.id;
      }),
    ),
    source.name.slice("custom-skill@".length),
    source.orgId,
  ];
}

export function referenceQuery(
  source: Source,
  prefixes: readonly string[],
  requireDeleted: boolean,
) {
  return {
    text: `WITH ${referenceCtes(requireDeleted)} SELECT reasons FROM protection`,
    values: referenceValues(source, prefixes),
  };
}

/** Removal and the complete exact cleanup inventory either both commit or neither does. */
export function retireQuery(bucket: string, row: Ready) {
  const source = row.source;
  return {
    text: `WITH ${referenceCtes(false)}, removed AS (
      DELETE FROM storages s WHERE s.id=$1::uuid AND s.org_id=$5 AND s.user_id='__org__'
        AND s.name=$6 AND s.s3_prefix=$7 AND s.xmin::text=$8
        AND s.head_version_id IS NOT DISTINCT FROM $9::varchar AND ${versions}=$10::jsonb
        AND cardinality((SELECT reasons FROM protection))=0
      RETURNING s.org_id
    ), captured_jobs AS (SELECT * FROM jsonb_to_recordset($11::jsonb) AS j(id uuid,input jsonb))
    INSERT INTO background_jobs(id,kind,handler_version,user_id,org_id,input)
    SELECT j.id,'${JOB_KIND}',${HANDLER_VERSION},'__org__',removed.org_id,j.input
    FROM removed CROSS JOIN captured_jobs j RETURNING id`,
    values: [
      ...referenceValues(
        source,
        row.jobs.map((job) => {
          return job.prefix;
        }),
      ),
      source.name,
      source.prefix,
      source.xmin,
      source.head,
      JSON.stringify(source.versions),
      JSON.stringify(
        row.jobs.map((job) => {
          return {
            id: job.id,
            input: jobInput(bucket, source, job),
          };
        }),
      ),
    ],
  };
}

export function remainingQuery(source: Source) {
  return {
    text: `SELECT (SELECT count(*)::int FROM storages WHERE id=$1::uuid) AS storages,
      (SELECT count(*)::int FROM storage_versions WHERE storage_id=$1::uuid OR id IN(
        SELECT value FROM jsonb_array_elements_text($2::jsonb))) AS versions`,
    values: [
      source.id,
      JSON.stringify(
        source.versions.map((version) => {
          return version.id;
        }),
      ),
    ],
  };
}
