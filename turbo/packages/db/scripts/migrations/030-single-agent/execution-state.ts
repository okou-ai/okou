import postgres from "postgres";
import { array, number, object, string } from "zod";
import {
  executionTables,
  quoteIdentifier,
  tableImageSchema,
  tableScope,
  type TableImage,
} from "./execution-model";
import { PlanningError } from "./snapshot";

const stateSchema = object({
  database: string(),
  capturedAt: string(),
  active: number().int(),
  queued: number().int(),
  unknownDependencies: array(string()),
  tables: array(tableImageSchema),
});
export type ExecutionState = ReturnType<typeof stateSchema.parse>;

export async function readExecutionState(
  connection: string,
  orgId: string,
  automationIds: readonly string[],
  runIds: readonly string[] = [],
) {
  const pool = postgres(connection, { max: 1, onnotice: () => {} });
  try {
    const db = await pool.reserve();
    try {
      await db`SET default_transaction_read_only = on`;
      await db`SET search_path = pg_catalog, public`;
      await db`SET statement_timeout = '60s'`;
      const parts = executionTables.map((table) => {
        const relation = quoteIdentifier(table.name);
        return `(SELECT jsonb_build_object(
          'name', '${table.name}',
          'columns', columns.names, 'keys', keys.names,
          'schema', jsonb_build_object('columns', columns.definitions,
            'constraints', (SELECT coalesce(jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname), '[]'::jsonb)
              FROM pg_constraint WHERE conrelid = '${table.name}'::regclass),
            'indexes', (SELECT coalesce(jsonb_agg(indexdef ORDER BY indexname), '[]'::jsonb)
              FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table.name}'))::text,
          'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'key', (SELECT jsonb_object_agg(k, to_jsonb(t)->k) FROM unnest(keys.names) k)::text,
            'before', to_jsonb(t)::text, 'after', to_jsonb(t)::text, 'revision', t.xmin::text)
            ORDER BY to_jsonb(t)::text), '[]'::jsonb)
            FROM ${relation} t WHERE ${tableScope(table)})
        ) FROM (
          SELECT array_agg(attname ORDER BY attnum) AS names,
            jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),
              'required',attnotnull,'generated',attgenerated,'identity',attidentity) ORDER BY attnum) AS definitions
          FROM pg_attribute WHERE attrelid = '${table.name}'::regclass AND attnum > 0 AND NOT attisdropped
        ) columns CROSS JOIN (
          SELECT array_agg(a.attname ORDER BY k.ordinality) AS names
          FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE i.indrelid = '${table.name}'::regclass AND i.indisprimary
        ) keys)`;
      });
      const cascading = executionTables
        .filter((table) => {
          return table.scope === "automation";
        })
        .map((table) => {
          return `'${table.name}'::regclass`;
        });
      const result = await db.unsafe(
        `SELECT jsonb_build_object(
          'database', current_database(), 'capturedAt', timezone('UTC',statement_timestamp())::text,
          'active', (SELECT count(*)::int FROM active_agent_runs WHERE org_id = $1),
          'queued', (SELECT count(*)::int FROM queued_chat_threads WHERE org_id = $1),
          'unknownDependencies', (SELECT coalesce(jsonb_agg(conname ORDER BY conname),'[]'::jsonb)
            FROM pg_constraint WHERE contype = 'f'
            AND confrelid IN ('workflows'::regclass,'projects'::regclass,'workflow_automations'::regclass,'workflow_user_automation_threads'::regclass,${cascading.join(",")})
            AND NOT (
              (confrelid = 'workflow_automations'::regclass
                AND confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=confrelid AND attname='id')]
                AND (
                  (conrelid IN (${cascading.join(",")}) AND confdeltype='c'
                    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='automation_id')])
                  OR (conrelid='agent_runs'::regclass AND confdeltype='n'
                    AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='workflow_automation_id')])
                  OR (conrelid='official_workflow_automation_identities'::regclass AND confdeltype='n'
                    AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='automation_id')])
                ))
              OR (confrelid='workflows'::regclass AND conrelid IN ('workflow_automations'::regclass,'workflow_user_automation_threads'::regclass,'official_workflow_automation_identities'::regclass)
                AND confdeltype='c' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='workflow_id')]
                AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=confrelid AND attname='id')])
              OR (confrelid='projects'::regclass AND conrelid='chat_threads'::regclass
                AND confdeltype='a'
                AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='project_id'),(SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='user_id')]
                AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=confrelid AND attname='id'),(SELECT attnum FROM pg_attribute WHERE attrelid=confrelid AND attname='user_id')])
            )),
          'tables', jsonb_build_array(${parts.join(",")})
        ) AS state`,
        [orgId, [...automationIds], [...runIds]],
      );
      if (result.length !== 1)
        throw new PlanningError("ExecutionStateUnavailable");
      return stateSchema.parse(result[0]?.state);
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
  }
}

export function requireQuiescent(state: ExecutionState) {
  if (state.active || state.queued)
    throw new PlanningError("DrainActiveAndQueuedWorkBeforeExecution");
  if (state.unknownDependencies.length)
    throw new PlanningError("UnmappedDeletionForeignKey");
}

export interface DraftRow {
  key: string;
  before: string | null;
  revision: string | null;
  patch: string | null;
  insert: string | null;
  remove: boolean;
}
export interface DraftTable {
  metadata: TableImage;
  rows: DraftRow[];
}

/** Normalize with PostgreSQL, preserving numeric precision and timestamp representation. */
export async function normalizeExecutionTables(
  connection: string,
  drafts: readonly DraftTable[],
) {
  const db = postgres(connection, { max: 1, onnotice: () => {} });
  try {
    await db`SET default_transaction_read_only = on`;
    await db`SET search_path = pg_catalog, public`;
    await db`SET statement_timeout = '60s'`;
    const tables: TableImage[] = [];
    for (const draft of drafts) {
      const metadata = object({
        columns: array(object({ generated: string(), identity: string() })),
      }).parse(JSON.parse(draft.metadata.schema));
      if (
        draft.rows.some((row) => {
          return row.patch !== null || row.insert !== null || row.remove;
        }) &&
        metadata.columns.some((column) => {
          return column.generated !== "" || column.identity !== "";
        })
      )
        throw new PlanningError(
          "GeneratedExecutionColumnRequiresSeparateMapping",
        );
      const table = quoteIdentifier(draft.metadata.name);
      const result = await db.unsafe(
        `WITH normalized AS (
          SELECT r.*, CASE WHEN remove THEN NULL
            WHEN r."insert" IS NOT NULL THEN to_jsonb(jsonb_populate_record(NULL::${table},r."insert"::jsonb))::text
            WHEN patch IS NOT NULL THEN to_jsonb(jsonb_populate_record(NULL::${table},before::jsonb || patch::jsonb))::text
            ELSE before END AS after
          FROM jsonb_to_recordset($1::jsonb) AS r(key text,before text,revision text,patch text,"insert" text,remove boolean)
        ) SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', (SELECT jsonb_object_agg(k,coalesce(after,before)::jsonb->k) FROM unnest($2::text[]) k)::text,
          'before',before,'after',after,'revision',revision)
          ORDER BY coalesce(after,before)), '[]'::jsonb) AS rows FROM normalized`,
        [
          db.json(
            draft.rows.map((row) => {
              return { ...row };
            }),
          ),
          draft.metadata.keys,
        ],
      );
      const parsed = tableImageSchema.parse({
        ...draft.metadata,
        rows: result[0]?.rows,
      });
      if (
        new Set(
          parsed.rows.map((row) => {
            return row.key;
          }),
        ).size !== parsed.rows.length
      )
        throw new PlanningError("DuplicateExecutionRowIdentity");
      tables.push(parsed);
    }
    return tables;
  } finally {
    await db.end();
  }
}

export function compareState(
  state: ExecutionState,
  expected: readonly TableImage[],
  side: "before" | "after",
  revisions = false,
) {
  return expected.every((table) => {
    const actual = state.tables.find((item) => {
      return item.name === table.name;
    });
    if (
      !actual ||
      actual.schema !== table.schema ||
      JSON.stringify(actual.keys) !== JSON.stringify(table.keys) ||
      JSON.stringify(actual.columns) !== JSON.stringify(table.columns)
    )
      return false;
    const rows = table.rows.filter((row) => {
      return row[side] !== null;
    });
    const indexed = new Map(
      actual.rows.map((row) => {
        return [row.key, row];
      }),
    );
    return (
      rows.length === actual.rows.length &&
      rows.every((row) => {
        const current = indexed.get(row.key);
        return (
          current?.before === row[side] &&
          (!revisions || current.revision === row.revision)
        );
      })
    );
  });
}
