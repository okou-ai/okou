import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { sendAgentPhoneTypingIndicator } from "../external/agentphone-client";
import { db$, type ReadonlyDb } from "../external/db";
import { internalRunCallbackKindForRecord } from "../services/internal-run-callback";
import { tapError } from "../utils";

const L = logger("event-consumer:agentphone-typing");

interface AgentPhoneTypingTarget {
  readonly conversationId: string;
}

function parseAgentPhoneTypingTarget(
  payload: unknown,
): AgentPhoneTypingTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const data = payload as Record<string, unknown>;
  const conversationId = data.isGroup ? data.groupId : data.conversationId;
  if (
    data.channel !== "imessage" ||
    typeof conversationId !== "string" ||
    conversationId.length === 0
  ) {
    return undefined;
  }
  return { conversationId };
}

function parseCanonicalAgentPhoneTypingTarget(
  payload: unknown,
): AgentPhoneTypingTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return parseAgentPhoneTypingTarget(
    (payload as Record<string, unknown>).agentphoneDelivery,
  );
}

async function agentPhoneTypingTargetsForRun(
  db: ReadonlyDb,
  runId: string,
  signal: AbortSignal,
): Promise<Map<string, AgentPhoneTypingTarget>> {
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
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    );
  signal.throwIfAborted();

  const targets = new Map<string, AgentPhoneTypingTarget>();
  for (const callback of callbacks) {
    const kind = internalRunCallbackKindForRecord(callback);
    const target =
      kind === "chat"
        ? parseCanonicalAgentPhoneTypingTarget(callback.payload)
        : kind === "agentphone:chat"
          ? parseAgentPhoneTypingTarget(callback.payload)
          : undefined;
    if (target) {
      targets.set(target.conversationId, target);
    }
  }
  return targets;
}

export const hasAgentPhoneTypingTargetForRun$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const targets = await agentPhoneTypingTargetsForRun(
      get(db$),
      runId,
      signal,
    );
    return targets.size > 0;
  },
);

export const refreshAgentPhoneTypingForRun$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const targets = await agentPhoneTypingTargetsForRun(
      get(db$),
      runId,
      signal,
    );
    for (const target of targets.values()) {
      await sendAgentPhoneTypingIndicator(
        { conversationId: target.conversationId },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);

export const refreshAgentPhoneTypingEvents$ = command(
  ({ get, set }, signal: AbortSignal): RefreshResponse => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        set(refreshAgentPhoneTypingForRun$, payload.runId, backgroundSignal),
        (error) => {
          L.debug("Failed to refresh AgentPhone typing from events", {
            runId: payload.runId,
            batch: payload.events.length,
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
