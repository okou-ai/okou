import { formatRunBalanceError } from "@okouai/api-contracts/contracts/run-balance-errors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command } from "ccstate";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { env, optionalEnv } from "../../lib/env";
import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { handleChatInternalCallback$ } from "./internal-chat-run-callback.service";
import { handleFeishuOrgInternalCallback$ } from "./internal-feishu-org-run-callback.service";
import {
  internalRunCallbackKindForRecord,
  type InternalRunCallbackDispatchResult,
  type InternalRunCallbackEnvelope,
  type InternalRunCallbackKind,
} from "./internal-run-callback";
import { handleWorkflowAutomationResultEmailInternalCallback$ } from "./internal-workflow-automation-result-email-callback.service";
import { handlePiMemoryPhase2MaintenanceCallback } from "./pi-memory-phase2-maintenance.service";
import { handleWorkflowAutomationInternalCallback$ } from "./workflow-automation-run-callback.service";

const L = logger("AgentRunCallback");

// Retired kinds (`github:chat`, `slack:org`) stay here so historical rows are
// never mistaken for HTTP callbacks by the terminal dispatch queries.
const INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS = [
  "slack:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
  "agentphone:chat",
  "github:chat",
  "slack:org",
] as const;
const DELETED_THREAD_INLINE_CALLBACK_ERROR =
  "Chat thread was deleted before inline callback delivery";

interface CallbackRecord {
  readonly id: string;
  readonly url: string | null;
  readonly internalKind: string | null;
  readonly encryptedSecret: string | null;
  readonly payload: unknown;
}

interface DispatchResult {
  readonly callbackId: string;
  readonly success: boolean;
  readonly error?: string;
}

type TerminalCallbackStatus = "completed" | "failed";

interface DispatchRunCallbacksInput {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly redriveChatCallbackId?: string;
  readonly skipChatCallback?: boolean;
}

interface DispatchSingleCallbackInput {
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly balanceContext: Parameters<typeof formatRunBalanceError>[0];
}

export async function undeliveredChatCallbackIdForRun(
  db: Pick<Db, "select">,
  runId: string,
): Promise<string | undefined> {
  const [callback] = await db
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
}

interface DispatchInternalRunCallbackInput {
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly kind: InternalRunCallbackKind;
}

interface DispatchInternalCallbackInput {
  readonly kind: InternalRunCallbackKind;
  readonly envelope: InternalRunCallbackEnvelope;
}

const dispatchInternalCallback$ = command(
  async (
    { set },
    input: DispatchInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    switch (input.kind) {
      case "agentphone:chat": {
        return {
          success: false,
          error: "AgentPhone chat delivery callbacks are inline-only",
        };
      }
      case "chat": {
        return await set(
          handleChatInternalCallback$,
          { callback: input.envelope },
          signal,
        );
      }
      case "feishu:org": {
        return await set(
          handleFeishuOrgInternalCallback$,
          input.envelope,
          signal,
        );
      }
      case "slack:chat": {
        return {
          success: false,
          error: "Slack chat delivery callbacks are inline-only",
        };
      }
      case "feishu:chat": {
        return {
          success: false,
          error: "Feishu chat delivery callbacks are inline-only",
        };
      }
      case "teams:chat": {
        return {
          success: false,
          error: "Teams chat delivery callbacks are inline-only",
        };
      }
      case "telegram:chat": {
        return {
          success: false,
          error: "Telegram chat delivery callbacks are inline-only",
        };
      }
      case "workflow-automation:cron":
      case "workflow-automation:loop": {
        return await set(
          handleWorkflowAutomationInternalCallback$,
          { kind: input.kind, callback: input.envelope },
          signal,
        );
      }
      case "workflow-automation:result-email": {
        return await set(
          handleWorkflowAutomationResultEmailInternalCallback$,
          input.envelope,
          signal,
        );
      }
      case "pi-memory:phase2": {
        return await handlePiMemoryPhase2MaintenanceCallback(
          set(writeDb$),
          input.envelope,
        );
      }
    }
  },
);

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

type InternalCallbackDeliveryStage =
  | { readonly stage: "attempt-started" }
  | { readonly stage: "delivered" }
  | { readonly stage: "failed"; readonly error: string };

/** Own only internal delivery bookkeeping, not callback dispatch or recovery. */
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
    input: DispatchInternalRunCallbackInput,
    signal: AbortSignal,
  ): Promise<DispatchResult> => {
    await set(
      recordInternalCallbackDelivery$,
      input.callback.id,
      { stage: "attempt-started" },
      signal,
    );
    signal.throwIfAborted();
    const callbackId = input.callback.id;
    const responseResult = await settle(
      set(
        dispatchInternalCallback$,
        {
          kind: input.kind,
          envelope: callbackEnvelope(input),
        },
        signal,
      ),
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
        runId: input.runId,
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
        runId: input.runId,
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
        lastError: DELETED_THREAD_INLINE_CALLBACK_ERROR,
      })
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
          inArray(agentRunCallbacks.internalKind, [
            ...INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS,
          ]),
        ),
      );
    signal.throwIfAborted();
  },
);

export const dispatchRunCallbacks$ = command(
  async (
    { set },
    input: DispatchRunCallbacksInput,
    signal: AbortSignal,
  ): Promise<DispatchResult[]> => {
    const {
      db,
      runId,
      status,
      result,
      error,
      redriveChatCallbackId,
      skipChatCallback,
    } = input;
    const [run] = await db
      .select({
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        failureReason: agentRuns.failureReason,
        modelProvider: agentRuns.modelProvider,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return [];
    }
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      run.orgId,
      run.userId,
      signal,
    );
    signal.throwIfAborted();
    const callbacks = await db
      .select({
        id: agentRunCallbacks.id,
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          redriveChatCallbackId === undefined
            ? undefined
            : and(
                eq(agentRunCallbacks.id, redriveChatCallbackId),
                eq(agentRunCallbacks.internalKind, "chat"),
              ),
          or(
            eq(agentRunCallbacks.status, "pending"),
            eq(agentRunCallbacks.status, "failed"),
          ),
          or(
            isNull(agentRunCallbacks.internalKind),
            notInArray(agentRunCallbacks.internalKind, [
              ...INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS,
              ...(skipChatCallback ? (["chat"] as const) : []),
            ]),
          ),
        ),
      );
    signal.throwIfAborted();

    const results: DispatchResult[] = [];
    for (const callback of callbacks) {
      const internalKind = internalRunCallbackKindForRecord(callback);
      const dispatchResult: DispatchResult = internalKind
        ? await set(
            dispatchSingleInternalCallback$,
            {
              callback,
              runId,
              status,
              result,
              error,
              kind: internalKind,
            },
            signal,
          )
        : await set(
            dispatchHttpCallback$,
            {
              callback,
              runId,
              status,
              result,
              error,
              featureSwitchContext,
              balanceContext: {
                failureReason: run.failureReason,
                modelProvider: run.modelProvider,
              },
            },
            signal,
          );
      signal.throwIfAborted();
      results.push(dispatchResult);
    }
    return results;
  },
);

function callbackEnvelope(
  input: DispatchInternalRunCallbackInput,
): InternalRunCallbackEnvelope {
  const base = {
    callbackId: input.callback.id,
    runId: input.runId,
    result: input.result,
    payload: input.callback.payload,
  };
  if (input.status === "failed") {
    const error = input.error?.trim();
    if (!error) {
      throw new Error("Failed internal run callbacks require an error");
    }
    return { ...base, status: "failed", error };
  }
  return {
    ...base,
    status: input.status,
    error: input.error,
  };
}

const dispatchHttpCallback$ = command(
  async (
    { set },
    input: DispatchSingleCallbackInput,
    signal: AbortSignal,
  ): Promise<DispatchResult> => {
    const { callback, runId, status, result, error } = input;
    if (!callback.url) {
      const errorMessage = "Callback URL is missing";
      await set(
        recordHttpCallbackDelivery$,
        callback.id,
        { stage: "failed", error: errorMessage },
        signal,
      );
      return { callbackId: callback.id, success: false, error: errorMessage };
    }
    if (!callback.encryptedSecret) {
      const errorMessage = "Callback secret is missing";
      await set(
        recordHttpCallbackDelivery$,
        callback.id,
        { stage: "failed", error: errorMessage },
        signal,
      );
      return { callbackId: callback.id, success: false, error: errorMessage };
    }
    const secret = await decryptPersistentSecretValue(
      callback.encryptedSecret,
      input.featureSwitchContext,
    );
    signal.throwIfAborted();
    const body = JSON.stringify({
      callbackId: callback.id,
      runId,
      status,
      result,
      error:
        error === undefined
          ? undefined
          : (formatRunBalanceError(input.balanceContext) ?? error),
      payload: callback.payload,
    });
    const timestamp = Math.floor(now() / 1000);
    const signature = computeHmacSignature(body, secret, timestamp);

    await set(
      recordHttpCallbackDelivery$,
      callback.id,
      { stage: "attempt-started" },
      signal,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Okou-Signature": signature,
      "X-Okou-Timestamp": timestamp.toString(),
    };
    const bypass = optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET");
    if (bypass) {
      headers["x-vercel-protection-bypass"] = bypass;
    }

    const responseResult = await settle(
      fetch(resolveCallbackUrl(callback.url), {
        method: "POST",
        headers,
        body,
      }),
    );
    signal.throwIfAborted();

    if (!responseResult.ok) {
      const errorMessage =
        responseResult.error instanceof Error
          ? responseResult.error.message
          : "Unknown error";
      await set(
        recordHttpCallbackDelivery$,
        callback.id,
        { stage: "failed", error: errorMessage },
        signal,
      );
      L.error("Callback dispatch threw", {
        callbackId: callback.id,
        runId,
        error: responseResult.error,
      });
      return { callbackId: callback.id, success: false, error: errorMessage };
    }

    const response = responseResult.value;
    if (response.ok) {
      await set(
        recordHttpCallbackDelivery$,
        callback.id,
        { stage: "delivered" },
        signal,
      );
      return { callbackId: callback.id, success: true };
    }

    const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    await set(
      recordHttpCallbackDelivery$,
      callback.id,
      { stage: "failed", error: errorMessage },
      signal,
    );
    L.warn("Callback dispatch failed", {
      callbackId: callback.id,
      runId,
      error: errorMessage,
    });
    return { callbackId: callback.id, success: false, error: errorMessage };
  },
);

type HttpCallbackDeliveryStage =
  | { readonly stage: "attempt-started" }
  | { readonly stage: "delivered" }
  | { readonly stage: "failed"; readonly error: string };

// HTTP fetch remains non-interruptible; cancellation is observed after awaits.
// A completed request can remain unrecorded and be delivered again on recovery.
const recordHttpCallbackDelivery$ = command(
  async (
    { set },
    callbackId: string,
    delivery: HttpCallbackDeliveryStage,
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
