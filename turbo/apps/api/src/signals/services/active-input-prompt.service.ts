import { command } from "ccstate";
import { ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import { loadAgentPhoneQueuedLaunchMaterial } from "./agentphone-queued-launch-context.service";
import { loadFeishuQueuedLaunchMaterial } from "./feishu-queued-launch-context.service";
import { loadSlackQueuedLaunchMaterial } from "./slack-queued-launch-context.service";
import {
  DiscordQueuedLaunchUnavailableError,
  loadDiscordQueuedLaunchMaterial$,
} from "./discord-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial } from "./teams-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial } from "./telegram-queued-launch-context.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

type ChatEventContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

type ContextBackedContextType =
  "slack" | "feishu" | "teams" | "discord" | "telegram" | "agentphone";

interface ActiveInputPromptEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.budget";
  readonly contextType: ChatEventContextType;
  readonly userMessage: ChatEventUserMessage;
}

interface IntegrationPromptMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
}

const CONTEXT_BACKED_CONTEXT_TYPES: readonly ContextBackedContextType[] = [
  "slack",
  "feishu",
  "teams",
  "discord",
  "telegram",
  "agentphone",
];

export function activeInputDeliveryPromptFitsControlPayload(
  deliveryId: string,
  prompt: string,
): boolean {
  return activeInputControlPayloadFits({
    type: "active-input",
    deliveryId,
    text: prompt,
  });
}

function activeInputControlPayloadFits(payload: object): boolean {
  const serialized = JSON.stringify(payload);
  return (
    new TextEncoder().encode(serialized).byteLength <=
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
  );
}

/** Load active-input source events of one thread by id, without locks. */
export function activeInputRowsByIds(
  db: Pick<Db, "select">,
  chatThreadId: string,
  eventIds: readonly string[],
) {
  return db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      createdAt: chatEvents.createdAt,
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      userMessage: canonicalChatEventUserMessage(),
      modelSelection: canonicalChatInputModelSelection(),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        inArray(chatEvents.id, eventIds),
      ),
    );
}

export type ActiveInputSourceRow = Awaited<
  ReturnType<typeof activeInputRowsByIds>
>[number];

/** Render one pending active input for steering. */
export const materializeActiveInputSource$ = command(
  async (
    { set },
    db: Db,
    source: ActiveInputSourceRow,
    auth: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string> => {
    if (
      !source.userMessage ||
      (source.eventType !== "input.prompt" &&
        source.eventType !== "input.budget")
    ) {
      throw new Error("Pending active input cannot be materialized");
    }
    if (source.contextType === null) {
      throw new Error("Pending active input is missing its context type");
    }
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    return await set(
      materializeActiveInputPrompt$,
      db,
      {
        event: {
          id: source.id,
          chatThreadId: source.chatThreadId,
          eventType: source.eventType,
          contextType: source.contextType,
          userMessage: source.userMessage,
        },
        orgId: auth.orgId,
        userId: auth.userId,
        featureSwitchContext,
      },
      signal,
    );
  },
);

function activeInputGenerationTemplates(userMessage: ChatEventUserMessage) {
  const projection = projectUserMessage(userMessage);
  return {
    projection,
    templatePrompt: resolveThreadGenerationTemplatePrompt({
      explicit: projection.primaryTemplate,
      explicitTemplates: projection.templates,
      // Steered into a run that is already executing, whose volumes were fixed
      // when it was created. There is no package to point the agent at, so a
      // private template contributes no guidance rather than a dangling path.
      // The custom catalog is mounted the same way and loses it for the same
      // reason.
      mountedUserPresentationTemplateIds: [],
      mountedUserTemplates: [],
    }),
  };
}

function isContextBackedContextType(
  contextType: ChatEventContextType,
): contextType is ContextBackedContextType {
  return CONTEXT_BACKED_CONTEXT_TYPES.some((candidate) => {
    return candidate === contextType;
  });
}

const loadIntegrationPromptMaterial$ = command(
  async (
    { set },
    db: Db,
    event: ActiveInputPromptEvent,
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<IntegrationPromptMaterial | null> => {
    const loaderArgs = {
      eventId: event.id,
      chatThreadId: event.chatThreadId,
      orgId: args.orgId,
      userId: args.userId,
      featureSwitchContext: args.featureSwitchContext,
    };
    switch (event.contextType) {
      case "slack": {
        return await loadSlackQueuedLaunchMaterial(db, loaderArgs);
      }
      case "feishu": {
        return await loadFeishuQueuedLaunchMaterial(db, loaderArgs);
      }
      case "discord": {
        return await set(
          loadDiscordQueuedLaunchMaterial$,
          db,
          loaderArgs,
          signal,
        );
      }
      case "teams": {
        return await loadTeamsQueuedLaunchMaterial(db, loaderArgs);
      }
      case "telegram": {
        return await loadTelegramQueuedLaunchMaterial(db, loaderArgs);
      }
      case "agentphone": {
        return await loadAgentPhoneQueuedLaunchMaterial(db, loaderArgs);
      }
      case "web":
      case "automation":
      case "agent_run": {
        return null;
      }
      default: {
        return unreachableActiveInputContextType(event.contextType);
      }
    }
  },
);

function unreachableActiveInputContextType(contextType: never): never {
  throw new Error(`Unsupported active input context type: ${contextType}`);
}

/** Materialize one pending input prompt into the same text capability as a run prompt. */
const materializeActiveInputPrompt$ = command(
  async (
    { set },
    db: Db,
    args: {
      readonly event: ActiveInputPromptEvent;
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const userMessage = requiredUserMessageForEvent(
      args.event.eventType,
      args.event.userMessage,
    );
    if (!userMessage) {
      throw new Error("Active input event is missing userMessage");
    }
    const integration = await set(
      loadIntegrationPromptMaterial$,
      db,
      args.event,
      args,
      signal,
    );
    if (args.event.contextType === "discord" && !integration) {
      throw new DiscordQueuedLaunchUnavailableError();
    }
    if (isContextBackedContextType(args.event.contextType) && !integration) {
      throw new Error(
        `${args.event.contextType} active input is missing launch material`,
      );
    }
    const { projection, templatePrompt } =
      activeInputGenerationTemplates(userMessage);
    const prompt = integration?.prompt ?? projection.agentPrompt;
    const parts = [
      integration?.appendSystemPrompt ?? "",
      templatePrompt,
      prompt,
    ].filter((part) => {
      return part.length > 0;
    });
    const materialized = parts.join("\n\n");
    if (materialized.length === 0) {
      throw new Error("Active input event materialized to an empty prompt");
    }
    return materialized;
  },
);
