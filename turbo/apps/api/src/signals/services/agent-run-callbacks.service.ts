import { command } from "ccstate";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { tapError } from "../utils";
import { refreshAgentPhoneTypingForRun$ } from "./agent-event-consumer-agentphone-typing.service";
import { handleChatInternalCallback$ } from "./internal-chat-run-callback.service";

const L = logger("agent-run-callbacks");

export const dispatchProgressCallbacks$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal): Promise<void> => {
    const callbacks = await get(db$)
      .select({
        id: agentRunCallbacks.id,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
          inArray(agentRunCallbacks.internalKind, ["chat", "agentphone:chat"]),
          notInArray(agentRuns.status, ["completed", "failed"]),
        ),
      );
    signal.throwIfAborted();

    if (callbacks.length === 0) {
      return;
    }

    // Typing has its own lifetime. Provider failures cannot stop progress.
    waitUntil(
      tapError(
        set(
          refreshAgentPhoneTypingForRun$,
          runId,
          new AbortController().signal,
        ),
        (error) => {
          L.debug("Failed to refresh AgentPhone typing from progress", {
            runId,
            error,
          });
        },
      ),
    );

    await Promise.allSettled(
      callbacks.map(async (callback) => {
        if (callback.internalKind === "chat") {
          await set(
            handleChatInternalCallback$,
            {
              callback: {
                callbackId: callback.id,
                runId,
                status: "progress",
                payload: callback.payload,
              },
            },
            signal,
          );
        }
      }),
    );
  },
);
