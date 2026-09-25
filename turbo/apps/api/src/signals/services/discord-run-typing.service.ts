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
import { requireDiscordBinding$ } from "./discord-access.service";
import type { DiscordFailureResponse } from "./discord-api-response";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import { findDiscordChatRoute } from "./discord-chat-route-access.service";
import { resolveDiscordProviderAccess } from "./discord-provider-access";
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
/**
 * Typing reuses a destination's Discord permission reads for this long so an
 * active run costs one typing request per refresh instead of the full
 * multi-request check. Only typing reads it; delivery always rechecks.
 */
const TYPING_ACCESS_REUSE_MS = 45_000;
const MAX_TYPING_ENTRIES = 1000;

/**
 * Process-local suppression for repeated sends and Discord `retry_after`, and
 * typing-only reuse of permission reads. Entries expire at their deadline and
 * each table has a hard capacity; another API instance may still send once,
 * which the Runner cadence bounds.
 */
const typingHoldTable = singleton(() => {
  return new Map<string, number>();
});
const typingAccessTable = singleton(() => {
  return new Map<string, number>();
});
/** Kept outside the bounded tables so eviction can never drop it. */
const globalTypingHold = singleton(() => {
  return { until: 0 };
});

function liveEntry(table: Map<string, number>, key: string): boolean {
  const until = table.get(key);
  if (until === undefined) {
    return false;
  }
  if (until > now()) {
    return true;
  }
  table.delete(key);
  return false;
}

function typingHeld(channelId: string): boolean {
  const global = globalTypingHold();
  if (global.until > now()) {
    return true;
  }
  global.until = 0;
  return liveEntry(typingHoldTable(), channelId);
}

function setBoundedEntry(
  table: Map<string, number>,
  key: string,
  until: number,
): void {
  if ((table.get(key) ?? 0) >= until) {
    return;
  }
  table.delete(key);
  if (table.size >= MAX_TYPING_ENTRIES) {
    const current = now();
    for (const [heldKey, heldUntil] of table) {
      if (heldUntil <= current) {
        table.delete(heldKey);
      }
    }
    const oldest = table.keys().next();
    if (table.size >= MAX_TYPING_ENTRIES && !oldest.done) {
      table.delete(oldest.value);
    }
  }
  table.set(key, until);
}

function holdTyping(channelId: string, durationMs: number): void {
  setBoundedEntry(typingHoldTable(), channelId, now() + durationMs);
}

/** Any rate limit typing sees pauses all typing; status must yield first. */
function holdAllTyping(durationMs: number): void {
  const global = globalTypingHold();
  global.until = Math.max(global.until, now() + durationMs);
}

async function sendTypingOnce(
  args: {
    readonly botToken: string;
    readonly channelId: string;
    readonly accessKey?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  // Check and claim synchronously so concurrent callers send at most once.
  if (typingHeld(args.channelId)) {
    return;
  }
  holdTyping(args.channelId, TYPING_REPEAT_HOLD_MS);
  const result = await discordClient.sendDiscordTyping(
    { botToken: args.botToken, channelId: args.channelId },
    signal,
  );
  if (result.kind === "ok") {
    return;
  }
  if (result.kind === "discord-error" && result.retryAfterMs !== undefined) {
    if (result.global) {
      holdAllTyping(result.retryAfterMs);
    } else {
      holdTyping(args.channelId, result.retryAfterMs);
    }
  }
  if (result.kind === "unavailable" && args.accessKey !== undefined) {
    typingAccessTable().delete(args.accessKey);
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

/** Returns null when access is gone; throws when the failure is transient. */
function typingAccessDenied(response: DiscordFailureResponse): null {
  const retryAfterSeconds = response.body.error.retryAfterSeconds;
  if (response.status === 429) {
    holdAllTyping((retryAfterSeconds ?? 1) * 1000);
  }
  if (response.status === 403 || response.status === 404) {
    return null;
  }
  throw new Error(`Discord typing access check failed: ${response.status}`);
}

/**
 * The route, feature, binding and membership checks run on every refresh.
 * Discord permission reads are reused for typing only, within a short window.
 */
async function currentTypingAccess(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly target: DiscordDeliveryTarget;
  },
  signal: AbortSignal,
): Promise<{ readonly botToken: string; readonly accessKey: string } | null> {
  const route = await findDiscordChatRoute(db, args);
  signal.throwIfAborted();
  if (!route) {
    return null;
  }
  const current = await createStore().set(
    requireDiscordBinding$,
    { orgId: args.orgId, userId: args.userId, guildId: args.target.guildId },
    signal,
  );
  signal.throwIfAborted();
  if (current.kind === "denied") {
    return typingAccessDenied(current.response);
  }
  if (
    current.binding.connectionId !== args.target.connectionId ||
    current.binding.discordUserId !== args.target.discordUserId
  ) {
    return null;
  }
  const accessKey = [
    current.binding.connectionId,
    current.binding.discordUserId,
    args.target.guildId,
    args.target.channelId,
  ].join(":");
  if (liveEntry(typingAccessTable(), accessKey)) {
    return { botToken: current.botToken, accessKey };
  }
  const access = await resolveDiscordProviderAccess(
    {
      ...current.binding,
      botToken: current.botToken,
      channelId: args.target.channelId,
      mode: "write",
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    return typingAccessDenied(access.response);
  }
  setBoundedEntry(
    typingAccessTable(),
    accessKey,
    now() + TYPING_ACCESS_REUSE_MS,
  );
  return { botToken: current.botToken, accessKey };
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
    {
      botToken: access.botToken,
      channelId: args.target.channelId,
      accessKey: access.accessKey,
    },
    signal,
  );
}

/**
 * Detached typing for a Discord-triggered run that is still active. Every
 * attempt revalidates the route, binding and feature; destination permission
 * reads are reused for typing within {@link TYPING_ACCESS_REUSE_MS}.
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
