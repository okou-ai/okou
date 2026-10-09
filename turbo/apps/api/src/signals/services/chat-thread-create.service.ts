import {
  AUTO_SELECTED_MODEL,
  isAutoSelectedModel,
  explicitModelSettings,
} from "@okouai/core/auto-run-model";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";

interface NewChatThreadArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly id?: string;
  readonly title?: string | null;
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly lastReadAt?: Date | SQL;
  readonly lastMessageAt?: Date;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

type CreatedThread = Pick<
  typeof chatThreads.$inferSelect,
  | "id"
  | "userId"
  | "title"
  | "selectedModel"
  | "modelSettings"
  | "codexServiceTier"
  | "computerUseHostId"
  | "cloudBrowserEnabled"
  | "createdAt"
> & {
  readonly agentId: string;
};

/** Pure INSERT plan. The owning command executes it in its own statement. */
export function prepareChatThreadInsert(args: NewChatThreadArgs) {
  const builder = new QueryBuilder();
  const defaults = builder.$with("new_chat_thread_defaults").as(
    builder
      .select({
        modelSettings: sql`COALESCE((
          SELECT jsonb_object_agg(key, value)
          FROM jsonb_each(${orgMembersMetadata.modelSettings})
          WHERE key NOT IN ('auto', 'okou-1.0') AND key NOT LIKE '@preset/%'
        ), '{}'::jsonb)`
          .mapWith(orgMembersMetadata.modelSettings)
          .as("model_settings"),
        cloudBrowserEnabled: orgMembersMetadata.cloudBrowserEnabledByDefault,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1),
  );
  const { orgId: _orgId, ...values } = args;
  const computerUseHostId =
    args.cloudBrowserEnabled === true ? null : (args.computerUseHostId ?? null);
  return {
    // Omit the member lookup entirely when the owner supplied both defaults.
    // Standalone creation can still resolve omitted preferences atomically.
    defaults:
      args.modelSettings !== undefined && args.cloudBrowserEnabled !== undefined
        ? []
        : [defaults],
    values: {
      ...values,
      selectedModel:
        args.selectedModel === null || isAutoSelectedModel(args.selectedModel)
          ? AUTO_SELECTED_MODEL
          : args.selectedModel,
      modelSettings:
        args.modelSettings === undefined
          ? sql`COALESCE((SELECT ${defaults.modelSettings} FROM ${defaults}), '{}'::jsonb)`
          : explicitModelSettings(args.modelSettings),
      computerUseHostId,
      cloudBrowserEnabled: computerUseHostId
        ? false
        : (args.cloudBrowserEnabled ??
          sql`COALESCE((SELECT ${defaults.cloudBrowserEnabled} FROM ${defaults}), true)`),
    },
  };
}

/** Pure list-event statement; execution stays with the creation owner. */
export function chatThreadCreatedEventSql(args: {
  readonly orgId: string;
  readonly eventId?: string;
  readonly thread: CreatedThread;
}) {
  const { thread } = args;
  return chatThreadEventInsertSql({
    kind: "created",
    userId: thread.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId: args.eventId,
    title: thread.title,
    selectedModel: thread.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
    computerUseHostId: thread.computerUseHostId,
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    createdAt: thread.createdAt,
  });
}

/** Validate the stored preferences before the creation owner may commit. */
export function createdChatThreadFromRow(
  row: Omit<CreatedThread, "agentId">,
  agentId: string,
): CreatedThread {
  return {
    ...row,
    modelSettings: modelSettingsSchema.parse(row.modelSettings),
    agentId,
  };
}
