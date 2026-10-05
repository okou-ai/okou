import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command, computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { dispatchRunCallbacks$ } from "./agent-run-callback.service";

export type RequiredTerminalChatCallbackResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

interface RequiredTerminalChatCallbackInput {
  readonly status: "completed" | "failed";
  readonly error?: string;
}

function createUndeliveredChatCallbackId(runId: string) {
  return computed(async (get): Promise<string | undefined> => {
    const [callback] = await get(db$)
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.internalKind, "chat"),
          inArray(agentRunCallbacks.status, ["pending", "failed"]),
        ),
      )
      .limit(1);
    return callback?.id;
  });
}

/** One completion request owns one required dispatch and its two observations. */
export function createRequiredTerminalChatCallback(runId: string) {
  const beforeDispatch$ = createUndeliveredChatCallbackId(runId);
  const afterDispatch$ = createUndeliveredChatCallbackId(runId);

  const dispatch$ = command(
    async (
      { get, set },
      input: RequiredTerminalChatCallbackInput,
      signal: AbortSignal,
    ): Promise<RequiredTerminalChatCallbackResult> => {
      const chatCallbackId = await get(beforeDispatch$);
      signal.throwIfAborted();
      if (chatCallbackId === undefined) {
        return { success: true };
      }

      const [callbackResult] = await set(
        dispatchRunCallbacks$,
        {
          db: set(writeDb$),
          runId,
          status: input.status,
          error: input.error,
          redriveChatCallbackId: chatCallbackId,
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
