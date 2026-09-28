import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
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
} from "./model-selection.service";

/** Revalidate only the immutable enqueue choice; pick never selects a default. */
export async function resolveRunChatThreadModelContext(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly eventId: string;
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
  const pin = await resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: selection.selectedModel,
    },
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
    externalPlanCapabilities: { kind: "load-current" },
  });
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    params.db,
    params.orgId,
    params.userId,
  );
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
