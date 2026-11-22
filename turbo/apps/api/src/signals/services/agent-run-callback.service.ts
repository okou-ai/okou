import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { handleChatInternalCallback$ } from "./internal-chat-run-callback.service";
import {
  inlineChatDeliveryCallbackKinds,
  terminalRunCallbackKinds,
  workflowAutomationRunCallbackKinds,
  type InternalRunCallbackDispatchResult,
  type InternalRunCallbackEnvelope,
  type TerminalRunCallbackKind,
} from "./internal-run-callback";
import { handleWorkflowAutomationInternalCallback$ } from "./workflow-automation-run-callback.service";

const L = logger("AgentRunCallback");

interface DispatchResult {
  readonly callbackId: string;
  readonly success: boolean;
  readonly error?: string;
}

interface DispatchRunCallbacksInput {
  readonly runId: string;
  readonly redriveChatCallbackId?: string;
  readonly skipChatCallback?: boolean;
}

interface TerminalRunCallback {
  readonly kind: TerminalRunCallbackKind;
  readonly envelope: InternalRunCallbackEnvelope;
}

const dispatchInternalCallback$ = command(
  async (
    { set },
    { kind, envelope }: TerminalRunCallback,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    switch (kind) {
      case "chat": {
        return await set(
          handleChatInternalCallback$,
          { callback: envelope },
          signal,
        );
      }
      case "workflow-automation:cron":
      case "workflow-automation:loop": {
        return await set(
          handleWorkflowAutomationInternalCallback$,
          { kind, callback: envelope },
          signal,
        );
      }
    }
  },
);

type InternalCallbackDeliveryStage =
  | { readonly stage: "attempt-started" }
  | { readonly stage: "delivered" }
  | { readonly stage: "failed"; readonly error: string };

const recordInternalCallbackDelivery$ = command(
  async (
    { set },
    callbackId: string,
    delivery: InternalCallbackDeliveryStage,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    switch (delivery.stage) {
      case "attempt-started": {
        await db
          .update(agentRunCallbacks)
          .set({ attempts: 1, lastAttemptAt: nowDate() })
          .where(eq(agentRunCallbacks.id, callbackId));
        signal.throwIfAborted();
        break;
      }
      case "delivered": {
        await db
          .update(agentRunCallbacks)
          .set({ status: "delivered", deliveredAt: nowDate() })
          .where(eq(agentRunCallbacks.id, callbackId));
        signal.throwIfAborted();
        break;
      }
      case "failed": {
        await db
          .update(agentRunCallbacks)
          .set({ status: "failed", lastError: delivery.error })
          .where(eq(agentRunCallbacks.id, callbackId));
        signal.throwIfAborted();
        break;
      }
    }
  },
);

const dispatchSingleInternalCallback$ = command(
  async (
    { set },
    callback: TerminalRunCallback,
    signal: AbortSignal,
  ): Promise<DispatchResult> => {
    const { callbackId, runId } = callback.envelope;
    await set(
      recordInternalCallbackDelivery$,
      callbackId,
      { stage: "attempt-started" },
      signal,
    );
    signal.throwIfAborted();

    const responseResult = await settle(
      set(dispatchInternalCallback$, callback, signal),
    );
    signal.throwIfAborted();

    if (!responseResult.ok) {
      const errorMessage =
        responseResult.error instanceof Error
          ? responseResult.error.message
          : "Unknown error";
      await set(
        recordInternalCallbackDelivery$,
        callbackId,
        { stage: "failed", error: errorMessage },
        signal,
      );
      signal.throwIfAborted();
      L.error("Internal callback dispatch threw", {
        callbackId,
        runId,
        error: responseResult.error,
      });
      return { callbackId, success: false, error: errorMessage };
    }

    if (!responseResult.value.success) {
      await set(
        recordInternalCallbackDelivery$,
        callbackId,
        { stage: "failed", error: responseResult.value.error },
        signal,
      );
      signal.throwIfAborted();
      L.warn("Internal callback dispatch failed", {
        callbackId,
        runId,
        error: responseResult.value.error,
      });
      return {
        callbackId,
        success: false,
        error: responseResult.value.error,
      };
    }

    await set(
      recordInternalCallbackDelivery$,
      callbackId,
      { stage: "delivered" },
      signal,
    );
    signal.throwIfAborted();
    return { callbackId, success: true };
  },
);

export const failPendingInlineOnlyDeliveryCallbacksForDeletedThread$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(agentRunCallbacks)
      .set({
        status: "failed",
        lastError: "Chat thread was deleted before inline callback delivery",
      })
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
          inArray(
            agentRunCallbacks.internalKind,
            inlineChatDeliveryCallbackKinds,
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

export const dispatchRunCallbacks$ = command(
  async (
    { get, set },
    {
      runId,
      redriveChatCallbackId,
      skipChatCallback,
    }: DispatchRunCallbacksInput,
    signal: AbortSignal,
  ): Promise<DispatchResult[]> => {
    const callbacks = await get(db$)
      .select({
        id: agentRunCallbacks.id,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
        runStatus: agentRuns.status,
      })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          inArray(agentRunCallbacks.status, ["pending", "failed"]),
          inArray(
            agentRunCallbacks.internalKind,
            skipChatCallback
              ? workflowAutomationRunCallbackKinds
              : terminalRunCallbackKinds,
          ),
          redriveChatCallbackId === undefined
            ? undefined
            : and(
                eq(agentRunCallbacks.id, redriveChatCallbackId),
                eq(agentRunCallbacks.internalKind, "chat"),
              ),
        ),
      );
    signal.throwIfAborted();

    const results: DispatchResult[] = [];
    for (const callback of callbacks) {
      const kind = terminalRunCallbackKinds.find((candidate) => {
        return candidate === callback.internalKind;
      });
      if (kind === undefined) {
        throw new Error(
          "Terminal callback selection returned an unsupported kind",
        );
      }
      const result = await set(
        dispatchSingleInternalCallback$,
        {
          kind,
          envelope: {
            callbackId: callback.id,
            runId,
            status: callback.runStatus === "completed" ? "completed" : "failed",
            payload: callback.payload,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      results.push(result);
    }
    return results;
  },
);
