import { command } from "ccstate";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { env, optionalEnv } from "../../lib/env";
import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { settle } from "../utils";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  handleChatInternalCallback$,
  handleChatInternalCallbackWithoutCcstate,
} from "./internal-chat-run-callback.service";
import {
  handleFeishuOrgInternalCallback$,
  handleFeishuOrgInternalCallbackWithoutCcstate,
} from "./internal-feishu-org-run-callback.service";
import {
  internalRunCallbackKindForRecord,
  type InternalRunCallbackDispatchResult,
  type InternalRunCallbackEnvelope,
  type InternalRunCallbackKind,
} from "./internal-run-callback";
import {
  handleWorkflowAutomationInternalCallback,
  handleWorkflowAutomationInternalCallback$,
} from "./workflow-automation-run-callback.service";
import {
  handleWorkflowAutomationResultEmailInternalCallback,
  handleWorkflowAutomationResultEmailInternalCallback$,
} from "./internal-workflow-automation-result-email-callback.service";
import { handlePiMemoryPhase2MaintenanceCallback } from "./pi-memory-phase2-maintenance.service";

const L = logger("AgentRunCallback");

const INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS = [
  "slack:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
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
}

interface DispatchSingleCallbackInput {
  readonly db: Db;
  readonly callback: CallbackRecord;
  readonly runId: string;
  readonly status: TerminalCallbackStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

export async function chatCallbackIdForRun(
  db: Db,
  runId: string,
): Promise<string | undefined> {
  const [callback] = await db
    .select({ id: agentRunCallbacks.id })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      ),
    )
    .limit(1);
  return callback?.id;
}

interface DispatchInternalRunCallbackInput {
  readonly db: Db;
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
          {
            callback: input.envelope,
            drainThreadQueue: async (chatThreadId, inputSignal, timing) => {
              await set(
                drainChatThreadQueueForThread$,
                {
                  chatThreadId,
                  dispatchFailedCallbacks: dispatchFailedRunCallbacks,
                  timing,
                },
                inputSignal,
              );
            },
          },
          signal,
        );
      }
      case "github:chat": {
        return {
          success: false,
          error: "GitHub chat delivery callbacks are inline-only",
        };
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

const dispatchSingleInternalCallback$ = command(
  async (
    { set },
    input: DispatchInternalRunCallbackInput,
    signal: AbortSignal,
  ): Promise<DispatchResult> => {
    await markCallbackAttemptStarted(input.db, input.callback.id);
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
      await markCallbackFailed(input.db, callbackId, errorMessage);
      signal.throwIfAborted();
      L.error("Internal callback dispatch threw", {
        callbackId,
        runId: input.runId,
        error: responseResult.error,
      });
      return { callbackId, success: false, error: errorMessage };
    }

    if (!responseResult.value.success) {
      await markCallbackFailed(
        input.db,
        callbackId,
        responseResult.value.error,
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

    await markCallbackDelivered(input.db, callbackId);
    signal.throwIfAborted();
    return { callbackId, success: true };
  },
);

export async function dispatchRunCallbacks(
  db: Db,
  runId: string,
  status: TerminalCallbackStatus,
  result?: Record<string, unknown>,
  error?: string,
): Promise<DispatchResult[]> {
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    return [];
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    run.orgId,
    run.userId,
  );
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
        or(
          eq(agentRunCallbacks.status, "pending"),
          eq(agentRunCallbacks.status, "failed"),
        ),
        or(
          isNull(agentRunCallbacks.internalKind),
          notInArray(agentRunCallbacks.internalKind, [
            ...INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS,
          ]),
        ),
      ),
    );

  const results: DispatchResult[] = [];
  for (const callback of callbacks) {
    const dispatchResult = await dispatchSingleCallback({
      db,
      callback,
      runId,
      status,
      result,
      error,
      featureSwitchContext,
    });
    results.push(dispatchResult);
  }
  return results;
}

export async function dispatchFailedRunCallbacks(
  db: Db,
  runId: string,
  error: string,
): Promise<void> {
  await dispatchRunCallbacks(db, runId, "failed", undefined, error);
}

export async function failPendingInlineOnlyDeliveryCallbacksForDeletedThread(
  db: Db,
  runId: string,
): Promise<void> {
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
}

export const dispatchRunCallbacks$ = command(
  async (
    { set },
    input: DispatchRunCallbacksInput,
    signal: AbortSignal,
  ): Promise<DispatchResult[]> => {
    const { db, runId, status, result, error, redriveChatCallbackId } = input;
    const [run] = await db
      .select({
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      return [];
    }
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      run.orgId,
      run.userId,
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
          redriveChatCallbackId === undefined
            ? or(
                eq(agentRunCallbacks.status, "pending"),
                eq(agentRunCallbacks.status, "failed"),
              )
            : undefined,
          or(
            isNull(agentRunCallbacks.internalKind),
            notInArray(agentRunCallbacks.internalKind, [
              ...INLINE_ONLY_INTEGRATION_DELIVERY_CALLBACK_KINDS,
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
              db,
              callback,
              runId,
              status,
              result,
              error,
              kind: internalKind,
            },
            signal,
          )
        : await dispatchHttpCallback({
            db,
            callback,
            runId,
            status,
            result,
            error,
            featureSwitchContext,
          });
      signal.throwIfAborted();
      results.push(dispatchResult);
    }
    return results;
  },
);

async function dispatchSingleCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const internalKind = internalRunCallbackKindForRecord(input.callback);
  if (internalKind) {
    return await dispatchInternalCallback(input);
  }
  return await dispatchHttpCallback(input);
}

async function dispatchInternalCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const internalKind = internalRunCallbackKindForRecord(input.callback);
  if (!internalKind) {
    const errorMessage = "Unknown internal callback kind";
    await markCallbackFailed(input.db, input.callback.id, errorMessage);
    return {
      callbackId: input.callback.id,
      success: false,
      error: errorMessage,
    };
  }

  await markCallbackAttemptStarted(input.db, input.callback.id);
  const callbackId = input.callback.id;
  const responseResult = await settle(
    dispatchInternalCallbackWithoutCcstate(input, internalKind),
  );

  if (!responseResult.ok) {
    const errorMessage =
      responseResult.error instanceof Error
        ? responseResult.error.message
        : "Unknown error";
    await markCallbackFailed(input.db, callbackId, errorMessage);
    L.error("Internal callback dispatch threw", {
      callbackId,
      runId: input.runId,
      error: responseResult.error,
    });
    return { callbackId, success: false, error: errorMessage };
  }

  if (!responseResult.value.success) {
    await markCallbackFailed(input.db, callbackId, responseResult.value.error);
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

  await markCallbackDelivered(input.db, callbackId);
  return { callbackId, success: true };
}

async function dispatchInternalCallbackWithoutCcstate(
  input: DispatchSingleCallbackInput,
  kind: InternalRunCallbackKind,
): Promise<InternalRunCallbackDispatchResult> {
  switch (kind) {
    case "agentphone:chat": {
      return {
        success: false,
        error: "AgentPhone chat delivery callbacks are inline-only",
      };
    }
    case "chat": {
      return await handleChatInternalCallbackWithoutCcstate(
        input.db,
        callbackEnvelope(input),
      );
    }
    case "github:chat": {
      return {
        success: false,
        error: "GitHub chat delivery callbacks are inline-only",
      };
    }
    case "feishu:org": {
      return await handleFeishuOrgInternalCallbackWithoutCcstate(
        input.db,
        callbackEnvelope(input),
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
      return await handleWorkflowAutomationInternalCallback(input.db, {
        kind,
        callback: callbackEnvelope(input),
      });
    }
    case "workflow-automation:result-email": {
      return await handleWorkflowAutomationResultEmailInternalCallback(
        input.db,
        callbackEnvelope(input),
      );
    }
    case "pi-memory:phase2": {
      return await handlePiMemoryPhase2MaintenanceCallback(
        input.db,
        callbackEnvelope(input),
      );
    }
  }
}

function callbackEnvelope(
  input: DispatchInternalRunCallbackInput | DispatchSingleCallbackInput,
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

async function dispatchHttpCallback(
  input: DispatchSingleCallbackInput,
): Promise<DispatchResult> {
  const { db, callback, runId, status, result, error } = input;
  if (!callback.url) {
    const errorMessage = "Callback URL is missing";
    await markCallbackFailed(db, callback.id, errorMessage);
    return { callbackId: callback.id, success: false, error: errorMessage };
  }
  if (!callback.encryptedSecret) {
    const errorMessage = "Callback secret is missing";
    await markCallbackFailed(db, callback.id, errorMessage);
    return { callbackId: callback.id, success: false, error: errorMessage };
  }
  const secret = await decryptPersistentSecretValue(
    callback.encryptedSecret,
    input.featureSwitchContext,
  );
  const body = JSON.stringify({
    callbackId: callback.id,
    runId,
    status,
    result,
    error,
    payload: callback.payload,
  });
  const timestamp = Math.floor(now() / 1000);
  const signature = computeHmacSignature(body, secret, timestamp);

  await markCallbackAttemptStarted(db, callback.id);

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

  if (!responseResult.ok) {
    const errorMessage =
      responseResult.error instanceof Error
        ? responseResult.error.message
        : "Unknown error";
    await markCallbackFailed(db, callback.id, errorMessage);
    L.error("Callback dispatch threw", {
      callbackId: callback.id,
      runId,
      error: responseResult.error,
    });
    return { callbackId: callback.id, success: false, error: errorMessage };
  }

  const response = responseResult.value;
  if (response.ok) {
    await markCallbackDelivered(db, callback.id);
    return { callbackId: callback.id, success: true };
  }

  const errorMessage = `HTTP ${response.status}: ${response.statusText}`;
  await markCallbackFailed(db, callback.id, errorMessage);
  L.warn("Callback dispatch failed", {
    callbackId: callback.id,
    runId,
    error: errorMessage,
  });
  return { callbackId: callback.id, success: false, error: errorMessage };
}

async function markCallbackAttemptStarted(
  db: Db,
  callbackId: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      attempts: 1,
      lastAttemptAt: nowDate(),
    })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markCallbackDelivered(
  db: Db,
  callbackId: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      status: "delivered",
      deliveredAt: nowDate(),
    })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markCallbackFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({
      status: "failed",
      lastError: error,
    })
    .where(eq(agentRunCallbacks.id, callbackId));
}
