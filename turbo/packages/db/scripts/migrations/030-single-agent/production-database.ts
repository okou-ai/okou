import postgres from "postgres";
import { array, boolean, object, string } from "zod";
import { executionTables } from "./execution-model";
import { PlanningError } from "./snapshot";

// The caller has already bound the URI to the explicit production target.
const privilegesSchema = object({
  login: string(),
  readonly: boolean(),
  database: string(),
  tables: array(
    object({
      name: string(),
      select: boolean(),
      writable: boolean(),
      insert: boolean(),
      update: boolean(),
      delete: boolean(),
    }),
  ),
});
const mutationTables = new Set([
  "projects",
  "workflows",
  "instructions",
  "chat_threads",
  "workflow_automations",
  "workflow_user_automation_threads",
  "agent_runs",
  "official_workflow_automation_identities",
  ...executionTables
    .filter((table) => {
      return table.scope === "automation";
    })
    .map((table) => {
      return table.name;
    }),
  "project_events",
  "project_event_sequences",
  "chat_thread_events",
  "chat_thread_event_sequences",
]);

export async function checkPrivileges(
  connection: string,
  role: string,
  writable: boolean,
) {
  const db = postgres(connection, { max: 1, onnotice() {} });
  try {
    const session = await db.reserve();
    try {
      await session`SET default_transaction_read_only = on`;
      await session`SET statement_timeout = '60s'`;
      const names = [
        ...new Set([
          ...executionTables.map((table) => {
            return table.name;
          }),
          "active_agent_runs",
          "queued_chat_threads",
          "project_events",
          "project_event_sequences",
          "chat_thread_events",
          "chat_thread_event_sequences",
        ]),
      ];
      const rows = await session`SELECT jsonb_build_object(
        'login',session_user,'readonly',current_setting('transaction_read_only')='on','database',current_database(),
        'tables',(SELECT jsonb_agg(jsonb_build_object('name',name,
          'select',has_table_privilege(current_user,'public.'||name,'SELECT'),
          'writable',has_table_privilege(current_user,'public.'||name,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(current_user,'public.'||name,'INSERT,UPDATE'),
          'insert',has_table_privilege(current_user,'public.'||name,'INSERT'),
          'update',has_table_privilege(current_user,'public.'||name,'UPDATE'),
          'delete',has_table_privilege(current_user,'public.'||name,'DELETE')))
          FROM unnest(${names}::text[]) name)) AS value`;
      const [row] = array(object({ value: privilegesSchema }))
        .length(1)
        .parse(rows);
      const value = row!.value;
      if (
        value.login !== role ||
        value.database !==
          decodeURIComponent(new URL(connection).pathname.slice(1)) ||
        !value.readonly ||
        value.tables.some((table) => {
          return (
            !table.select ||
            (!writable && table.writable) ||
            (writable &&
              mutationTables.has(table.name) &&
              (!table.insert || !table.update || !table.delete))
          );
        })
      )
        throw new PlanningError("ProductionDatabasePrivilegesRejected");
      return value;
    } finally {
      session.release();
    }
  } finally {
    await db.end();
  }
}
