import { command, computed, state, type Computed } from "ccstate";
import {
  activitySummaryResponseSchema,
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
  type ThinkingMessage,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { foldChatRunStates } from "@okouai/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setLoop } from "../utils.ts";
import { createActiveRunSubscription } from "./active-run-subscription.ts";
import { liveRunIdsFromChatEvents } from "./chat-event-state.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";

const REQUEST_INTERVAL_MS = 15_000;

export interface ThinkingSummaries extends Pick<
  ActivitySummaryResponse,
  "runId"
> {
  readonly messages: readonly ThinkingMessage[];
}

function createThinkingSummaryDemand(
  threadId: string,
  currentActiveRunId$: Computed<string | null>,
  chatEvents$: Computed<ChatEvent[]>,
) {
  const reloadVersion$ = state(0);
  const readyRunId$ = state<string | null>(null);
  // Refresh the run's summary on its fixed interval for as long as it is the
  // demand. The guard keeps a thread that is no longer current from reloading
  // before its own subscription is torn down.
  const refreshRunSummary$ = command(
    ({ get, set }, runId: string, signal: AbortSignal): void => {
      set(readyRunId$, null);
      setLoop(
        () => {
          if (get(currentActiveRunId$) !== runId) {
            return false;
          }
          set(reloadVersion$, (version) => {
            return version + 1;
          });
          set(readyRunId$, runId);
          return false;
        },
        REQUEST_INTERVAL_MS,
        signal,
        { testIntervalMs: 100 },
      );
    },
  );
  const subscription = createActiveRunSubscription(
    chatEvents$,
    currentActiveRunId$,
    refreshRunSummary$,
  );
  const runId$ = subscription.runId$;
  const demandSummaries$ = computed(async (get) => {
    get(reloadVersion$);
    const runId = get(runId$);
    if (!runId || get(readyRunId$) !== runId) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(chatThreadActivitySummaryContract).summarize({
        params: { id: threadId },
        body: { runId },
      }),
      [200, 401, 403, 404],
      undefined,
      { showErrorToast: false },
    );
    if (response.status !== 200) {
      return null;
    }
    const data = activitySummaryResponseSchema.parse(response.body);
    if (data.runId !== runId || data.status === "unavailable") {
      throw new Error("Activity summary is unavailable for the current run");
    }
    if (data.status === "ineligible") {
      return null;
    }
    return data;
  });

  return { demandSummaries$, runId$, subscribe$: subscription.subscribe$ };
}

export function createThreadActivitySummarySignals(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ThreadActivitySummary] === true;
  });
  const currentActiveRunId$ = computed((get): string | null => {
    if (
      !get(enabled$) ||
      get(currentChatThreadId$) !== threadId ||
      get(threadMeta$) === null
    ) {
      return null;
    }
    const events = get(chatEvents$);
    const states = foldChatRunStates(events);
    return (
      liveRunIdsFromChatEvents(events)
        .filter((id) => {
          return states.get(id) !== "queued";
        })
        .at(-1) ?? null
    );
  });
  const demand = createThinkingSummaryDemand(
    threadId,
    currentActiveRunId$,
    chatEvents$,
  );

  return {
    subscribe$: demand.subscribe$,
    enabled$,
    thinkingSummaries$: demand.demandSummaries$,
    thinkingRunId$: demand.runId$,
  };
}
