import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { getTableColumns, sql, type SQL, type WithSubquery } from "drizzle-orm";
import { explicitModelSettings } from "@okouai/core/auto-run-model";
import type { DefaultModelFirstPin } from "./model-selection.service";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";

export interface IntegrationChatThreadCreation {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly currentTime: Date;
  readonly initialModel: DefaultModelFirstPin;
}

/** Ordinary values only; validate a default only after the route is absent. */
export function integrationChatThreadValues(
  args: IntegrationChatThreadCreation,
  id: string,
  defaults: {
    readonly modelSettings: ModelSettings;
    readonly cloudBrowserEnabled: boolean;
  },
) {
  return {
    id,
    userId: args.userId,
    agentId: args.agentId,
    selectedModel: args.initialModel.selectedModel,
    codexServiceTier:
      args.initialModel.serviceTier === "priority" ? ("fast" as const) : null,
    modelSettings: explicitModelSettings(defaults.modelSettings),
    cloudBrowserEnabled: defaults.cloudBrowserEnabled,
    title: null,
    lastReadAt: args.currentTime,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

export function integrationThreadCreatedEventSql(
  orgId: string,
  thread: ReturnType<typeof integrationChatThreadValues>,
  source?: Parameters<typeof chatThreadEventInsertSql>[1],
) {
  return chatThreadEventInsertSql(
    {
      kind: "created",
      orgId,
      userId: thread.userId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      title: thread.title,
      selectedModel: thread.selectedModel,
      modelSettings: thread.modelSettings,
      serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
      computerUseHostId: null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      createdAt: thread.createdAt,
    },
    source,
  );
}

type IntegrationChatThreadValues = ReturnType<
  typeof integrationChatThreadValues
>;

/**
 * `INSERT INTO chat_threads … SELECT … FROM <inserted route CTE>`: the thread
 * row exists only when the same statement's `ON CONFLICT DO NOTHING` route
 * insert won. The route's thread FK is checked at statement end, so a losing
 * creator never writes a speculative thread that must be deleted again.
 */
export function integrationChatThreadInsertFromRouteSql(
  thread: IntegrationChatThreadValues,
  insertedRoute: WithSubquery,
): SQL {
  const columns = getTableColumns(chatThreads);
  const entries = (
    Object.keys(thread) as (keyof IntegrationChatThreadValues)[]
  ).map((key) => {
    return { column: columns[key], value: thread[key] };
  });
  const names = entries.map(({ column }) => {
    return sql.identifier(column.name);
  });
  // Parameter types are inferred from the INSERT target columns.
  const values = entries.map(({ column, value }) => {
    return sql.param(value, column);
  });
  return sql`INSERT INTO ${chatThreads} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(values, sql`, `)} FROM ${insertedRoute}`;
}
