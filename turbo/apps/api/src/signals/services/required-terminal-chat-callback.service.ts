import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command, computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import {
  dispatchRunCallbacks$,
  type PreloadedTerminalChatCallback,
} from "./agent-run-callback.service";

export type RequiredTerminalChatCallbackResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

function createUndeliveredChatCallback(runId: string) {
  return computed(
    async (get): Promise<PreloadedTerminalChatCallback | undefined> => {
      const [callback] = await get(db$)
        .select({
          id: agentRunCallbacks.id,
          payload: agentRunCallbacks.payload,
          runStatus: agentRuns.status,
        })
        .from(agentRunCallbacks)
        .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
        .where(
          and(
            eq(agentRunCallbacks.runId, runId),
            eq(agentRunCallbacks.internalKind, "chat"),
            inArray(agentRunCallbacks.status, ["pending", "failed"]),
          ),
        )
        .limit(1);
      return callback;
    },
  );
}

/** One completion request owns one required dispatch and its two observations. */
export function createRequiredTerminalChatCallback(runId: string) {
  const beforeDispatch$ = createUndeliveredChatCallback(runId);
  const afterDispatch$ = createUndeliveredChatCallback(runId);

  const dispatch$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<RequiredTerminalChatCallbackResult> => {
      const chatCallback = await get(beforeDispatch$);
      signal.throwIfAborted();
      if (chatCallback === undefined) {
        return { success: true };
      }

      const [callbackResult] = await set(
        dispatchRunCallbacks$,
        {
          runId,
          redriveChatCallbackId: chatCallback.id,
          preloadedChatCallback: chatCallback,
        },
        signal,
      );
      signal.throwIfAborted();
      if (callbackResult?.success) {
        return { success: true };
      }
      if (
        callbackResult === undefined &&
        (await get(afterDispatch$)) === undefined
      ) {
        signal.throwIfAborted();
        return { success: true };
      }
      return {
        success: false,
        error:
          callbackResult?.error ?? "Canonical terminal chat callback failed",
      };
    },
  );

  return { dispatch$ };
}
