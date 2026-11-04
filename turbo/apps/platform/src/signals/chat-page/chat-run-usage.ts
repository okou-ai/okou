import { command, computed, state, type Computed } from "ccstate";
import { chatThreadUsageContract } from "@okouai/api-contracts/client/chat-threads";
import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { ChatEventGroup } from "./chat-event.ts";

export const emptyChatRunUsage$ = computed(
  (): Promise<ChatEventUsagePayload | undefined> => {
    return Promise.resolve(undefined);
  },
);

export interface ChatRunUsageSignals {
  readonly runId: string;
  readonly usage$: Computed<Promise<ChatEventUsagePayload | undefined>>;
}

function createRunUsageSignals(
  threadId: string,
  runId: string,
  lastUsageEventIdByRunId$: Computed<ReadonlyMap<string, string>>,
): ChatRunUsageSignals {
  const lastUsageEventId$ = computed((get): string | undefined => {
    return get(lastUsageEventIdByRunId$).get(runId);
  });
  const usage$ = computed(async (get) => {
    if (get(lastUsageEventId$) === undefined) {
      return undefined;
    }
    const client = get(apiClient$)(chatThreadUsageContract);
    const result = await accept(
      client.read({
        params: { id: threadId },
        body: { runIds: [runId] },
      }),
      [200],
    );
    return result.body.runs.find((run) => {
      return run.runId === runId;
    })?.usage;
  });
  return { runId, usage$ };
}

/** Only visible runs own usage graphs; responses stay in their async computeds. */
export function createChatRunUsageSignals(
  threadId: string,
  lastUsageEventIdByRunId$: Computed<ReadonlyMap<string, string>>,
) {
  // Preserve signal identity across transcript updates, not fetched values.
  // Replacing the render window releases runs that are no longer represented.
  const internalVisibleRuns$ = state<readonly ChatRunUsageSignals[]>([]);
  const visibleRunUsageSignals$ = computed((get) => {
    return get(internalVisibleRuns$);
  });
  const syncVisibleRuns$ = command(
    ({ get, set }, groups: readonly ChatEventGroup[]): void => {
      const runIds = new Set(
        groups
          .filter((group) => {
            return group.role === "assistant";
          })
          .flatMap((group) => {
            return group.events.flatMap((event) => {
              return event.runId === undefined ? [] : [event.runId];
            });
          }),
      );
      const previous = get(internalVisibleRuns$);
      const next = [...runIds].map((runId) => {
        return (
          previous.find((run) => {
            return run.runId === runId;
          }) ?? createRunUsageSignals(threadId, runId, lastUsageEventIdByRunId$)
        );
      });
      if (
        next.length !== previous.length ||
        next.some((run, index) => {
          return run !== previous[index];
        })
      ) {
        set(internalVisibleRuns$, next);
      }
    },
  );
  return { visibleRunUsageSignals$, syncVisibleRuns$ };
}
