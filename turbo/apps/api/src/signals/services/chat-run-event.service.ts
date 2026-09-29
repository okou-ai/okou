import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { canonicalChatInputModelSelection } from "./canonical-chat-event-read.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin$,
  type ProviderModelSupport,
} from "./model-selection.service";
import { resolveModelFirstProviderAdmission$ } from "./model-provider-admission.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

/**
 * Resolve the immutable enqueue choice into the route a run launches with;
 * pick never selects a default. The plan is read once for the route and the
 * credit admission. A queued chat input trusts its enqueue-time model and
 * leaves a provider that cannot run it to fail at execution; only its credit
 * admission is checked here.
 */
export const resolveRunChatThreadModelContext$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly eventId: string;
      readonly featureSwitchContext?: FeatureSwitchContext;
      readonly providerModelSupport?: ProviderModelSupport;
    },
    signal?: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [event] = await db
      .select({ modelSelection: canonicalChatInputModelSelection() })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, params.eventId),
          eq(chatEvents.chatThreadId, params.threadId),
        ),
      )
      .limit(1);
    signal?.throwIfAborted();
    if (!event?.modelSelection) {
      return badRequestMessage("Queued input is missing its model selection");
    }
    const selection = event.modelSelection;
    const orgPlanCapabilities = await set(
      loadOrgPlanCapabilities$,
      params.orgId,
      signal,
    );
    const pin = await set(
      resolveModelSelectionPin$,
      {
        orgId: params.orgId,
        userId: params.userId,
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: selection.selectedModel,
        },
        orgPlanCapabilities,
      },
      signal,
    );
    if ("status" in pin) {
      return pin;
    }
    const providerAdmission = await set(
      resolveModelFirstProviderAdmission$,
      {
        orgId: params.orgId,
        userId: params.userId,
        modelPin: pin,
        requestedModelProvider: undefined,
        externalPlanCapabilities: {
          kind: "resolved",
          capabilities: orgPlanCapabilities,
        },
        providerModelSupport: params.providerModelSupport ?? "validate",
      },
      signal,
    );
    const featureSwitchContext =
      params.featureSwitchContext ??
      (await set(
        loadUserFeatureSwitchContext$,
        params.orgId,
        params.userId,
        signal,
      ));
    signal?.throwIfAborted();
    return {
      pin,
      providerAdmission,
      featureSwitchContext,
      runCodexServiceTier: selection.codexServiceTier ?? undefined,
      reasoningEffort: selection.reasoningEffort ?? undefined,
    };
  },
);

async function publishRunUserMessageSignals(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({ orgId, userId, threadId });
  await publishThreadListChanged({ orgId, userId });
}

/**
 * Finish the side effects for a user message inserted by a queue-first run
 * claim. The claim and run rows already committed atomically; only realtime
 * notifications remain.
 */
export async function finalizeClaimedRunUserMessage(params: {
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
}): Promise<void> {
  await publishRunUserMessageSignals(
    params.orgId,
    params.userId,
    params.threadId,
  );
}
