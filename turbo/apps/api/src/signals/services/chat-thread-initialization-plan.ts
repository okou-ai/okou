import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { count, exists, gte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { prepareChatEvent } from "./chat-event.service";
import { initialRemoteAccessValues } from "./chat-remote-access.service";
import {
  initialChatThreadConnectorSelectionStatements,
  type PreparedChatThreadConnectorSelection,
} from "./chat-thread-connector-selection.service";
import {
  chatThreadCreatedEventPlan,
  type createdChatThreadFromRow,
} from "./chat-thread-create.service";

function completedWrite(name: string) {
  return gte(
    new QueryBuilder()
      .select({ count: count() })
      .from(sql`${sql.identifier(name)}`),
    0,
  );
}

function remoteOverrideValues(
  values: readonly {
    readonly chatThreadId: string;
    readonly connectionId: string;
    readonly enabled: boolean;
  }[],
) {
  return sql.join(
    values.map((value) => {
      return sql`(${value.chatThreadId}::uuid, ${value.connectionId}::uuid, ${value.enabled}::boolean)`;
    }),
    sql`, `,
  );
}

/** Every child is gated by the winning INSERT, including both event sequences. */
export function chatThreadInitializationCtes(args: {
  readonly orgId: string;
  readonly eventId: string | undefined;
  readonly thread: ReturnType<typeof createdChatThreadFromRow>;
  readonly selections: readonly PreparedChatThreadConnectorSelection[];
  readonly required: boolean;
  readonly remoteOverrides: readonly InitialRemoteAccessOverride[];
  readonly assistantMessage: string | undefined;
}) {
  const created = exists(
    new QueryBuilder()
      .select({})
      .from(sql`${sql.identifier("created_chat_thread")}`),
  );
  const selectionGates = args.selections.map((_, index) => {
    return index === 0
      ? created
      : sql`${created} AND ${completedWrite(`initial_connector_selection_${String(index - 1)}`)}`;
  });
  const statements = initialChatThreadConnectorSelectionStatements(
    {
      chatThreadId: args.thread.id,
      selections: args.selections,
      required: args.required,
    },
    selectionGates,
  );
  const ctes = statements.map((statement, index) => {
    return sql`${sql.identifier(`initial_connector_selection_${String(index)}`)} AS (${statement})`;
  });
  let ready =
    statements.length === 0
      ? created
      : sql`${created} AND ${completedWrite(`initial_connector_selection_${String(statements.length - 1)}`)}`;
  const remote = initialRemoteAccessValues(
    args.thread.id,
    args.remoteOverrides,
  );
  if (remote.ssh.length > 0) {
    ctes.push(sql`initial_ssh_access AS (
      INSERT INTO ${chatThreadSshAccessOverrides} (chat_thread_id, connection_id, enabled)
      SELECT value.chat_thread_id, value.connection_id, value.enabled
      FROM (VALUES ${remoteOverrideValues(remote.ssh)}) AS value(chat_thread_id, connection_id, enabled)
      WHERE ${ready}
      RETURNING ${chatThreadSshAccessOverrides.chatThreadId}
    )`);
    ready = sql`${created} AND ${completedWrite("initial_ssh_access")}`;
  }
  if (remote.vnc.length > 0) {
    ctes.push(sql`initial_vnc_access AS (
      INSERT INTO ${chatThreadVncAccessOverrides} (chat_thread_id, connection_id, enabled)
      SELECT value.chat_thread_id, value.connection_id, value.enabled
      FROM (VALUES ${remoteOverrideValues(remote.vnc)}) AS value(chat_thread_id, connection_id, enabled)
      WHERE ${ready}
      RETURNING ${chatThreadVncAccessOverrides.chatThreadId}
    )`);
    ready = sql`${created} AND ${completedWrite("initial_vnc_access")}`;
  }
  const event = chatThreadCreatedEventPlan(
    { orgId: args.orgId, eventId: args.eventId, thread: args.thread },
    {
      gate: ready,
      agentId: sql`${args.thread.agentId}`,
      reservationSource: sql`${sql.identifier("created_thread_events_reserved")}`,
    },
  );
  ctes.push(
    sql`created_thread_events_reserved AS (${event.reservation})`,
    sql`created_thread_created_event AS (${event.insertion})`,
  );
  if (args.assistantMessage !== undefined) {
    const seed = prepareChatEvent({
      chatThreadId: args.thread.id,
      eventType: "output.message",
      content: args.assistantMessage,
      createdAt: nowDate(),
    });
    ctes.push(
      canonicalChatEventAppendCtes(
        [seed.row],
        "none",
        sql`${created} AND ${completedWrite("created_thread_created_event")}`,
      ),
    );
  }
  return ctes;
}
