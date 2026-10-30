import { command, computed, state, type Command, type Computed } from "ccstate";

import { textToMessageDocument } from "../okou-page/user-message-document-codec.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";

export type BrowserController = "agent" | "member" | null;

export interface BrowserPresenceSignals {
  /** Who drives the thread's cloud browser right now, if anyone. */
  readonly controller$: Computed<BrowserController>;
  /**
   * Give the member the browser, from the Take over button or their first
   * input on the page. A live Run is told, not stopped.
   */
  readonly takeOver$: Command<Promise<void>, [string, AbortSignal]>;
  /**
   * Settles once the Run has been told about the latest take over. Handing back
   * before then could reach the Run ahead of the take-over message.
   */
  readonly takeOverSent$: Computed<Promise<void>>;
  /** Tell the agent it may use the browser again. */
  readonly handBack$: Command<Promise<void>, [string, AbortSignal]>;
}

/**
 * The member drives from the moment they take over until they hand back or a
 * newer Run starts. A live Run keeps working on everything else: the take-over
 * message is steered into it at its next step. Handing back steers the continue
 * message into the same Run while it is live, and starts a new Run once it has
 * ended, so a member who signed in for a finished Run continues it in one step.
 */
export function createBrowserPresenceSignals({
  agentId,
  latestRunId$,
  liveRunId$,
  sendEvent$,
}: {
  readonly agentId: string;
  readonly latestRunId$: Computed<string | null>;
  readonly liveRunId$: Computed<string | null>;
  readonly sendEvent$: ChatEventSignals["sendEvent$"];
}): BrowserPresenceSignals {
  // The Run that was latest when the member took over.
  const memberRun$ = state<{ readonly runId: string | null } | null>(null);
  const takeOverSend$ = state<Promise<void> | null>(null);
  const takeOverSent$ = computed((get) => {
    return get(takeOverSend$) ?? Promise.resolve();
  });

  const controller$ = computed((get): BrowserController => {
    const memberRun = get(memberRun$);
    if (memberRun !== null && memberRun.runId === get(latestRunId$)) {
      return "member";
    }
    return get(liveRunId$) === null ? null : "agent";
  });

  const sendMessage$ = command(
    async (
      { get, set },
      message: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const userMessage = textToMessageDocument(message);
      if (!userMessage) {
        throw new Error("Failed to serialize the browser presence message");
      }
      await set(
        sendEvent$,
        {
          kind: "input",
          delivery: get(liveRunId$) === null ? "run" : "queue",
          agentId,
          prompt: message,
          hasTextContent: true,
          userMessage,
        },
        signal,
      );
    },
  );

  const takeOver$ = command(
    async ({ get, set }, message: string, signal: AbortSignal) => {
      if (get(controller$) === "member") {
        return;
      }
      // Control moves with the member's first input, so repeated input while
      // the message is in flight does not tell the Run twice.
      set(memberRun$, { runId: get(latestRunId$) });
      if (get(liveRunId$) === null) {
        return;
      }
      const sending = set(sendMessage$, message, signal);
      set(takeOverSend$, sending);
      await sending;
    },
  );

  const handBack$ = command(
    async ({ set }, message: string, signal: AbortSignal) => {
      await set(sendMessage$, message, signal);
      set(memberRun$, null);
    },
  );

  return { controller$, takeOver$, takeOverSent$, handBack$ };
}
