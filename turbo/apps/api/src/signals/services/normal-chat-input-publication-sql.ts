import { chatRelations } from "@okouai/db/schema/chat-relation";
import { chatThreadEventSequences } from "@okouai/db/schema/chat-thread-event";
import {
  count,
  getTableColumns,
  SQL,
  sql,
  type InferInsertModel,
} from "drizzle-orm";
import { PgDialect, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import {
  canonicalChatEventAppendCtes,
  type PreparedChatEventRow,
  type ChatEventAppendConflict,
  type ChatEventRelationSource,
} from "./chat-event-append.service";

export const normalChatInputWritten = sql`EXISTS (SELECT 1 FROM inserted)`;

/** A write keeps the original predecessor's lock order, including empty results. */
export function normalChatInputWriteGate(previous?: string): SQL {
  return previous === undefined
    ? normalChatInputWritten
    : sql`${normalChatInputWritten} AND (SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0`;
}

type NormalInputWriteValues<T extends PgTable> = {
  readonly [K in keyof InferInsertModel<T>]?: InferInsertModel<T>[K] | SQL;
};

function insertFields<T extends PgTable>(
  table: T,
  values: NormalInputWriteValues<T>,
) {
  const columns = getTableColumns(table);
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error("Chat input write contains an unknown column");
    }
    return [
      {
        key,
        column,
        value: value instanceof SQL ? value : sql.param(value, column),
      },
    ];
  });
}

/** Conditional partial INSERT preserves omitted database defaults and encoders. */
export function normalChatInputInsertSql<T extends PgTable>(
  table: T,
  values: InferInsertModel<T>,
  gate: SQL,
  onConflict: SQL,
  returning: SQL = sql`1`,
): SQL {
  const fields = insertFields(table, values);
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )})
    SELECT ${sql.join(
      fields.map(({ value }) => {
        return value;
      }),
      sql`, `,
    )} WHERE ${gate}
    ON CONFLICT ${onConflict} RETURNING ${returning}`;
}

export function normalChatInputConflictSql<T extends PgTable>(
  table: T,
  target: readonly PgColumn[],
  values: NormalInputWriteValues<T>,
): SQL {
  const set = normalChatInputUpdateSet(table, values);
  return sql`(${sql.join(
    target.map((column) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )}) DO UPDATE SET ${new PgDialect().buildUpdateSet(table, set)}`;
}

export function normalChatInputUpdateSet<T extends PgTable>(
  table: T,
  values: NormalInputWriteValues<T>,
) {
  const columns = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const column = columns[key];
      if (!column || value === undefined) {
        throw new Error("Chat input conflict write contains an invalid column");
      }
      return [key, value instanceof SQL ? value : sql.param(value, column)];
    }),
  );
}

/** Preserve canonical/generated identities while checking the current asset row. */
export function normalChatInputConditionalValues<T extends PgTable>(
  table: T,
  values: NormalInputWriteValues<T>,
  condition: SQL,
): Readonly<Record<string, SQL>> {
  return Object.fromEntries(
    insertFields(table, values).map(({ key, column, value }) => {
      return [
        key,
        sql`CASE WHEN ${condition} THEN ${value} ELSE ${column} END`,
      ];
    }),
  );
}

export interface NormalChatInputListEvent {
  readonly insertion: SQL;
  readonly gate: SQL;
}
export interface NormalChatInputWrite {
  readonly name: string;
  readonly statement: SQL;
}
export interface NormalChatInputGuard {
  readonly condition: SQL;
  readonly token: string;
}
export interface NormalChatInputPublication {
  readonly userId: string;
  readonly orgId: string;
  readonly newThread?: SQL;
  readonly row?: PreparedChatEventRow;
  readonly conflict: ChatEventAppendConflict;
  readonly relation?: ChatEventRelationSource;
  readonly context?: SQL;
  readonly threadLock?: SQL;
  readonly threadWrite?: SQL;
  readonly listEvents: readonly NormalChatInputListEvent[];
  readonly writes: readonly NormalChatInputWrite[];
  readonly guards: readonly NormalChatInputGuard[];
}

function listEventCtes(plan: NormalChatInputPublication): SQL[] {
  if (plan.listEvents.length === 0) {
    return [];
  }
  const counts = plan.listEvents.map(({ gate }) => {
    return sql`CASE WHEN ${gate} THEN 1 ELSE 0 END`;
  });
  const total = sql.join(counts, sql` + `);
  const reservation = sql`normal_send_list_sequence AS (
    INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
    SELECT ${plan.userId}, ${plan.orgId}, ${total} WHERE (${total}) > 0
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + EXCLUDED.last_seq_id
    RETURNING last_seq_id
  )`;
  return [
    reservation,
    ...plan.listEvents.map((event, index) => {
      const following = counts.slice(index + 1);
      const offset = following.length ? sql.join(following, sql` + `) : sql`0`;
      // The nested WITH is read-only; the one outer reservation owns every event.
      return sql`${sql.identifier("normal_send_list_event_" + index)} AS (
      WITH reserved AS (
        SELECT last_seq_id - (${offset}) AS last_seq_id FROM normal_send_list_sequence WHERE ${event.gate}
      ) ${event.insertion}
    )`;
    }),
  ];
}

function relationCte(source: ChatEventRelationSource): SQL {
  return sql`normal_send_relations AS (
    INSERT INTO ${chatRelations} (
      org_id, user_id, type, source_chat_thread_id, target_chat_thread_id,
      source_run_id, message_event_id, created_at
    ) SELECT ${source.orgId}, ${source.userId}, action.type,
      ${source.threadId}, input."chatThreadId", ${source.runId},
      CASE WHEN action.type = 'message' THEN inserted.id ELSE NULL END,
      inserted.created_at
    FROM input JOIN inserted ON inserted.id = input.id
    CROSS JOIN (VALUES ('message'), ('created')) AS action(type)
    WHERE input."chatThreadId" <> ${source.threadId}::uuid
      AND (action.type = 'message' OR ${source.createsThread})
    RETURNING id
  )`;
}

/** The normal send's existing counters, input and dependent writes commit once. */
export function normalChatInputPublicationSql(
  plan: NormalChatInputPublication,
): SQL {
  const ctes: SQL[] = [];
  const list = listEventCtes(plan);
  if (plan.newThread) {
    ctes.push(sql`normal_send_thread AS (${plan.newThread})`, ...list);
  }
  const listCreation =
    plan.newThread && list.length
      ? sql`AND (SELECT ${count()} FROM normal_send_list_event_0) >= 0`
      : sql.empty();
  const eligible = plan.newThread
    ? sql`EXISTS (SELECT 1 FROM normal_send_thread) ${listCreation}`
    : undefined;
  ctes.push(
    canonicalChatEventAppendCtes(
      plan.row ? [plan.row] : [],
      plan.conflict,
      eligible,
    ),
  );
  if (plan.relation) {
    ctes.push(relationCte(plan.relation));
  }
  if (plan.context) {
    ctes.push(sql`normal_send_context AS (${plan.context})`);
  }
  if (plan.threadLock) {
    ctes.push(sql`normal_send_thread_lock AS (${plan.threadLock})`);
  }
  if (plan.threadWrite) {
    ctes.push(sql`normal_send_thread_write AS (${plan.threadWrite})`);
  }
  if (!plan.newThread) {
    ctes.push(...list);
  }
  ctes.push(
    ...plan.writes.map(({ name, statement }) => {
      return sql`${sql.identifier(name)} AS (${statement})`;
    }),
  );
  const guard = plan.guards.length
    ? sql`CASE ${sql.join(
        plan.guards.map(({ condition, token }) => {
          return sql`WHEN ${condition} THEN ${token}`;
        }),
        sql` `,
      )} ELSE '0' END`
    : sql`'0'`;
  return sql`WITH ${sql.join(ctes, sql`,\n`)}
    SELECT (SELECT id FROM inserted) AS id,
      (SELECT created_at::text FROM inserted) AS "createdAt",
      (SELECT seq_id FROM inserted) AS "seqId", (${guard})::integer AS "atomicGuard"`;
}
