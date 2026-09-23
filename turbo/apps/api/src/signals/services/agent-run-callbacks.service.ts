import { command } from "ccstate";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { computeHmacSignature } from "../../lib/event-consumer/hmac";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { tapError } from "../utils";
import { refreshAgentPhoneTypingForRun$ } from "./agent-event-consumer-agentphone-typing.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { handleChatInternalCallback$ } from "./internal-chat-run-callback.service";
import { internalRunCallbackKindForRecord } from "./internal-run-callback";

const L = logger("agent-run-callbacks");

function resolveCallbackUrl(url: string): string {
  return env("ENV") === "development" && url.startsWith("https://tunnel-")
    ? url.replace(/^https:\/\/tunnel-[^/]+/, "http://localhost:3000")
    : url;
}

function isCanonicalChatCallback(callback: {
  readonly internalKind: string | null;
}): boolean {
  return internalRunCallbackKindForRecord(callback) === "chat";
}

function isInlineOnlyCanonicalDeliveryCallback(
  internalKind: string | null,
): boolean {
  return (
    internalKind === "agentphone:chat" ||
    internalKind === "slack:chat" ||
    internalKind === "feishu:chat" ||
    internalKind === "teams:chat" ||
    internalKind === "telegram:chat" ||
    internalKind === "github:chat"
  );
}

export const dispatchProgressCallbacks$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const [run] = await db
      .select({
        status: agentRuns.status,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run || run.status === "completed" || run.status === "failed") {
      return;
    }
    const featureSwitchContext = {
      orgId: run.orgId,
      userId: run.userId,
      overrides: await get(userFeatureSwitchOverrides(run.orgId, run.userId)),
    } satisfies FeatureSwitchContext;

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
          eq(agentRunCallbacks.status, "pending"),
          or(
            isNull(agentRunCallbacks.internalKind),
            notInArray(agentRunCallbacks.internalKind, [
              "slack:chat",
              "feishu:chat",
              "teams:chat",
              "telegram:chat",
              "github:chat",
              "slack:org",
            ]),
          ),
        ),
      );
    signal.throwIfAborted();

    if (callbacks.length === 0) {
      return;
    }

    if (
      callbacks.some(isCanonicalChatCallback) ||
      callbacks.some((callback) => {
        return internalRunCallbackKindForRecord(callback) === "agentphone:chat";
      })
    ) {
      // Like Slack thread status, typing is a best-effort progress side effect.
      // The provider may reject it, and the request signal may end before the
      // detached work completes; neither should stop other progress callbacks.
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(refreshAgentPhoneTypingForRun$, runId, backgroundSignal),
          (error) => {
            L.debug("Failed to refresh AgentPhone typing from progress", {
              runId,
              error,
            });
          },
        ),
      );
    }

    await Promise.allSettled(
      callbacks.map(async (callback) => {
        const internalKind = internalRunCallbackKindForRecord(callback);
        const progressCallback = {
          callbackId: callback.id,
          runId,
          status: "progress" as const,
          payload: callback.payload,
        };
        if (internalKind === "chat") {
          await set(
            handleChatInternalCallback$,
            { callback: progressCallback },
            signal,
          );
          return;
        }
        if (isInlineOnlyCanonicalDeliveryCallback(internalKind)) {
          return;
        }
        if (!callback.url) {
          return;
        }
        if (!callback.encryptedSecret) {
          return;
        }
        const body = JSON.stringify({
          callbackId: callback.id,
          runId,
          status: "progress",
          payload: callback.payload,
        });
        const timestamp = Math.floor(now() / 1000);
        const signature = computeHmacSignature(
          body,
          await decryptPersistentSecretValue(
            callback.encryptedSecret,
            featureSwitchContext,
          ),
          timestamp,
        );

        return fetch(resolveCallbackUrl(callback.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Okou-Signature": signature,
            "X-Okou-Timestamp": timestamp.toString(),
          },
          body,
          signal,
        });
      }),
    );
  },
);
