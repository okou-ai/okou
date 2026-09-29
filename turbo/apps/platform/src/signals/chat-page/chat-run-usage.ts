import { command, computed, state, type Computed } from "ccstate";
import {
  CHAT_THREAD_USAGE_RUN_LIMIT,
  chatThreadUsageContract,
  type ChatEventUsagePayload,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import { detach, Reason, settle } from "../utils.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("ChatRunUsage");

function usageReadObservation(events: readonly ChatEvent[]) {
  const runIds = [
    ...new Set(
      events.flatMap((event) => {
        return event.runId === undefined ? [] : [event.runId];
      }),
    ),
  ].sort();
  const hints = events
    .filter((event) => {
      return (
        event.eventType === "usage.recorded" ||
        isChatRunTerminalEventType(event.eventType)
      );
    })
    .map((event) => {
      return event.id;
    });
  return { runIds, key: JSON.stringify([runIds, hints]) };
}

/** Each mounted thread owns its ledger refresh and keeps hints out of amounts. */
export function createChatRunUsageSignals(
  threadId: string,
  events$: Computed<ChatEvent[]>,
) {
  const values$ = state<ReadonlyMap<string, ChatEventUsagePayload>>(new Map());
  const requestedKey$ = state<string | null>(null);
  const requestNumber$ = state(0);
  const usageByRunId$ = computed((get) => {
    return get(values$);
  });
  const read$ = command(
    async (
      { get, set },
      force: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const observed = usageReadObservation(get(events$));
      if (!force && get(requestedKey$) === observed.key) {
        return;
      }
      set(requestedKey$, observed.key);
      const requestNumber = get(requestNumber$) + 1;
      set(requestNumber$, requestNumber);
      const client = get(apiClient$)(chatThreadUsageContract);
      const next = new Map<string, ChatEventUsagePayload>();
      for (
        let offset = 0;
        offset < observed.runIds.length;
        offset += CHAT_THREAD_USAGE_RUN_LIMIT
      ) {
        const attempted = await settle(
          accept(
            client.read({
              params: { id: threadId },
              body: {
                runIds: observed.runIds.slice(
                  offset,
                  offset + CHAT_THREAD_USAGE_RUN_LIMIT,
                ),
              },
              fetchOptions: { signal },
            }),
            [200, 404],
          ),
          signal,
        );
        if (!attempted.ok) {
          L.warn("Settled usage is temporarily unavailable", attempted.error);
          return;
        }
        const result = attempted.value;
        if (result.status === 404) {
          // Pre-R1 APIs have no read route. During that actual rolling window,
          // leave amounts unavailable rather than treating hint payloads as money.
          return;
        }
        for (const run of result.body.runs) {
          next.set(run.runId, run.usage);
        }
      }
      signal.throwIfAborted();
      if (get(requestNumber$) === requestNumber) {
        set(values$, next);
      }
    },
  );
  const refresh$ = command(
    ({ set }, force: boolean, signal: AbortSignal): void => {
      signal.throwIfAborted();
      detach(
        set(read$, force, signal),
        Reason.Daemon,
        "Chat usage ledger refresh",
      );
    },
  );
  const subscribe$ = command(({ set }, signal: AbortSignal): void => {
    set(
      registerChatEventChangeHandler$,
      events$,
      {
        callback: () => {
          set(refresh$, false, signal);
        },
      },
      signal,
    );
  });
  return { usageByRunId$, refresh$, subscribe$ };
}
