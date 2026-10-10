import { computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
} from "drizzle-orm";
import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  chatEventCompatibilityRole,
} from "@okouai/api-contracts/contracts/chat-events";
import {
  getFrameworkForType,
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { isAutoSelectedModel } from "@okouai/core/auto-run-model";
import { isPiExecutionRoute, piCatalogModel } from "@okouai/core/pi-execution";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { db$ } from "../../external/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "../agent-run-cancellation";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "../canonical-chat-event-read.service";
import { visibleChatEventCondition } from "../chat-event-shared.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
} from "../chat-event-type.service";
import {
  isWebChatContextType,
  queuedUserMessageTriggerSource,
} from "../chat-queued-event.service";
import {
  isMemberSubscriptionRoute,
  type MemberModelRouteContext,
} from "../effective-model-route.service";
import {
  buildChatPriorRunsContext,
  type PriorRunEvent,
} from "../internal-chat-run-callback.service";
import { memberSubscriptionModelRoutesFromCatalog } from "../member-subscription-models.service";
import type { ModelCatalog } from "../model-catalog.service";
import { resolveQueuedModelSelectionPinFromSnapshot } from "../model-selection.service";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "../session-compatibility";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import { createIncompletePrompt } from "./incomplete";
import type { PickedThreadInputEvent } from "./types";

function currentSessionIdentity(
  selection: NonNullable<PickedThreadInputEvent["canonicalModelSelection"]>,
  memberRoutes: MemberModelRouteContext,
  catalog: ModelCatalog,
): SessionExecutionIdentity | null {
  const pin = resolveQueuedModelSelectionPinFromSnapshot({
    catalog,
    selectedModel: selection.selectedModel,
    subscriptionModels: memberSubscriptionModelRoutesFromCatalog(
      catalog,
      memberRoutes,
    ),
    memberProviderTypes: new Set(
      memberRoutes.subscriptions.map((subscription) => {
        return subscription.type;
      }),
    ),
  });
  // Admission owns unavailable selections and subscription errors.
  if ("status" in pin || pin.selectedModel === null) {
    return null;
  }
  const providerType = modelProviderTypeSchema.safeParse(pin.modelProviderType);
  if (
    !providerType.success ||
    (!isBuiltInModelProviderType(providerType.data) &&
      !isMemberSubscriptionRoute({
        catalog,
        member: memberRoutes,
        model: pin.selectedModel,
        providerType: providerType.data,
      }))
  ) {
    return null;
  }
  const codexServiceTier = isAutoSelectedModel(pin.selectedModel)
    ? undefined
    : (selection.codexServiceTier ?? undefined);
  const cliAgentType = isPiExecutionRoute({
    catalogModel: piCatalogModel(catalog, pin.selectedModel),
    modelProviderType: providerType.data,
    runtimeProviderType: providerType.data,
    codexServiceTier,
  })
    ? "pi"
    : getFrameworkForType(providerType.data);
  return { selectedModel: pin.selectedModel, cliAgentType };
}

function groupPriorRunEvents(
  events: readonly (Omit<PriorRunEvent, "role"> & {
    readonly runId: string | null;
  })[],
): ReadonlyMap<string, readonly PriorRunEvent[]> {
  const grouped = new Map<string, PriorRunEvent[]>();
  for (const event of events) {
    if (event.runId === null) {
      continue;
    }
    const runEvents = grouped.get(event.runId) ?? [];
    runEvents.push({
      eventType: event.eventType,
      role: chatEventCompatibilityRole(event.eventType),
      content: event.content,
      userMessage: event.userMessage,
    });
    grouped.set(event.runId, runEvents);
  }
  return grouped;
}

function createPriorRunsPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  session$: Computed<Promise<SessionExecutionIdentity | null>>,
  memberRoutes$: Computed<Promise<MemberModelRouteContext>>,
  claimCatalog$: Computed<Promise<ModelCatalog>>,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event) {
      return "";
    }
    const contextType = event.contextType;
    if (contextType === null || contextType === "automation") {
      return "";
    }
    const session = await get(session$);
    const selection = event.canonicalModelSelection;
    if (!session || !selection) {
      return "";
    }
    const [memberRoutes, catalog] = await Promise.all([
      get(memberRoutes$),
      get(claimCatalog$),
    ]);
    const currentSession = currentSessionIdentity(
      selection,
      memberRoutes,
      catalog,
    );
    if (!currentSession || canReuseSession(session, currentSession)) {
      return "";
    }
    const db = get(db$);
    const rows = await db
      .select({
        runId: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, event.chatThreadId),
          isWebChatContextType(contextType)
            ? inArray(agentRuns.triggerSource, ["web", "agent"])
            : contextType === "feishu"
              ? inArray(agentRuns.triggerSource, ["feishu", "lark"])
              : eq(
                  agentRuns.triggerSource,
                  queuedUserMessageTriggerSource(contextType),
                ),
          or(
            or(ne(agentRuns.status, "cancelled"), isNull(agentRuns.status)),
            or(
              ne(agentRuns.error, BEFORE_DISPATCH_CANCELLED_ERROR),
              isNull(agentRuns.error),
            ),
          ),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(10);
    const runs = rows.reverse();
    const runIds = runs.map((run) => {
      return run.runId;
    });
    if (!runIds.length) {
      return "";
    }
    const events = await db
      .select({
        runId: chatEvents.runId,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, event.chatThreadId),
          chatEventTextCondition(),
          inArray(chatEvents.runId, runIds),
          visibleChatEventCondition(),
          isWebChatContextType(contextType)
            ? or(
                chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
                inArray(
                  chatEvents.seqId,
                  db
                    .select({ seqId: max(chatEvents.seqId) })
                    .from(chatEvents)
                    .where(
                      and(
                        eq(chatEvents.chatThreadId, event.chatThreadId),
                        chatEventTypeIn(CHAT_EVENT_CONTENT_TEXT_TYPES),
                        isNotNull(canonicalChatEventContent()),
                        inArray(chatEvents.runId, runIds),
                        visibleChatEventCondition(),
                      ),
                    )
                    .groupBy(chatEvents.runId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(chatEvents.seqId));
    const grouped = groupPriorRunEvents(events);
    const triggerSource =
      contextType === "feishu"
        ? event.userMessage?.parts.some((part) => {
            return part.type === "source" && part.kind === "lark";
          })
          ? "lark"
          : "feishu"
        : queuedUserMessageTriggerSource(contextType);
    return buildChatPriorRunsContext(
      runs.map((run) => {
        return { ...run, events: grouped.get(run.runId) ?? [] };
      }),
      contextType,
      triggerSource,
    );
  });
}

/** The continuation text for this run, including rounds absent from native history. */
export function createRotatedPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  session$: Computed<Promise<SessionExecutionIdentity | null>>,
  memberRoutes$: Computed<Promise<MemberModelRouteContext>>,
  claimCatalog$: Computed<Promise<ModelCatalog>>,
): Computed<Promise<RunPromptAndSkills>> {
  const prior$ = createPriorRunsPrompt(
    pickedEvent$,
    session$,
    memberRoutes$,
    claimCatalog$,
  );
  const incomplete$ = createIncompletePrompt(pickedEvent$);
  return computed(async (get) => {
    const [prior, incomplete] = await Promise.all([
      get(prior$),
      get(incomplete$),
    ]);
    return {
      systemPromptVariables: { continuationContext: prior || incomplete },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
