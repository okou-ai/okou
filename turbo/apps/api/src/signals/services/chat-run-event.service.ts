import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { canonicalChatInputModelSelection } from "./canonical-chat-event-read.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin,
  resolveModelFirstProviderAdmission,
  type ProviderModelSupport,
} from "./model-selection.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

/**
 * Resolve the immutable enqueue choice into the route a run launches with;
 * pick never selects a default. The plan is read once for the route and the
 * credit admission. A queued chat input trusts its enqueue-time model and
 * leaves a provider that cannot run it to fail at execution; only its credit
 * admission is checked here.
 */
export async function resolveRunChatThreadModelContext(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly eventId: string;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly providerModelSupport?: ProviderModelSupport;
}) {
  const [event] = await params.db
    .select({ modelSelection: canonicalChatInputModelSelection() })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, params.eventId),
        eq(chatEvents.chatThreadId, params.threadId),
      ),
    )
    .limit(1);
  if (!event?.modelSelection) {
    return badRequestMessage("Queued input is missing its model selection");
  }
  const selection = event.modelSelection;
  const orgPlanCapabilities = await loadOrgPlanCapabilities(
    params.db,
    params.orgId,
  );
  const pin = await resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: selection.selectedModel,
    },
    orgPlanCapabilities,
  });
  if ("status" in pin) {
    return pin;
  }
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelPin: pin,
    requestedModelProvider: undefined,
    externalPlanCapabilities: {
      kind: "resolved",
      capabilities: orgPlanCapabilities,
    },
    providerModelSupport: params.providerModelSupport ?? "validate",
  });
  const featureSwitchContext =
    params.featureSwitchContext ??
    (await loadUserFeatureSwitchContext(
      params.db,
      params.orgId,
      params.userId,
    ));
  return {
    pin,
    providerAdmission,
    featureSwitchContext,
    runCodexServiceTier: selection.codexServiceTier ?? undefined,
    reasoningEffort: selection.reasoningEffort ?? undefined,
  };
}

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
