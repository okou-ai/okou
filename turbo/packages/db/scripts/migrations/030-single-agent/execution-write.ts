import postgres from "postgres";
import { array, literal, object } from "zod";
import {
  executionTables,
  quoteIdentifier,
  tableScope,
  type ExecutionImage,
} from "./execution-model";
import { PlanningError } from "./snapshot";
import { mutableExecutionFields } from "./execution-validation";

/** One statement publishes the closed migration surface and its metadata events. */
export async function writeExecution(
  connection: string,
  image: ExecutionImage,
  recover: boolean,
) {
  const db = postgres(connection, { max: 1, onnotice: () => {} });
  try {
    await db`SET statement_timeout = '60s'`;
    await db`SET search_path = pg_catalog, public`;
    const source = recover ? "after" : "before";
    const destination = recover ? "before" : "after";
    const ctes: string[] = [];
    const checks: string[] = [];
    const rowCtes = new Map<string, string>();
    const guards: string[] = [];
    for (const [index, table] of image.tables.entries()) {
      const definition = executionTables.find((item) => {
        return item.name === table.name;
      });
      if (!definition) throw new PlanningError("UnknownExecutionTable");
      const relation = quoteIdentifier(table.name);
      const rows = `image_${index}`;
      rowCtes.set(table.name, rows);
      ctes.push(`${rows} AS MATERIALIZED (
        SELECT key, ${source} AS src, ${destination} AS dst, revision
        FROM jsonb_array_elements($3::jsonb) AS tables(value)
        CROSS JOIN LATERAL jsonb_to_recordset(tables.value->'rows') AS r(key text,before text,after text,revision text)
        WHERE tables.value->>'name' = '${table.name}'
      )`);
      const current = `SELECT to_jsonb(t)::text AS row${recover ? "" : ",t.xmin::text AS revision"} FROM ${relation} t WHERE ${tableScope(definition, "$5")}`;
      const expected = `SELECT src AS row${recover ? "" : ",revision"} FROM ${rows} WHERE src IS NOT NULL`;
      guards.push(
        `NOT EXISTS ((${current} EXCEPT ${expected}) UNION ALL (${expected} EXCEPT ${current}))`,
      );
      const mutable = mutableExecutionFields[table.name];
      if (mutable) {
        const fields = `ARRAY[${mutable
          .map((field) => {
            return `'${field}'`;
          })
          .join(",")}]::text[]`;
        guards.push(`NOT EXISTS (SELECT 1 FROM ${rows} WHERE src IS NOT NULL AND dst IS NOT NULL
          AND src::jsonb - ${fields} IS DISTINCT FROM dst::jsonb - ${fields})`);
      }
    }
    ctes.push(`admitted AS MATERIALIZED (SELECT (
      current_database() = $4
      AND NOT EXISTS (SELECT 1 FROM active_agent_runs WHERE org_id = $1)
      AND NOT EXISTS (SELECT 1 FROM queued_chat_threads WHERE org_id = $1)
      AND ${guards.join(" AND ")}
    ) AS ok)`);
    let predecessor = "admitted";
    let chatMutation: string | undefined;
    let projectMutation: string | undefined;
    let mutationCount = 0;
    const order = recover
      ? [
          "workflow_automations",
          ...executionTables
            .filter((item) => {
              return item.scope === "automation";
            })
            .map((item) => {
              return item.name;
            }),
          "agent_runs",
          "workflow_user_automation_threads",
          "chat_threads",
          "instructions",
          "workflows",
          "projects",
        ]
      : [
          "projects",
          "workflows",
          "instructions",
          "chat_threads",
          "workflow_user_automation_threads",
          "workflow_automations",
        ];
    for (const name of order) {
      const table = image.tables.find((item) => {
        return item.name === name;
      });
      if (!table) throw new PlanningError("ExecutionTableMissing");
      const rows = rowCtes.get(name)!;
      const relation = quoteIdentifier(name);
      const columns = table.columns.map(quoteIdentifier).join(",");
      const admission = `(SELECT ok FROM admitted) AND (SELECT count(*) FROM ${predecessor}) >= 0`;
      for (const operation of ["insert", "update", "delete"] as const) {
        const affected = table.rows.filter((row) => {
          const src = row[source],
            dst = row[destination];
          return operation === "insert"
            ? src === null && dst !== null
            : operation === "delete"
              ? src !== null && dst === null
              : src !== null && dst !== null && src !== dst;
        }).length;
        if (!affected) continue;
        const label = `mutation_${mutationCount++}`;
        const causal = `${admission} AND (SELECT count(*) FROM ${predecessor}) >= 0`;
        const matches = table.keys
          .map((key) => {
            return `t.${quoteIdentifier(key)} = p.${quoteIdentifier(key)}`;
          })
          .join(" AND ");
        const statement =
          operation === "insert"
            ? `INSERT INTO ${relation} (${columns})
            SELECT ${table.columns
              .map((column) => {
                return `p.${quoteIdentifier(column)}`;
              })
              .join(",")}
            FROM ${rows} r CROSS JOIN LATERAL jsonb_populate_record(NULL::${relation},r.dst::jsonb) p
            WHERE r.src IS NULL AND r.dst IS NOT NULL AND ${causal} RETURNING *`
            : operation === "update"
              ? `UPDATE ${relation} t SET (${columns}) = (${table.columns
                  .map((column) => {
                    return `p.${quoteIdentifier(column)}`;
                  })
                  .join(",")})
              FROM ${rows} r CROSS JOIN LATERAL jsonb_populate_record(NULL::${relation},r.dst::jsonb) p
              WHERE r.src IS NOT NULL AND r.dst IS NOT NULL AND r.src <> r.dst
              AND ${matches} AND to_jsonb(t)::text = r.src AND ${causal} RETURNING t.*`
              : `DELETE FROM ${relation} t USING ${rows} r,
                LATERAL jsonb_populate_record(NULL::${relation},r.src::jsonb) p
              WHERE r.src IS NOT NULL AND r.dst IS NULL AND ${matches}
              AND to_jsonb(t)::text = r.src AND ${causal} RETURNING t.*`;
        ctes.push(`${label} AS (${statement})`);
        checks.push(`(SELECT count(*) FROM ${label}) = ${affected}`);
        predecessor = label;
        if (name === "chat_threads" && operation === "update")
          chatMutation = label;
        if (
          name === "projects" &&
          operation === (recover ? "delete" : "insert")
        )
          projectMutation = label;
      }
    }
    const metadata = metadataEvents(projectMutation, chatMutation, recover);
    ctes.push(...metadata.ctes);
    checks.push(...metadata.checks);
    // A lost CAS must abort every CTE, not leave a partially published org.
    const result = await db.unsafe(
      `WITH ${ctes.join(",\n")} SELECT 1 / CASE WHEN (SELECT ok FROM admitted)
        ${checks
          .map((check) => {
            return `AND ${check}`;
          })
          .join(" ")} THEN 1 ELSE 0 END AS written`,
      [
        image.scope.orgId,
        image.automationIds,
        db.json(
          image.tables.map((table) => {
            return {
              ...table,
              rows: table.rows.map((row) => {
                return { ...row };
              }),
            };
          }),
        ),
        image.scope.database,
        image.runIds,
      ],
    );
    array(object({ written: literal(1) }))
      .length(1)
      .parse(result);
  } finally {
    await db.end();
  }
}

function metadataEvents(
  projectMutation: string | undefined,
  chatMutation: string | undefined,
  recover: boolean,
) {
  const ctes: string[] = [];
  const checks: string[] = [];
  if (projectMutation) {
    ctes.push(`project_counts AS (SELECT user_id,count(*)::bigint AS total FROM ${projectMutation} GROUP BY user_id),
        project_reserved AS (
          INSERT INTO project_event_sequences(user_id,org_id,last_seq_id)
          SELECT user_id,$1,total FROM project_counts
          ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=project_event_sequences.last_seq_id+EXCLUDED.last_seq_id
          RETURNING user_id,last_seq_id
        ), project_published AS (
          INSERT INTO project_events(id,user_id,org_id,seq_id,project_id,kind,name,created_at)
          SELECT ${recover ? "gen_random_uuid()" : "p.id"},p.user_id,$1,
            r.last_seq_id-c.total+row_number() OVER(PARTITION BY p.user_id ORDER BY p.id),
            p.id,'${recover ? "deleted" : "created"}'::project_event_kind,${recover ? "NULL" : "p.name"},${recover ? "timezone('UTC',statement_timestamp())" : "p.created_at"}
          FROM ${projectMutation} p JOIN project_counts c USING(user_id) JOIN project_reserved r USING(user_id)
          RETURNING id
        )`);
    checks.push(
      `(SELECT count(*) FROM project_published) = (SELECT count(*) FROM ${projectMutation})`,
    );
  }
  if (chatMutation) {
    ctes.push(`chat_counts AS (SELECT user_id,(2*count(*))::bigint AS total FROM ${chatMutation} GROUP BY user_id),
        chat_reserved AS (
          INSERT INTO chat_thread_event_sequences(user_id,org_id,last_seq_id)
          SELECT user_id,$1,total FROM chat_counts
          ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id
          RETURNING user_id,last_seq_id
        ), chat_published AS (
          INSERT INTO chat_thread_events(id,user_id,org_id,seq_id,chat_thread_id,kind,agent_id,reassigned_agent_id,project_id,pin_order,created_at)
          SELECT gen_random_uuid(),p.user_id,$1,
            r.last_seq_id-c.total+row_number() OVER(PARTITION BY p.user_id ORDER BY p.id,event.ordinal),
            p.id,CASE WHEN event.ordinal=1 THEN 'project_updated' ELSE 'sort_touched' END::chat_thread_event_kind,
            p.agent_id,CASE WHEN event.ordinal=2 THEN p.agent_id ELSE NULL END,
            CASE WHEN event.ordinal=1 THEN p.project_id ELSE NULL END,
            CASE WHEN event.ordinal=2 THEN p.pin_order ELSE NULL END,
            CASE WHEN event.ordinal=1 THEN p.updated_at ELSE p.last_message_at END
          FROM ${chatMutation} p JOIN chat_counts c USING(user_id) JOIN chat_reserved r USING(user_id)
          CROSS JOIN (VALUES (1),(2)) event(ordinal)
          RETURNING id
        )`);
    checks.push(
      `(SELECT count(*) FROM chat_published) = 2*(SELECT count(*) FROM ${chatMutation})`,
    );
  }

  return { ctes, checks };
}
