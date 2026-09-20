import { command, computed, state } from "ccstate";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import { onRejection } from "../utils.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
} from "../okou-page/log-types.ts";
import { groupVisibleGroups, type EventGroup } from "./log-detail-utils.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";

const AGENT_EVENTS_PAGE_LIMIT = 100;

type AgentEventsClient = InitClientReturn<
  typeof runAgentEventsContract,
  InitClientArgs
>;

interface ActivityEvents {
  readonly runId: string;
  readonly events: AgentEvent[];
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
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<AgentEventsResponse> {
  const result = await accept(
    client.getAgentEvents({
      params: { id: runId },
      query: {
        limit: AGENT_EVENTS_PAGE_LIMIT,
        order: "asc",
        ...(cursor === undefined ? {} : { cursor }),
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
  signal: AbortSignal,
): Promise<AgentEvent[]> {
  let page = await fetchAgentEventPage(client, runId, undefined, signal);
  const events = [...page.events];

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
      nextCursor,
      signal,
    );
    events.push(...nextPage.events);
    page = nextPage;
  }

  return events;
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

export const setupActivityEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(currentRunId$);
    if (!runId) {
      set(internalActivityEventsState$, null);
      return;
    }

    set(internalActivityEventsState$, { phase: "loading", runId });
    const client = get(apiClient$)(runAgentEventsContract);
    const events = await onRejection(
      fetchAgentEventBatch(client, runId, signal),
      () => {
        if (!signal.aborted) {
          set(internalActivityEventsState$, { phase: "unavailable", runId });
        }
      },
    );
    signal.throwIfAborted();

    set(internalActivityEventsState$, {
      phase: "ready",
      data: { runId, events },
    });
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
