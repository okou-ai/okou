import { loadIntroVideoTemplateAccess } from "./intro-video-access.service";
import { ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import type { GenerationTemplateIdentity } from "@okouai/core/generation-template-identity";
import { loadAgentPhoneQueuedLaunchMaterial } from "./agentphone-queued-launch-context.service";
import { loadFeishuQueuedLaunchMaterial } from "./feishu-queued-launch-context.service";
import { loadSlackQueuedLaunchMaterial } from "./slack-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial } from "./teams-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial } from "./telegram-queued-launch-context.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import { pendingActiveInputCondition } from "./chat-event-queue.service";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

type ChatEventContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

type ContextBackedContextType =
  | "slack"
  | "feishu"
  | "teams"
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

interface PendingActiveInputRowFilter {
  readonly eventIds: readonly string[] | undefined;
  readonly eventType: "input.prompt" | "input.budget" | undefined;
}

function selectPendingActiveInputRows(
  db: Pick<Db, "select">,
  chatThreadId: string,
  runId: string,
  filter: PendingActiveInputRowFilter,
) {
  return db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      createdAt: chatEvents.createdAt,
      eventType: chatEvents.eventType,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      userMessage: canonicalChatEventUserMessage(),
      seqId: chatEvents.seqId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        pendingActiveInputCondition(db, runId),
        filter.eventIds ? inArray(chatEvents.id, filter.eventIds) : undefined,
        filter.eventType
          ? eq(chatEvents.eventType, filter.eventType)
          : undefined,
      ),
    )
    .orderBy(asc(chatEvents.seqId));
}

export function pendingActiveInputRows(
  db: Pick<Db, "select">,
  chatThreadId: string,
  runId: string,
  eventIds?: readonly string[],
) {
  return selectPendingActiveInputRows(db, chatThreadId, runId, {
    eventIds,
    eventType: undefined,
  });
}

export function pendingActiveInputBudgetRows(
  db: Pick<Db, "select">,
  chatThreadId: string,
  runId: string,
) {
  return selectPendingActiveInputRows(db, chatThreadId, runId, {
    eventIds: undefined,
    eventType: "input.budget",
  });
}

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
      seqId: chatEvents.seqId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        inArray(chatEvents.id, eventIds),
      ),
    )
    .orderBy(asc(chatEvents.seqId));
}

export type PendingActiveInputRow = Awaited<
  ReturnType<typeof pendingActiveInputRows>
>[number];

/**
 * One pending active input, rendered for delivery.
 *
 * `templateIdentities` travels with the prompt rather than being reported here:
 * materialization runs again whenever an open delivery is retrieved or a
 * reservation retries, so reporting at this point would count one steered
 * prompt several times. The caller reports it once, when the delivery row is
 * created.
 */
export interface MaterializedActiveInputPrompt {
  readonly prompt: string;
  readonly templateIdentities: readonly GenerationTemplateIdentity[];
}

export async function materializePendingActiveInputPrompts(
  db: Db,
  candidates: readonly PendingActiveInputRow[],
  auth: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<Map<string, MaterializedActiveInputPrompt> | null> {
  const prompts = new Map<string, MaterializedActiveInputPrompt>();
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  for (const event of candidates) {
    if (
      !event.userMessage ||
      (event.eventType !== "input.prompt" && event.eventType !== "input.budget")
    ) {
      return null;
    }
    if (event.contextType === null) {
      throw new Error("Pending active input is missing its context type");
    }
    prompts.set(
      event.id,
      await materializeActiveInputPrompt(db, {
        event: {
          id: event.id,
          chatThreadId: event.chatThreadId,
          eventType: event.eventType,
          contextType: event.contextType,
          userMessage: event.userMessage,
        },
        orgId: auth.orgId,
        userId: auth.userId,
        featureSwitchContext,
      }),
    );
    signal.throwIfAborted();
  }
  return prompts;
}

function isContextBackedContextType(
  contextType: ChatEventContextType,
): contextType is ContextBackedContextType {
  return CONTEXT_BACKED_CONTEXT_TYPES.some((candidate) => {
    return candidate === contextType;
  });
}

async function loadIntegrationPromptMaterial(
  db: Db,
  event: ActiveInputPromptEvent,
  args: { readonly orgId: string; readonly userId: string },
): Promise<IntegrationPromptMaterial | null> {
  const loaderArgs = {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    orgId: args.orgId,
    userId: args.userId,
  };
  switch (event.contextType) {
    case "slack": {
      return await loadSlackQueuedLaunchMaterial(db, loaderArgs);
    }
    case "feishu": {
      return await loadFeishuQueuedLaunchMaterial(db, loaderArgs);
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
    case "github":
    case "automation":
    case "goal":
    case "agent_run": {
      return null;
    }
    default: {
      return unreachableActiveInputContextType(event.contextType);
    }
  }
}

function unreachableActiveInputContextType(contextType: never): never {
  throw new Error(`Unsupported active input context type: ${contextType}`);
}

/** Materialize one claimed input prompt into the same text capability as a run prompt. */
async function materializeActiveInputPrompt(
  db: Db,
  args: {
    readonly event: ActiveInputPromptEvent;
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<MaterializedActiveInputPrompt> {
  const userMessage = requiredUserMessageForEvent(
    args.event.eventType,
    args.event.userMessage,
  );
  if (!userMessage) {
    throw new Error("Active input event is missing userMessage");
  }
  const projection = projectUserMessage(userMessage);
  const integration = await loadIntegrationPromptMaterial(db, args.event, args);
  if (isContextBackedContextType(args.event.contextType) && !integration) {
    throw new Error(
      `${args.event.contextType} active input is missing launch material`,
    );
  }
  const generationTemplates = resolveThreadGenerationTemplatePrompt({
    introVideoEnabled: loadIntroVideoTemplateAccess(
      projection.templates,
      args.featureSwitchContext,
    ),
    explicit: projection.primaryTemplate,
    explicitTemplates: projection.templates,
    // Steered into a run that is already executing, whose volumes were fixed
    // when it was created. There is no package to point the agent at, so a
    // private template contributes no guidance rather than a dangling path.
    mountedUserPresentationTemplateIds: [],
  });
  const generationTemplatePrompt = generationTemplates.prompt;
  const prompt = integration?.prompt ?? projection.agentPrompt;
  const parts = [
    integration?.appendSystemPrompt ?? "",
    generationTemplatePrompt,
    prompt,
  ].filter((part) => {
    return part.length > 0;
  });
  const materialized = parts.join("\n\n");
  if (materialized.length === 0) {
    throw new Error("Active input event materialized to an empty prompt");
  }
  return {
    prompt: materialized,
    templateIdentities: generationTemplates.identities,
  };
}
