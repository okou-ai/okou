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
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";

import type { Db } from "../external/db";
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
    db: Db,
    source: ActiveInputSourceRow,
    auth: {
      readonly orgId: string;
      readonly userId: string;
      readonly disabledPaidTools: readonly string[] | undefined;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
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
    const templates = projectUserMessage(source.userMessage).templates;
    // Older active Runs have no retained policy once their queue job is claimed.
    // Keep template inputs queued until the next Run; remove after pre-capture
    // API writers, active Runs and rollback targets have drained (#42436).
    if (templates.length > 0 && auth.disabledPaidTools === undefined) {
      return null;
    }
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.BuiltinDocumentTemplates,
        featureSwitchContext,
      ) &&
      projectUserMessage(source.userMessage).templates.some((template) => {
        return template.type === "document";
      })
    ) {
      return null;
    }
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
        disabledPaidTools: auth.disabledPaidTools,
        featureSwitchContext,
      },
      signal,
    );
  },
);

function activeInputGenerationTemplates(
  userMessage: ChatEventUserMessage,
  disabledPaidTools: readonly string[] | undefined,
) {
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
      disabledPaidTools,
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
        return await set(loadSlackQueuedLaunchMaterial$, loaderArgs);
      }
      case "feishu": {
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
    { set },
    db: Db,
    args: {
      readonly event: ActiveInputPromptEvent;
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
      readonly disabledPaidTools: readonly string[] | undefined;
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
    if (args.event.contextType === "wechat" && !integration) {
      throw new WechatLaunchUnavailableError();
    }
    if (isContextBackedContextType(args.event.contextType) && !integration) {
      throw new Error(
        `${args.event.contextType} active input is missing launch material`,
      );
    }
    const { projection, templatePrompt } = activeInputGenerationTemplates(
      userMessage,
      args.disabledPaidTools,
    );
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
