import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";

import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import { discordClient } from "../external/discord-client";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { onRejection, tapError } from "../utils";
import { requireDiscordBinding$ } from "./discord-access.service";
import type { DiscordFailureResponse } from "./discord-api-response";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";
import { discordChatRouteReadPlan } from "./discord-chat-route-access.service";
import { resolveDiscordProviderAccess } from "./discord-provider-access";

const L = logger("DiscordRunTyping");

/**
 * Discord shows a bot as typing for about ten seconds, so an active run asks
 * its Runner heartbeat to refresh early enough for permission and network work.
 */
export const DISCORD_TYPING_REFRESH_INTERVAL_SECONDS = 6;

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
/** A skipped first heartbeat must not push the next refresh past ten seconds. */
const TYPING_REPEAT_HOLD_MS = 1000;
/**
 * Typing reuses a destination's Discord permission reads for this long so an
 * active run costs one typing request per refresh instead of the full
 * multi-request check. Only typing reads it; delivery always rechecks.
 */
const TYPING_ACCESS_REUSE_MS = 45_000;
const MAX_TYPING_ENTRIES = 1000;

interface TypingContext {
  readonly phase: "admission" | "refresh";
  readonly ingressId?: string;
  readonly admittedAt?: number;
  readonly runId?: string;
}

interface ExpiringEntry {
  readonly until: number;
}

interface TypingHold extends ExpiringEntry {
  readonly reason: "recent_success" | "rate_limit";
}

function recordTypingOutcome(
  context: TypingContext,
  outcome: "sent" | "skipped" | "failed",
  fields: {
    readonly channelId?: string;
    readonly durationMs?: number;
    readonly reason?: string;
    readonly status?: number;
    readonly retryAfterMs?: number;
    readonly global?: boolean;
  },
): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "discord_typing",
    runId: context.runId,
    durationMs: fields.durationMs ?? 0,
    success: outcome !== "failed",
    dimensions: {
      phase: context.phase,
      outcome,
      ingress_id: context.ingressId,
      ingress_age_ms:
        context.admittedAt === undefined
          ? undefined
          : now() - context.admittedAt,
      channel_id: fields.channelId,
      reason: fields.reason,
      status: fields.status,
      retry_after_ms: fields.retryAfterMs,
      global: fields.global,
    },
  });
}

/**
 * Process-local suppression for repeated sends and Discord `retry_after`, and
 * typing-only reuse of permission reads. Entries expire at their deadline and
 * each table has a hard capacity; another API instance may still send once,
 * which the Runner cadence bounds.
 */
const typingHoldTable = singleton(() => {
  return new Map<string, TypingHold>();
});
const typingAccessTable = singleton(() => {
  return new Map<string, ExpiringEntry>();
});
const typingInFlight = singleton(() => {
  return new Set<string>();
});
/** Kept outside the bounded tables so eviction can never drop it. */
const globalTypingHold = singleton(() => {
  return { until: 0 };
});

function liveEntry<T extends ExpiringEntry>(
  table: Map<string, T>,
  key: string,
): T | undefined {
  const entry = table.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.until > now()) {
    return entry;
  }
  table.delete(key);
  return undefined;
}

function typingHeld(channelId: string, context: TypingContext): boolean {
  const global = globalTypingHold();
  if (global.until <= now()) {
    global.until = 0;
  }
  const hold = liveEntry(typingHoldTable(), channelId);
  const reason =
    global.until > 0
      ? "global_rate_limit"
      : typingInFlight().has(channelId)
        ? "in_flight"
        : hold?.reason;
  if (!reason) {
    return false;
  }
  recordTypingOutcome(context, "skipped", {
    channelId,
    reason,
  });
  return true;
}

function setBoundedEntry<T extends ExpiringEntry>(
  table: Map<string, T>,
  key: string,
  entry: T,
): void {
  if ((table.get(key)?.until ?? 0) >= entry.until) {
    return;
  }
  table.delete(key);
  if (table.size >= MAX_TYPING_ENTRIES) {
    const current = now();
    for (const [heldKey, held] of table) {
      if (held.until <= current) {
        table.delete(heldKey);
      }
    }
    const oldest = table.keys().next();
    if (table.size >= MAX_TYPING_ENTRIES && !oldest.done) {
      table.delete(oldest.value);
    }
  }
  table.set(key, entry);
}

function holdTyping(
  channelId: string,
  durationMs: number,
  reason: TypingHold["reason"],
): void {
  setBoundedEntry(typingHoldTable(), channelId, {
    until: now() + durationMs,
    reason,
  });
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
  context: TypingContext,
  signal: AbortSignal,
): Promise<void> {
  // Check and claim synchronously so concurrent callers send at most once.
  if (typingHeld(args.channelId, context)) {
    return;
  }
  const inFlight = typingInFlight();
  if (inFlight.size >= MAX_TYPING_ENTRIES) {
    recordTypingOutcome(context, "skipped", {
      channelId: args.channelId,
      reason: "in_flight_capacity",
    });
    return;
  }
  inFlight.add(args.channelId);
  const startedAt = now();
  const result = await onRejection(
    discordClient.sendDiscordTyping(
      { botToken: args.botToken, channelId: args.channelId },
      signal,
    ),
    () => {
      inFlight.delete(args.channelId);
    },
  );
  // A failed request releases concurrency ownership without a success hold.
  inFlight.delete(args.channelId);
  const durationMs = now() - startedAt;
  if (result.kind === "ok") {
    holdTyping(args.channelId, TYPING_REPEAT_HOLD_MS, "recent_success");
    recordTypingOutcome(context, "sent", {
      channelId: args.channelId,
      durationMs,
    });
    return;
  }
  if (result.kind === "discord-error" && result.retryAfterMs !== undefined) {
    if (result.global) {
      holdAllTyping(result.retryAfterMs);
    } else {
      holdTyping(args.channelId, result.retryAfterMs, "rate_limit");
    }
  }
  if (result.kind === "unavailable" && args.accessKey !== undefined) {
    typingAccessTable().delete(args.accessKey);
  }
  recordTypingOutcome(context, "failed", {
    channelId: args.channelId,
    durationMs,
    status: result.status,
    ...(result.kind === "discord-error"
      ? { retryAfterMs: result.retryAfterMs, global: result.global }
      : {}),
  });
  L.warn("Discord typing indicator was not sent", {
    ...context,
    channelId: args.channelId,
    duration_ms: durationMs,
    status: result.status,
  });
}

function scheduleTyping(
  work: Promise<void>,
  context: TypingContext,
  channelId: string,
): void {
  const startedAt = now();
  // Status is cosmetic: it must never delay or fail admission or delivery.
  waitUntil(
    tapError(work, (error) => {
      recordTypingOutcome(context, "failed", {
        channelId,
        durationMs: now() - startedAt,
        reason: "refresh_failed",
      });
      L.warn("Failed to refresh Discord typing indicator", {
        ...context,
        channelId,
        duration_ms: now() - startedAt,
        error,
      });
    }),
  );
}

/** Admission has just fenced write access to the destination with this token. */
export function scheduleDiscordAdmissionTyping(args: {
  readonly botToken: string;
  readonly channelId: string;
  readonly ingressId: string;
  readonly admittedAt: Date;
}): void {
  const backgroundSignal = new AbortController().signal;
  const context = {
    phase: "admission",
    ingressId: args.ingressId,
    admittedAt: args.admittedAt.getTime(),
  } as const;
  scheduleTyping(
    sendTypingOnce(args, context, backgroundSignal),
    context,
    args.channelId,
  );
}

/** Returns null when access is gone; throws when the failure is transient. */
function typingAccessDenied(
  response: DiscordFailureResponse,
  fields: {
    readonly runId: string;
    readonly channelId: string;
    readonly reason: "binding_unavailable" | "provider_access_unavailable";
  },
): null {
  const retryAfterSeconds = response.body.error.retryAfterSeconds;
  if (response.status === 429) {
    holdAllTyping((retryAfterSeconds ?? 1) * 1000);
  }
  if (response.status === 403 || response.status === 404) {
    recordTypingOutcome({ phase: "refresh", runId: fields.runId }, "skipped", {
      channelId: fields.channelId,
      reason: fields.reason,
      status: response.status,
    });
    return null;
  }
  throw new Error(`Discord typing access check failed: ${response.status}`);
}

/**
 * The route, feature, binding and membership checks run on every refresh.
 * Discord permission reads are reused for typing only, within a short window.
 */
const currentTypingAccess$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly target: DiscordDeliveryTarget;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly botToken: string;
    readonly accessKey: string;
    readonly channelId: string;
  } | null> => {
    const db = get(db$);
    const route = await (async () => {
      const plan = discordChatRouteReadPlan(args);
      const [route] = await db
        .select(plan.columns)
        .from(discordChatThreadRoutes)
        .where(plan.condition)
        .limit(plan.limit);
      return route;
    })();
    signal.throwIfAborted();
    if (!route) {
      recordTypingOutcome({ phase: "refresh", runId: args.runId }, "skipped", {
        reason: "route_unavailable",
      });
      return null;
    }
    const channelId = route.destinationChannelId ?? route.channelId;
    // Before the first reply creates a native thread, the callback target is
    // its future thread ID. Admission already typed in the actual source.
    if (typingHeld(channelId, { phase: "refresh", runId: args.runId })) {
      return null;
    }
    const current = await set(
      requireDiscordBinding$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: args.target.guildId ?? undefined,
      },
      signal,
    );
    signal.throwIfAborted();
    if (current.kind === "denied") {
      return typingAccessDenied(current.response, {
        runId: args.runId,
        channelId,
        reason: "binding_unavailable",
      });
    }
    if (
      current.binding.connectionId !== args.target.connectionId ||
      current.binding.discordUserId !== args.target.discordUserId
    ) {
      recordTypingOutcome({ phase: "refresh", runId: args.runId }, "skipped", {
        channelId,
        reason: "binding_changed",
      });
      return null;
    }
    const accessKey = [
      current.binding.connectionId,
      current.binding.discordUserId,
      args.target.guildId,
      channelId,
    ].join(":");
    if (liveEntry(typingAccessTable(), accessKey)) {
      return { botToken: current.botToken, accessKey, channelId };
    }
    const access = await resolveDiscordProviderAccess(
      {
        ...current.binding,
        botToken: current.botToken,
        channelId,
        mode: "write",
      },
      signal,
    );
    signal.throwIfAborted();
    if (access.kind === "denied") {
      return typingAccessDenied(access.response, {
        runId: args.runId,
        channelId,
        reason: "provider_access_unavailable",
      });
    }
    setBoundedEntry(typingAccessTable(), accessKey, {
      until: now() + TYPING_ACCESS_REUSE_MS,
    });
    return { botToken: current.botToken, accessKey, channelId };
  },
);

const refreshDiscordRunTyping$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly chatThreadId: string;
      readonly target: DiscordDeliveryTarget;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const context = { phase: "refresh", runId: args.runId } as const;
    if (typingHeld(args.target.channelId, context)) {
      return;
    }
    const run = await (async () => {
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
    })();
    signal.throwIfAborted();
    if (!run) {
      recordTypingOutcome(context, "skipped", {
        reason: "inactive_run",
      });
      return;
    }
    const access = await set(
      currentTypingAccess$,
      { ...args, orgId: run.orgId, userId: run.userId },
      signal,
    );
    if (!access) {
      return;
    }
    // Provider checks take time; a reply may have been delivered meanwhile.
    const stillActive = await (async () => {
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
    })();
    signal.throwIfAborted();
    if (!stillActive) {
      recordTypingOutcome(context, "skipped", {
        reason: "inactive_run",
      });
      return;
    }
    await sendTypingOnce(
      {
        botToken: access.botToken,
        channelId: access.channelId,
        accessKey: access.accessKey,
      },
      context,
      signal,
    );
  },
);

/**
 * Detached typing for a Discord-triggered run that is still active. Every
 * attempt revalidates the route, binding and feature; destination permission
 * reads are reused for typing within {@link TYPING_ACCESS_REUSE_MS}.
 */
export const scheduleDiscordRunTyping$ = command(
  (
    { set },
    args: {
      readonly runId: string;
      readonly chatThreadId: string;
      readonly target: DiscordDeliveryTarget;
    },
  ): void => {
    const backgroundSignal = new AbortController().signal;
    scheduleTyping(
      set(refreshDiscordRunTyping$, args, backgroundSignal),
      { phase: "refresh", runId: args.runId },
      args.target.channelId,
    );
  },
);
