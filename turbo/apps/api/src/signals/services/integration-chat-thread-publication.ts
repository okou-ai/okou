import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
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
  if (!args.initialModel.selectedModel) {
    throw new Error("A model selection is required");
  }
  return {
    id,
    userId: args.userId,
    agentId: args.agentId,
    selectedModel: args.initialModel.selectedModel,
    codexServiceTier:
      args.initialModel.serviceTier === "priority"
        ? ("fast" as const)
        : args.initialModel.serviceTier === "ultrafast"
          ? ("ultrafast" as const)
          : null,
    modelSettings: defaults.modelSettings,
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
) {
  return chatThreadEventInsertSql({
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
  });
}
