import { command, computed, state } from "ccstate";
import { logsByIdContract } from "@okouai/api-contracts/client/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/client/run-routes";
import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import { pageVersion$ } from "../page-signal.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
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

type ActivityDetailClient = InitClientReturn<
  typeof logsByIdContract,
  InitClientArgs
>;

interface ActivityEvents {
  readonly runId: string;
  readonly events: AgentEvent[];
}

interface ActivityVisibleGroups {
  readonly runId: string | null;
  readonly groups: EventGroup[];
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
): Promise<AgentEventsResponse> {
  const result = await accept(
    client.getAgentEvents({
      params: { id: runId },
      query: {
        limit: AGENT_EVENTS_PAGE_LIMIT,
        order: "asc",
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
    [200],
  );
  return result.body;
}

async function fetchAgentEventBatch(
  client: AgentEventsClient,
  runId: string,
): Promise<ActivityEvents> {
  let page = await fetchAgentEventPage(client, runId, undefined);
  const events = [...page.events];

  const seenCursors = new Set<string>();

  while (page.hasMore) {
    const nextCursor = page.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Agent event pagination cursor did not advance");
    }
    seenCursors.add(nextCursor);
    const nextPage = await fetchAgentEventPage(client, runId, nextCursor);
    events.push(...nextPage.events);
    page = nextPage;
  }

  return { runId, events };
}

async function fetchActivityDetail(
  client: ActivityDetailClient,
  runId: string,
): Promise<LogDetail> {
  const result = await accept(
    client.getById({
      params: { id: runId },
    }),
    [200],
  );
  return result.body;
}

export const activityEvents$ = computed(async (get) => {
  get(pageVersion$);
  const runId = get(currentRunId$);
  return runId
    ? await fetchAgentEventBatch(get(apiClient$)(runAgentEventsContract), runId)
    : null;
});

export const activityDetail$ = computed(async (get) => {
  get(pageVersion$);
  const runId = get(currentRunId$);
  return runId
    ? await fetchActivityDetail(get(apiClient$)(logsByIdContract), runId)
    : null;
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
  if (!detail || !events || events.runId !== detail.id) {
    return {
      runId,
      groups: [],
    } satisfies ActivityVisibleGroups;
  }
  return {
    runId: detail.id,
    groups: groupVisibleGroups(events.events, {
      framework: detail.framework,
    }),
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
