import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { sendChatAction } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { internalRunCallbackKindForRecord } from "../services/internal-run-callback";
import { tapError } from "../utils";

const L = logger("event-consumer:telegram-typing");

interface TelegramTypingTarget {
  readonly installationId: string;
  readonly chatId: string;
}

function parseTelegramTypingTarget(
  payload: unknown,
): TelegramTypingTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const data = payload as Record<string, unknown>;
  if (
    typeof data.installationId !== "string" ||
    typeof data.chatId !== "string"
  ) {
    return undefined;
  }
  return { installationId: data.installationId, chatId: data.chatId };
}

function telegramTypingTargetForCallback(args: {
  readonly internalKind: ReturnType<typeof internalRunCallbackKindForRecord>;
  readonly payload: unknown;
}): TelegramTypingTarget | undefined {
  if (args.internalKind === "chat") {
    if (!args.payload || typeof args.payload !== "object") {
      return undefined;
    }
    return parseTelegramTypingTarget(
      (args.payload as Record<string, unknown>).telegramDelivery,
    );
  }
  if (args.internalKind !== "telegram:chat") {
    return undefined;
  }
  return parseTelegramTypingTarget(args.payload);
}

// Background-task command. Receives a fresh signal from the caller; failures
// here are caught by tapError at the call site so they cannot crash
// the already-returned 200 response.
const refreshTelegramTypingForRun$ = command(
  async ({ get }, runId: string, _signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
        ),
      );

    const targets = new Map<string, TelegramTypingTarget>();
    for (const callback of callbacks) {
      const target = telegramTypingTargetForCallback({
        internalKind: internalRunCallbackKindForRecord(callback),
        payload: callback.payload,
      });
      if (target) {
        targets.set(`${target.installationId}:${target.chatId}`, target);
      }
    }

    const config = getOfficialTelegramBotConfig();
    if (!config.botToken) {
      return;
    }
    for (const target of targets.values()) {
      if (!isOfficialTelegramBotId(target.installationId)) {
        continue;
      }
      await sendChatAction(config.botToken, target.chatId, "typing");
    }
  },
);

export const refreshTelegramTypingEvents$ = command(
  ({ get, set }, signal: AbortSignal): RefreshResponse => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    waitUntil(
      tapError(
        set(refreshTelegramTypingForRun$, payload.runId, signal),
        (error) => {
          L.debug("Failed to refresh Telegram typing from events", {
            runId: payload.runId,
            error,
          });
        },
      ),
    );

    return { status: 200, body: { scheduled: true } };
  },
);

interface RefreshResponse {
  readonly status: 200;
  readonly body: { readonly scheduled: true };
}
