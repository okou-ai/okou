import { command, computed, state, type Computed, type State } from "ccstate";
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
import {
  registerChatEventChangeHandler$,
  type ChatEventChangeHandler,
} from "./chat-event-change-registry.ts";
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

interface ThreadActivitySummarySubscription extends ChatEventChangeHandler {
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly currentActiveRunId$: Computed<string | null>;
  readonly reloadVersion$: State<number>;
  readonly runId$: State<string | null>;
  readonly readyRunId$: State<string | null>;
}

function isThreadActivitySummarySubscription(
  handler: ChatEventChangeHandler,
): handler is ThreadActivitySummarySubscription {
  return handler.command$ === afterThreadActivitySummaryEventsChange$;
}

const reconcileThreadActivitySummaryDemand$ = command(
  (
    { get, set },
    subscription: ThreadActivitySummarySubscription,
    signal: AbortSignal,
  ): boolean => {
    signal.throwIfAborted();
    const runId = get(subscription.currentActiveRunId$);
    if (
      runId === get(subscription.runId$) &&
      (runId === null || get(subscription.readyRunId$) === runId)
    ) {
      return false;
    }
    set(subscription.readyRunId$, null);
    set(subscription.runId$, runId);
    return runId !== null;
  },
);

const reloadThreadActivitySummaryDemand$ = command(
  ({ get, set }, subscription: ThreadActivitySummarySubscription): void => {
    const runId = get(subscription.runId$);
    if (runId === null || get(subscription.currentActiveRunId$) !== runId) {
      return;
    }
    set(subscription.reloadVersion$, (version) => {
      return version + 1;
    });
    set(subscription.readyRunId$, runId);
  },
);

const afterThreadActivitySummaryEventsChange$ = command(
  (
    { set },
    handler: ChatEventChangeHandler,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (!isThreadActivitySummarySubscription(handler)) {
      throw new Error("Invalid thread activity summary event handler");
    }
    if (set(reconcileThreadActivitySummaryDemand$, handler, signal)) {
      set(reloadThreadActivitySummaryDemand$, handler);
    }
    return Promise.resolve();
  },
);

const subscribeThreadActivitySummaries$ = command(
  async (
    { set },
    subscription: ThreadActivitySummarySubscription,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    set(
      registerChatEventChangeHandler$,
      subscription.chatEvents$,
      subscription,
      signal,
    );
    set(reconcileThreadActivitySummaryDemand$, subscription, signal);
    await setLoop(
      () => {
        set(reloadThreadActivitySummaryDemand$, subscription);
        return false;
      },
      REQUEST_INTERVAL_MS,
      signal,
      { testIntervalMs: 100 },
    );
  },
);

function createThinkingSummaryDemand(
  threadId: string,
  currentActiveRunId$: Computed<string | null>,
  chatEvents$: Computed<ChatEvent[]>,
) {
  const reloadVersion$ = state(0);
  const runId$ = state<string | null>(null);
  const readyRunId$ = state<string | null>(null);
  const subscription: ThreadActivitySummarySubscription = Object.freeze({
    command$: afterThreadActivitySummaryEventsChange$,
    chatEvents$,
    currentActiveRunId$,
    reloadVersion$,
    runId$,
    readyRunId$,
  });
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

  return { demandSummaries$, runId$, subscription };
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
    subscribe$: subscribeThreadActivitySummaries$,
    subscription: demand.subscription,
    enabled$,
    thinkingSummaries$: demand.demandSummaries$,
    thinkingRunId$: demand.runId$,
  };
}
