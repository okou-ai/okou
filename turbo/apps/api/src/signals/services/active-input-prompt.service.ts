import {
  loadWechatQueuedLaunchMaterial$,
  WechatLaunchUnavailableError,
} from "./wechat-context.service";
import { command } from "ccstate";
import { ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import { loadAgentPhoneQueuedLaunchMaterial$ } from "./agentphone-queued-launch-context.service";
import {
  feishuQueuedLaunchContextReadPlan,
  feishuQueuedLaunchMaterialFromContext,
  requiredFeishuLaunchContext,
} from "./feishu-queued-launch-context.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";
import { loadSlackQueuedLaunchMaterial$ } from "./slack-queued-launch-context.service";
import {
  DiscordQueuedLaunchUnavailableError,
  loadDiscordQueuedLaunchMaterial$,
} from "./discord-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial$ } from "./teams-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial$ } from "./telegram-queued-launch-context.service";
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
  | "wechat"
  | "slack"
  | "feishu"
  | "teams"
  | "discord"
  | "telegram"
  | "agentphone";

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
  "wechat",
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

/** Mapped fields for an active-input source read. */
export function activeInputSourceFields() {
  return {
    id: chatEvents.id,
    chatThreadId: chatEvents.chatThreadId,
    createdAt: chatEvents.createdAt,
    runId: chatEvents.runId,
    eventType: chatEvents.eventType,
    contextType: chatEvents.contextType,
    contextId: chatEvents.contextId,
    userMessage: canonicalChatEventUserMessage(),
    modelSelection: canonicalChatInputModelSelection(),
  };
}

export type ActiveInputSourceRow = SelectResultFields<
  ReturnType<typeof activeInputSourceFields>
>;

/** Render one pending active input for steering. */
export const materializeActiveInputSource$ = command(
  async (
    { set },
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

function isContextBackedContextType(
  contextType: ChatEventContextType,
): contextType is ContextBackedContextType {
  return CONTEXT_BACKED_CONTEXT_TYPES.some((candidate) => {
    return candidate === contextType;
  });
}

const loadIntegrationPromptMaterial$ = command(
  async (
    { get, set },
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
        return await set(loadSlackQueuedLaunchMaterial$, loaderArgs);
      }
      case "feishu": {
        const db = get(db$);
        return await (async () => {
          const context = await (async () => {
            const plan = feishuQueuedLaunchContextReadPlan(loaderArgs);
            const [row] = await db
              .select(plan.columns)
              .from(chatEvents)
              .innerJoin(chatFeishuContext, plan.contextJoin)
              .innerJoin(feishuChatThreadRoutes, plan.routeJoin)
              .innerJoin(feishuOrgConnections, plan.connectionJoin)
              .innerJoin(feishuOrgInstallations, plan.installationJoin)
              .where(plan.condition)
              .limit(1);
            if (
              row &&
              !(await (async () => {
                const availability = feishuInstallationAvailabilityReadPlan({
                  ...row,
                  orgId: loaderArgs.orgId,
                });
                if (availability.kind === "resolved") {
                  return availability.enabled;
                }
                const rows = await db
                  .select(availability.columns)
                  .from(userFeatureSwitches)
                  .where(availability.condition);
                return feishuInstallationEnabledFromRows(
                  availability.scope,
                  rows,
                );
              })())
            ) {
              return null;
            }
            return requiredFeishuLaunchContext(row);
          })();
          return feishuQueuedLaunchMaterialFromContext(
            context,
            loaderArgs.featureSwitchContext,
          );
        })();
      }
      case "wechat": {
        return await set(loadWechatQueuedLaunchMaterial$, loaderArgs, signal);
      }
      case "discord": {
        return await set(loadDiscordQueuedLaunchMaterial$, loaderArgs, signal);
      }
      case "teams": {
        return await set(loadTeamsQueuedLaunchMaterial$, loaderArgs, signal);
      }
      case "telegram": {
        return await set(loadTelegramQueuedLaunchMaterial$, loaderArgs);
      }
      case "agentphone": {
        return await set(loadAgentPhoneQueuedLaunchMaterial$, loaderArgs);
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
    { get, set },
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
      args.event,
      args,
      signal,
    );
    if (args.event.contextType === "discord" && !integration) {
      throw new DiscordQueuedLaunchUnavailableError();
    }
    if (args.event.contextType === "wechat" && !integration) {
      throw new WechatLaunchUnavailableError();
    }
    if (isContextBackedContextType(args.event.contextType) && !integration) {
      throw new Error(
        `${args.event.contextType} active input is missing launch material`,
      );
    }
    const projection = projectUserMessage(userMessage);
    const [disabledImageGeneration] =
      projection.templates.length === 0
        ? []
        : await get(db$)
            .select({ toolId: userDisabledPaidTools.toolId })
            .from(userDisabledPaidTools)
            .where(
              and(
                eq(userDisabledPaidTools.orgId, args.orgId),
                eq(userDisabledPaidTools.userId, args.userId),
                eq(userDisabledPaidTools.toolId, "image-generation"),
              ),
            )
            .limit(1);
    signal.throwIfAborted();
    const templatePrompt = resolveThreadGenerationTemplatePrompt({
      explicit: projection.primaryTemplate,
      explicitTemplates: projection.templates,
      includeManagedImageInstructions: disabledImageGeneration === undefined,
      // Steer cannot change the volumes fixed at Run creation, so private and
      // custom templates contribute no guidance pointing at an unmounted path.
      mountedUserPresentationTemplateIds: [],
      mountedUserTemplates: [],
    });
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
