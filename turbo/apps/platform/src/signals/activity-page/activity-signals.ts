import { command, computed, state } from "ccstate";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { delay } from "signal-timers";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import { onRejection, setLoop } from "../utils.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogStatus,
} from "../okou-page/log-types.ts";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";
import { scrollToBottomActivityDetail$ } from "./activity-detail-scroll.ts";

const AGENT_EVENTS_PAGE_LIMIT = 100;
const AGENT_EVENTS_POLL_INTERVAL_MS = 1000;
const TERMINAL_EVENT_STALL_POLL_LIMIT = 30;

type AgentEventsClient = InitClientReturn<
  typeof runAgentEventsContract,
  InitClientArgs
>;

interface ActivityEvents {
  readonly runId: string;
  readonly events: AgentEvent[];
  readonly status: LogStatus;
  readonly lastEventSequence: number | null;
}

type ActivityEventsState =
  | {
      readonly phase: "loading" | "unavailable";
      readonly runId: string;
    }
  | {
      readonly phase: "ready";
      readonly data: ActivityEvents;
    };

interface ActivityVisibleGroups {
  readonly runId: string | null;
  readonly groups: EventGroup[];
  readonly loading: boolean;
}

export const currentRunId$ = computed((get) => {
  const params = get(pathParams$);
  if (params && typeof params === "object" && "activityRunId" in params) {
    return String(params.activityRunId);
  }
  return null;
});

async function fetchAgentEventPage(
  client: AgentEventsClient,
  runId: string,
  request: {
    readonly since?: number;
    readonly cursor?: string;
  },
  signal: AbortSignal,
): Promise<AgentEventsResponse> {
  const result = await accept(
    client.getAgentEvents({
      params: { id: runId },
      query: {
        limit: AGENT_EVENTS_PAGE_LIMIT,
        order: "asc",
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.cursor === undefined && request.since !== undefined
          ? { since: request.since }
          : {}),
      },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return result.body;
}

async function fetchAgentEventBatch(
  client: AgentEventsClient,
  runId: string,
  request: {
    readonly since?: number;
    readonly expectedSequence?: number;
  },
  signal: AbortSignal,
): Promise<Omit<ActivityEvents, "runId">> {
  const firstPage = await fetchAgentEventPage(
    client,
    runId,
    request.since === undefined ? {} : { since: request.since },
    signal,
  );
  const events = [...firstPage.events];
  let page = firstPage;

  // If an indexed sequence is still missing, do not walk the already-known
  // tail on every poll. Keep querying from the contiguous prefix until the
  // missing event appears, then resume cursor pagination.
  if (
    request.expectedSequence !== undefined &&
    !firstPage.events.some((event) => {
      return event.sequenceNumber === request.expectedSequence;
    })
  ) {
    return {
      events,
      status: page.status,
      lastEventSequence: page.lastEventSequence,
    };
  }

  const seenCursors = new Set<string>();

  while (page.hasMore) {
    const nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Agent event pagination cursor did not advance");
    }
    seenCursors.add(nextCursor);
    const nextPage = await fetchAgentEventPage(
      client,
      runId,
      { cursor: nextCursor },
      signal,
    );
    events.push(...nextPage.events);
    page = nextPage;
  }

  return {
    events,
    status: page.status,
    lastEventSequence: page.lastEventSequence,
  };
}

const internalActivityEventsState$ = state<ActivityEventsState | null>(null);

export const activityEvents$ = computed((get) => {
  const runId = get(currentRunId$);
  const state = get(internalActivityEventsState$);
  if (!runId || state?.phase !== "ready" || state.data.runId !== runId) {
    return null;
  }
  return state.data;
});

const activityEventsLoading$ = computed((get) => {
  const runId = get(currentRunId$);
  const state = get(internalActivityEventsState$);
  return state?.phase === "loading" && state.runId === runId;
});

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

function visibleEventSequence(events: readonly AgentEvent[]): number {
  let visibleThrough = -1;
  for (const event of events) {
    if (event.sequenceNumber <= visibleThrough) {
      continue;
    }
    if (event.sequenceNumber !== visibleThrough + 1) {
      break;
    }
    visibleThrough = event.sequenceNumber;
  }
  return visibleThrough;
}

function reachedTerminalEventWatermark(data: ActivityEvents): boolean {
  return (
    isTerminalStatus(data.status) &&
    data.lastEventSequence !== null &&
    visibleEventSequence(data.events) >= data.lastEventSequence
  );
}

function mergeAgentEvents(
  current: readonly AgentEvent[],
  incoming: readonly AgentEvent[],
): AgentEvent[] {
  const bySequence = new Map(
    current.map((event) => {
      return [event.sequenceNumber, event] as const;
    }),
  );
  for (const event of incoming) {
    if (!bySequence.has(event.sequenceNumber)) {
      bySequence.set(event.sequenceNumber, event);
    }
  }
  return [...bySequence.values()].sort((left, right) => {
    return left.sequenceNumber - right.sequenceNumber;
  });
}

function activityEventsMadeProgress(
  previous: ActivityEvents,
  current: ActivityEvents,
): boolean {
  return (
    current.events.length !== previous.events.length ||
    visibleEventSequence(current.events) !==
      visibleEventSequence(previous.events) ||
    current.status !== previous.status ||
    current.lastEventSequence !== previous.lastEventSequence
  );
}

export const setupActivityEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(currentRunId$);
    if (!runId) {
      set(internalActivityEventsState$, null);
      return;
    }

    set(internalActivityEventsState$, { phase: "loading", runId });
    const client = get(apiClient$)(runAgentEventsContract);
    const initial = await onRejection(
      fetchAgentEventBatch(client, runId, {}, signal),
      () => {
        if (!signal.aborted) {
          set(internalActivityEventsState$, { phase: "unavailable", runId });
        }
      },
    );
    signal.throwIfAborted();

    let current = {
      runId,
      ...initial,
    } satisfies ActivityEvents;
    set(internalActivityEventsState$, { phase: "ready", data: current });

    await get(activityDetail$);
    signal.throwIfAborted();
    // Allow React to render the initial event history and bind the scroll
    // container before restoring the pre-removal bottom position.
    await delay(0, { signal });
    set(scrollToBottomActivityDetail$);

    if (reachedTerminalEventWatermark(current)) {
      return;
    }

    let waitBeforeFirstPoll = true;
    let terminalStallPolls = 0;
    setLoop(
      async (loopSignal) => {
        if (waitBeforeFirstPoll) {
          waitBeforeFirstPoll = false;
          return false;
        }

        const visibleThrough = visibleEventSequence(current.events);
        const batch = await fetchAgentEventBatch(
          client,
          runId,
          {
            ...(visibleThrough < 0 ? {} : { since: visibleThrough }),
            expectedSequence: visibleThrough + 1,
          },
          loopSignal,
        );
        loopSignal.throwIfAborted();

        const previous = current;
        current = {
          runId,
          events: mergeAgentEvents(current.events, batch.events),
          status: batch.status,
          lastEventSequence: batch.lastEventSequence,
        };
        set(internalActivityEventsState$, { phase: "ready", data: current });

        if (reachedTerminalEventWatermark(current)) {
          return true;
        }

        if (!isTerminalStatus(current.status)) {
          terminalStallPolls = 0;
          return false;
        }
        if (activityEventsMadeProgress(previous, current)) {
          terminalStallPolls = 0;
          return false;
        }
        terminalStallPolls++;
        return terminalStallPolls >= TERMINAL_EVENT_STALL_POLL_LIMIT;
      },
      AGENT_EVENTS_POLL_INTERVAL_MS,
      signal,
    );
  },
);

export const activityDetail$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const result = await accept(
    get(apiClient$)(logsByIdContract).getById({
      params: { id: runId },
    }),
    [200],
  );
  return result.body;
});

const internalStepSearch$ = state("");

export const activityStepSearch$ = computed((get) => {
  return get(internalStepSearch$);
});

export const setActivityStepSearch$ = command(({ set }, value: string) => {
  set(internalStepSearch$, value);
});

export const activityVisibleGroups$ = computed(async (get) => {
  const runId = get(currentRunId$);
  const [detail, events] = await Promise.all([
    get(activityDetail$),
    get(activityEvents$),
  ]);
  const loading = get(activityEventsLoading$);
  if (!detail || !events || events.runId !== detail.id) {
    return {
      runId,
      groups: [],
      loading,
    } satisfies ActivityVisibleGroups;
  }
  return {
    runId: detail.id,
    groups: groupVisibleGroups(events.events, {
      framework: detail.framework,
    }),
    loading: false,
  } satisfies ActivityVisibleGroups;
});

export function formatLogTime(createdAt: string): string {
  return formatActivityClockTime(createdAt);
}

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return formatActivityDurationMs(ms);
}
