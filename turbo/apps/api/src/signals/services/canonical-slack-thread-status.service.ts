import { command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { db$, writeDb$ } from "../external/db";
import { createSlackClient } from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { chatEventTypeIn } from "./chat-event-type.service";

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
const ACTIVE_INGRESS_STATUSES = ["pending", "processing"] as const;
const slackQueueEventRevoker = alias(chatEvents, "slack_queue_event_revoker");

const slackStatusIngressPayloadSchema = z.object({
  event: z.object({
    ts: z.string(),
    thread_ts: z.string().optional(),
  }),
});

export interface CanonicalSlackThreadStatusTarget {
  readonly chatThreadId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly routeThreadTs?: string;
}

interface CanonicalSlackThreadStatusBinding {
  readonly encryptedBotToken: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

const loadCanonicalSlackThreadStatusBinding$ = command(
  async (
    { get },
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ): Promise<CanonicalSlackThreadStatusBinding | undefined> => {
    const db = get(db$);
    const [binding] = await db
      .select({
        encryptedBotToken: slackOrgInstallations.encryptedBotToken,
        orgId: slackOrgInstallations.orgId,
        userId: slackChatThreadRoutes.userId,
        workspaceId: slackOrgConnections.slackWorkspaceId,
      })
      .from(slackChatThreadRoutes)
      .innerJoin(
        slackOrgConnections,
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
      )
      .innerJoin(
        slackOrgInstallations,
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackChatThreadRoutes.chatThreadId, target.chatThreadId),
          eq(slackChatThreadRoutes.channelId, target.channelId),
          eq(
            slackChatThreadRoutes.threadTs,
            target.routeThreadTs ?? target.threadTs,
          ),
          eq(slackOrgConnections.userId, slackChatThreadRoutes.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!binding?.orgId) {
      return undefined;
    }
    return { ...binding, orgId: binding.orgId };
  },
);

function slackPhysicalThreadTs(payload: string): string {
  const parsed = slackStatusIngressPayloadSchema.parse(
    JSON.parse(payload) as unknown,
  );
  return parsed.event.thread_ts ?? parsed.event.ts;
}

// One statement sees ingress, queue and run handoffs in the same snapshot,
// including both main-DM and explicit routes into the physical Slack thread.
const canonicalSlackThreadHasOutstandingWork$ = command(
  async (
    { set },
    target: CanonicalSlackThreadStatusTarget,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const physicalThread = sql`coalesce(${slackChatIngress.payload}::jsonb -> 'event' ->> 'thread_ts', ${slackChatIngress.payload}::jsonb -> 'event' ->> 'ts') = ${target.threadTs}`;
    const activeIngress = db
      .select({ id: slackChatIngress.id })
      .from(slackChatIngress)
      .where(
        and(
          eq(slackChatIngress.routeId, slackChatThreadRoutes.id),
          inArray(slackChatIngress.status, ACTIVE_INGRESS_STATUSES),
          physicalThread,
        ),
      );
    const queuedSlackMessages = db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .innerJoin(slackChatIngress, eq(slackChatIngress.id, chatEvents.id))
      .where(
        and(
          eq(chatEvents.chatThreadId, slackChatThreadRoutes.chatThreadId),
          chatEventTypeIn(["input.prompt"]),
          eq(chatEvents.contextType, "slack"),
          isNull(chatEvents.runId),
          physicalThread,
          notExists(
            db
              .select({ id: slackQueueEventRevoker.id })
              .from(slackQueueEventRevoker)
              .where(eq(slackQueueEventRevoker.revokesEventId, chatEvents.id)),
          ),
        ),
      );
    const activeRuns = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          chatEventTypeIn(["input.prompt"]),
        ),
      )
      .innerJoin(
        slackChatIngress,
        eq(slackChatIngress.id, chatEvents.revokesEventId),
      )
      .where(
        and(
          eq(agentRuns.chatThreadId, slackChatThreadRoutes.chatThreadId),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
          eq(agentRuns.triggerSource, "slack"),
          physicalThread,
        ),
      );
    const [work] = await db
      .select({ id: slackChatThreadRoutes.id })
      .from(slackChatThreadRoutes)
      .innerJoin(
        slackOrgConnections,
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
      )
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, workspaceId),
          eq(slackChatThreadRoutes.channelId, target.channelId),
          or(
            eq(slackChatThreadRoutes.threadTs, target.threadTs),
            eq(slackChatThreadRoutes.threadTs, INTEGRATION_DM_SESSION_KEY),
          ),
          or(
            exists(activeIngress),
            exists(queuedSlackMessages),
            exists(activeRuns),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return work !== undefined;
  },
);

export const canonicalSlackThreadStatusTargetForIngress$ = command(
  async (
    { get },
    ingressId: string,
    signal: AbortSignal,
  ): Promise<CanonicalSlackThreadStatusTarget | undefined> => {
    const db = get(db$);
    const [target] = await db
      .select({
        chatThreadId: slackChatThreadRoutes.chatThreadId,
        channelId: slackChatThreadRoutes.channelId,
        routeThreadTs: slackChatThreadRoutes.threadTs,
        payload: slackChatIngress.payload,
      })
      .from(slackChatIngress)
      .innerJoin(
        slackChatThreadRoutes,
        eq(slackChatThreadRoutes.id, slackChatIngress.routeId),
      )
      .where(eq(slackChatIngress.id, ingressId))
      .limit(1);
    signal.throwIfAborted();
    if (!target) {
      return undefined;
    }
    const threadTs = slackPhysicalThreadTs(target.payload);
    return {
      chatThreadId: target.chatThreadId,
      channelId: target.channelId,
      threadTs,
      ...(threadTs === target.routeThreadTs
        ? {}
        : { routeThreadTs: target.routeThreadTs }),
    };
  },
);

const syncCanonicalSlackThreadStatus$ = command(
  async (
    { set },
    target: CanonicalSlackThreadStatusTarget,
    mode: "always" | "if_idle",
    signal: AbortSignal,
  ): Promise<"active" | "processing" | undefined> => {
    const binding = await set(
      loadCanonicalSlackThreadStatusBinding$,
      target,
      signal,
    );
    signal.throwIfAborted();
    if (!binding) {
      return undefined;
    }
    if (
      mode === "if_idle" &&
      (await set(
        canonicalSlackThreadHasOutstandingWork$,
        target,
        binding.workspaceId,
        signal,
      ))
    ) {
      signal.throwIfAborted();
      return "processing";
    }
    signal.throwIfAborted();
    const featureContext = await set(
      loadUserFeatureSwitchContext$,
      binding.orgId,
      binding.userId,
      signal,
    );
    signal.throwIfAborted();
    const botToken = await decryptPersistentSecretValue(
      binding.encryptedBotToken,
      featureContext,
    );
    signal.throwIfAborted();
    const client = createSlackClient(botToken);
    // A delayed progress callback or Stop retry must not revive stopped work.
    let appliedStatus = (await set(
      canonicalSlackThreadHasOutstandingWork$,
      target,
      binding.workspaceId,
      signal,
    ))
      ? "is thinking..."
      : "";
    signal.throwIfAborted();
    while (true) {
      await client.setThreadStatus(
        target.channelId,
        target.threadTs,
        appliedStatus,
      );
      signal.throwIfAborted();

      // Work can start while a Slack status request is in flight. Reconcile
      // until the persisted lifecycle agrees with the last status we applied;
      // later lifecycle transitions schedule their own reconciliation.
      const desiredStatus = (await set(
        canonicalSlackThreadHasOutstandingWork$,
        target,
        binding.workspaceId,
        signal,
      ))
        ? "is thinking..."
        : "";
      signal.throwIfAborted();
      if (desiredStatus === appliedStatus) {
        return appliedStatus === "" ? "active" : "processing";
      }
      appliedStatus = desiredStatus;
    }
  },
);

export const reconcileCanonicalSlackThreadStatus$ = command(
  async (
    { set },
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ) => {
    return await set(syncCanonicalSlackThreadStatus$, target, "always", signal);
  },
);

export const clearCanonicalSlackThreadStatusIfIdle$ = command(
  async (
    { set },
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ): Promise<boolean> => {
    return (
      (await set(
        syncCanonicalSlackThreadStatus$,
        target,
        "if_idle",
        signal,
      )) === "active"
    );
  },
);
