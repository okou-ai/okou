import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import type { Db, ReadonlyDb } from "../external/db";
import { discordClient } from "../external/discord-client";
import { tapError } from "../utils";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import { findDiscordChatRoute } from "./discord-chat-route-access.service";
import { internalRunCallbackKindForRecord } from "./internal-run-callback";

const L = logger("DiscordRunTyping");
const discordTypingPayloadSchema = z.object({
  discordDelivery: discordDeliveryTargetSchema,
});

/**
 * Discord shows a bot as typing for about ten seconds, so an active run asks
 * its Runner heartbeat to refresh the indicator on this cadence.
 */
export const DISCORD_TYPING_REFRESH_INTERVAL_SECONDS = 8;

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
/** Admission, launch and the first heartbeat all land within a few seconds. */
const TYPING_REPEAT_HOLD_MS = 5000;
const MAX_TYPING_HOLDS = 1000;
const GLOBAL_TYPING_HOLD = "global";

/**
 * Process-local suppression for repeated sends and Discord `retry_after`.
 * Entries expire at their deadline and the table has a hard capacity; another
 * API instance may still send once, which the Runner cadence bounds.
 */
const typingHoldTable = singleton(() => {
  return new Map<string, number>();
});

function typingHeld(channelId: string): boolean {
  const typingHolds = typingHoldTable();
  const current = now();
  return [channelId, GLOBAL_TYPING_HOLD].some((key) => {
    const until = typingHolds.get(key);
    if (until === undefined) {
      return false;
    }
    if (until > current) {
      return true;
    }
    typingHolds.delete(key);
    return false;
  });
}

function holdTyping(key: string, durationMs: number): void {
  const typingHolds = typingHoldTable();
  const until = now() + durationMs;
  if ((typingHolds.get(key) ?? 0) >= until) {
    return;
  }
  typingHolds.delete(key);
  if (typingHolds.size >= MAX_TYPING_HOLDS) {
    const current = now();
    for (const [heldKey, heldUntil] of typingHolds) {
      if (heldUntil <= current) {
        typingHolds.delete(heldKey);
      }
    }
    const oldest = typingHolds.keys().next();
    if (typingHolds.size >= MAX_TYPING_HOLDS && !oldest.done) {
      typingHolds.delete(oldest.value);
    }
  }
  typingHolds.set(key, until);
}

async function sendTypingOnce(
  args: { readonly botToken: string; readonly channelId: string },
  signal: AbortSignal,
): Promise<void> {
  // Check and claim synchronously so concurrent callers send at most once.
  if (typingHeld(args.channelId)) {
    return;
  }
  holdTyping(args.channelId, TYPING_REPEAT_HOLD_MS);
  const result = await discordClient.sendDiscordTyping(args, signal);
  if (result.kind === "ok") {
    return;
  }
  if (result.kind === "discord-error" && result.retryAfterMs !== undefined) {
    holdTyping(
      result.global ? GLOBAL_TYPING_HOLD : args.channelId,
      result.retryAfterMs,
    );
  }
  L.warn("Discord typing indicator was not sent", {
    channelId: args.channelId,
    status: result.status,
  });
}

function scheduleTyping(
  work: (signal: AbortSignal) => Promise<void>,
  fields: Record<string, string>,
): void {
  // Status is cosmetic: it must never delay or fail admission or delivery.
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(work(backgroundSignal), (error) => {
      L.warn("Failed to refresh Discord typing indicator", {
        ...fields,
        error,
      });
    }),
  );
}

/** Admission has just fenced write access to the destination with this token. */
export function scheduleDiscordAdmissionTyping(args: {
  readonly botToken: string;
  readonly channelId: string;
}): void {
  scheduleTyping(
    (signal) => {
      return sendTypingOnce(args, signal);
    },
    { channelId: args.channelId },
  );
}

async function activeRunOwner(
  db: ReadonlyDb,
  args: { readonly runId: string; readonly chatThreadId: string },
) {
  const [run] = await db
    .select({ orgId: agentRuns.orgId, userId: agentRuns.userId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.chatThreadId, args.chatThreadId),
        eq(agentRuns.triggerSource, "discord"),
        inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(1);
  return run;
}

async function currentTypingAccess(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly target: DiscordDeliveryTarget;
  },
  signal: AbortSignal,
) {
  const route = await findDiscordChatRoute(db, args);
  signal.throwIfAborted();
  if (!route) {
    return null;
  }
  const access = await createStore().set(
    requireDiscordConversationAccess$,
    {
      orgId: args.orgId,
      userId: args.userId,
      guildId: args.target.guildId,
      channelId: args.target.channelId,
      mode: "write",
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    const retryAfterSeconds = access.response.body.error.retryAfterSeconds;
    if (retryAfterSeconds !== undefined) {
      holdTyping(args.target.channelId, retryAfterSeconds * 1000);
    }
    if (access.response.status === 403 || access.response.status === 404) {
      return null;
    }
    throw new Error(
      `Discord typing access check failed: ${access.response.status}`,
    );
  }
  if (
    access.binding.connectionId !== args.target.connectionId ||
    access.binding.discordUserId !== args.target.discordUserId
  ) {
    return null;
  }
  return access;
}

async function refreshDiscordRunTyping(
  db: Db,
  args: {
    readonly runId: string;
    readonly chatThreadId: string;
    readonly target: DiscordDeliveryTarget;
  },
  signal: AbortSignal,
): Promise<void> {
  if (typingHeld(args.target.channelId)) {
    return;
  }
  const run = await activeRunOwner(db, args);
  signal.throwIfAborted();
  if (!run) {
    return;
  }
  const access = await currentTypingAccess(
    db,
    { ...args, orgId: run.orgId, userId: run.userId },
    signal,
  );
  if (!access) {
    return;
  }
  // Provider checks take time; a reply may have been delivered meanwhile.
  const stillActive = await activeRunOwner(db, args);
  signal.throwIfAborted();
  if (!stillActive) {
    return;
  }
  await sendTypingOnce(
    { botToken: access.botToken, channelId: args.target.channelId },
    signal,
  );
}

/**
 * Detached typing for a Discord-triggered run that is still active. Every
 * attempt revalidates the route, binding, feature and destination access.
 */
export function scheduleDiscordRunTyping(
  db: Db,
  args: {
    readonly runId: string;
    readonly chatThreadId: string;
    readonly target: DiscordDeliveryTarget;
  },
): void {
  scheduleTyping(
    (signal) => {
      return refreshDiscordRunTyping(db, args, signal);
    },
    { runId: args.runId },
  );
}

/** Whether the Runner heartbeat should use the Discord typing cadence. */
export async function hasDiscordTypingTargetForRun(
  db: ReadonlyDb,
  runId: string,
): Promise<boolean> {
  const callbacks = await db
    .select({
      url: agentRunCallbacks.url,
      internalKind: agentRunCallbacks.internalKind,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .innerJoin(agentRuns, eq(agentRunCallbacks.runId, agentRuns.id))
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRuns.triggerSource, "discord"),
        inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );
  return callbacks.some((callback) => {
    return (
      internalRunCallbackKindForRecord(callback) === "chat" &&
      discordTypingPayloadSchema.safeParse(callback.payload).success
    );
  });
}
