import { command, computed, state, type Command, type Computed } from "ccstate";

import { textToMessageDocument } from "../okou-page/user-message-document-codec.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";

export type BrowserController = "agent" | "member" | null;

export interface BrowserPresenceSignals {
  /** Who drives the thread's cloud browser right now, if anyone. */
  readonly controller$: Computed<BrowserController>;
  /** Tell the live Run the member is using the browser, without stopping it. */
  readonly takeOver$: Command<Promise<void>, [string, AbortSignal]>;
  /** Tell the agent it may use the browser again. */
  readonly handBack$: Command<Promise<void>, [string, AbortSignal]>;
}

/**
 * Taking over leaves the live Run working on everything else: the message is
 * steered into it at its next step, and the member keeps control until a newer
 * Run starts. Handing back steers the continue message into the same Run while
 * it is live, and starts a new Run once it has ended.
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
  const takeoverRunId$ = state<string | null>(null);

  const controller$ = computed((get): BrowserController => {
    const takeoverRunId = get(takeoverRunId$);
    if (takeoverRunId !== null && takeoverRunId === get(latestRunId$)) {
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
      const runId = get(liveRunId$);
      if (runId === null) {
        return;
      }
      // Control moves only once the Run has been told; a failed send leaves it
      // with the agent.
      await set(sendMessage$, message, signal);
      set(takeoverRunId$, runId);
    },
  );

  const handBack$ = command(
    async ({ set }, message: string, signal: AbortSignal) => {
      await set(sendMessage$, message, signal);
      set(takeoverRunId$, null);
    },
  );

  return { controller$, takeOver$, handBack$ };
}
