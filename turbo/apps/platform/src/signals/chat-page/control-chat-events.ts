import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ChatEvent } from "./chat-event-types.ts";
import { apiClient$ } from "../api-client.ts";
import { ApiError } from "../../lib/api-error.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import { settle } from "../utils.ts";

export interface ControlDeliveryStatus {
  readonly kind: "revoke" | "interrupt";
  readonly targetId: string;
  readonly eventId: string;
  readonly outcome: "pending" | "accepted" | "rejected" | "uncertain";
}

export interface ControlChatEventSignals {
  readonly status$: Computed<readonly ControlDeliveryStatus[]>;
  readonly refresh$: Command<Promise<void>, [AbortSignal]>;
  readonly sendRevoke$: Command<Promise<void>, [string, string, AbortSignal]>;
  readonly sendInterrupt$: Command<
    Promise<void>,
    [string, string, AbortSignal]
  >;
}

/**
 * Controls have no server-side same-ID duplicate guarantee. Never project a
 * control before persistence and never automatically replay an uncertain POST.
 * A failed/uncertain action stays blocked for this page until the server event
 * with the original ID arrives; a new page loads authoritative history first.
 */
export function createControlChatEventSignals({
  threadId,
  chatEvents$,
  catchUp$,
}: {
  readonly threadId: string;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
}): ControlChatEventSignals {
  const attempts$ = state<readonly ControlDeliveryStatus[]>([]);
  const status$ = computed((get): readonly ControlDeliveryStatus[] => {
    const canonicalEvents = get(chatEvents$).filter((event) => {
      return event.seqId !== undefined;
    });
    return get(attempts$).filter((attempt) => {
      // A concurrent client may have completed this target first; the server
      // accepts the already-existing control but does not promise to reuse our
      // clientEventId. Either canonical event proves the target was handled.
      return !canonicalEvents.some((event) => {
        return (
          event.id === attempt.eventId ||
          (attempt.kind === "revoke" &&
            event.eventType === "control.revoke" &&
            event.revokesEventId === attempt.targetId) ||
          (attempt.kind === "interrupt" &&
            event.eventType === "control.interrupt" &&
            event.interruptsRunId === attempt.targetId)
        );
      });
    });
  });
  const refresh$ = command(async ({ set }, signal: AbortSignal) => {
    await set(catchUp$, signal);
  });
  const send$ = command(
    async (
      { get, set },
      kind: ControlDeliveryStatus["kind"],
      agentId: string,
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      // An absent response cannot establish non-persistence. A repeated click
      // in this page must not manufacture a new ID for the same control.
      if (
        get(status$).some((attempt) => {
          return attempt.kind === kind && attempt.targetId === targetId;
        })
      ) {
        throw new Error("Chat control is awaiting server reconciliation");
      }
      signal.throwIfAborted();
      const eventId = crypto.randomUUID();
      const attempt: ControlDeliveryStatus = {
        kind,
        targetId,
        eventId,
        outcome: "pending",
      };
      set(attempts$, (previous) => {
        return [...previous, attempt];
      });
      const sent = await settle(
        sendChatEvent(
          get(apiClient$),
          {
            agentId,
            threadId,
            clientEventId: eventId,
            ...(kind === "revoke"
              ? { revokesEventId: targetId }
              : { interruptsRunId: targetId }),
          },
          signal,
        ),
        signal,
      );
      if (!sent.ok) {
        const outcome =
          sent.error instanceof ApiError &&
          sent.error.status >= 400 &&
          sent.error.status < 500
            ? "rejected"
            : "uncertain";
        set(attempts$, (previous) => {
          return previous.map((entry) => {
            return entry.eventId === eventId ? { ...entry, outcome } : entry;
          });
        });
        // Preserve the caller's failure boundary (e.g. recall must not sync a
        // seeded draft after rejection), without exposing a raw SDK error to
        // detached-action diagnostics. The status explains the outcome.
        throw new Error("Chat control delivery was not confirmed");
      }
      set(attempts$, (previous) => {
        return previous.map((entry) => {
          return entry === attempt ? { ...entry, outcome: "accepted" } : entry;
        });
      });
      // Acceptance is not the source of truth for the queue/run projection.
      // A read failure after 201 cannot turn that accepted POST into a reject.
      const synced = await settle(set(catchUp$, signal), signal);
      if (!synced.ok) {
        set(attempts$, (previous) => {
          return previous.map((entry) => {
            return entry.eventId === eventId
              ? { ...entry, outcome: "uncertain" }
              : entry;
          });
        });
      }
    },
  );
  return {
    status$,
    refresh$,
    sendRevoke$: command(
      async (
        { set },
        agentId: string,
        targetId: string,
        signal: AbortSignal,
      ) => {
        await set(send$, "revoke", agentId, targetId, signal);
      },
    ),
    sendInterrupt$: command(
      async (
        { set },
        agentId: string,
        targetId: string,
        signal: AbortSignal,
      ) => {
        await set(send$, "interrupt", agentId, targetId, signal);
      },
    ),
  };
}
