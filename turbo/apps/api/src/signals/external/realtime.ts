import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { HTTPException } from "hono/http-exception";
import Ably, { type CapabilityOp } from "ably";
import type { RunnerSshInvalidate } from "@okouai/api-contracts/contracts/runner-ssh";
import type { RunnerVncInvalidate } from "@okouai/api-contracts/contracts/runner-vnc";
import {
  foregroundChannelName,
  mailDraftChangedEvent,
  sessionOutputChannelName,
  computerUseHostChannelScope,
  computerUseHostChannelName,
  computerUseCommandsChangedEvent,
  computerUseCommandResultChannelName,
  computerUseCommandResultChangedEvent,
  type RealtimeSubscription,
  type BrowserSessionChangedPayload,
  type SessionOutputDelta,
  type UserPreferenceChangedPayload,
} from "@okouai/api-contracts/contracts/realtime";
import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";
import {
  phoneUseChannel,
  phoneUseResultChannel,
  phoneUseResultChangedEvent,
  phoneUseDevicesChangedEvent,
} from "@okouai/api-contracts/contracts/phone-use";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { waitUntil } from "../context/wait-until";
import {
  awaitWithSignal,
  bestEffort,
  settle,
  settleIncludingAbort,
  tapError,
} from "../utils";

const L = logger("Realtime");

const ablyClient = singleton((): Ably.Rest => {
  const client = new Ably.Rest({ key: env("ABLY_API_KEY"), queryTime: true });
  L.debug("Ably client initialised");
  return client;
});

export async function isUserInForeground(
  userId: string,
  orgId: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const channel = ablyClient().channels.get(
    foregroundChannelName(userId, orgId),
  );
  const members = await channel.presence.get({ clientId: userId, limit: 1 });
  signal.throwIfAborted();
  return members.items.length > 0;
}

/** Presence is scoped to one registered Desktop connection, never a user-wide socket. */
export async function computerUseHostIsPresent(
  target: {
    readonly userId: string;
    readonly orgId: string;
    readonly id: string;
    readonly connectionGeneration: number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const started = performance.now();
  const request = async () => {
    const members = await ablyClient()
      .channels.get(
        computerUseHostChannelName(
          target.userId,
          target.orgId,
          target.id,
          target.connectionGeneration,
        ),
      )
      .presence.get({ clientId: target.userId, limit: 1 });
    const present = members.items.length > 0;
    L.debug("Computer-use presence queried", {
      hostId: target.id,
      connectionGeneration: target.connectionGeneration,
      outcome: "ok",
      present,
      durationMs: performance.now() - started,
    });
    return present;
  };
  const result = await settleIncludingAbort(
    awaitWithSignal(
      request(),
      AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    ),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    L.warn("Computer-use presence unavailable", {
      hostId: target.id,
      connectionGeneration: target.connectionGeneration,
      outcome: "unavailable",
      durationMs: performance.now() - started,
    });
    throw new HTTPException(503, {
      res: Response.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Computer-use presence is temporarily unavailable",
          },
        },
        { status: 503 },
      ),
      cause: result.error,
    });
  }
  return result.value;
}

export async function createComputerUseHostRealtimeToken(
  target: {
    readonly userId: string;
    readonly orgId: string;
    readonly hostId: string;
    readonly connectionGeneration: number;
  },
  signal: AbortSignal,
): Promise<Ably.TokenRequest> {
  signal.throwIfAborted();
  const channelName = computerUseHostChannelName(
    target.userId,
    target.orgId,
    target.hostId,
    target.connectionGeneration,
  );
  const token = await ablyClient().auth.createTokenRequest({
    capability: { [channelName]: ["subscribe", "presence"] },
    ttl: 60 * 60 * 1000,
    clientId: target.userId,
  });
  signal.throwIfAborted();
  return token;
}

function getUserChannelName(userId: string): string {
  return `user:${userId}`;
}

function getOrgChannelName(orgId: string): string {
  return `org:${orgId}`;
}

function getUserOrgChannelName(userId: string, orgId: string): string {
  return `user-org:${userId}:${orgId}`;
}

function getBuiltInGenerationEventName(generationId: string): string {
  return `built-in-generation:${generationId}`;
}

async function createPlatformUserRealtimeToken(
  userId: string,
): Promise<Ably.TokenRequest> {
  const channelName = getUserChannelName(userId);
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [channelName]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
    clientId: userId,
  });
  L.debug(`Generated platform realtime token for user:${userId}`);
  return tokenRequest;
}

/** OAuth chat readers cannot subscribe to global user, organization or remote-control signals. */
export async function createOAuthChatRealtimeToken(
  userId: string,
  orgId: string,
  expiresAtMs: number,
  signal: AbortSignal,
): Promise<Ably.TokenRequest | null> {
  signal.throwIfAborted();
  const timestamp = now();
  // Ably can redeem the signed request up to two minutes after its timestamp.
  // TTL starts at redemption, so reserve that entire window before signing.
  const ttl = Math.min(60 * 60 * 1000, expiresAtMs - timestamp - 120_000);
  if (ttl <= 0) {
    return null;
  }
  const token = await ablyClient().auth.createTokenRequest({
    capability: {
      [getUserOrgChannelName(userId, orgId)]: ["subscribe"],
      [sessionOutputChannelName(userId, orgId, "*")]: ["subscribe"],
    },
    timestamp,
    ttl,
    clientId: userId,
  });
  signal.throwIfAborted();
  return now() >= expiresAtMs ? null : token;
}

export async function createPlatformRealtimeToken(
  userId: string,
  orgId: string | undefined,
  signal: AbortSignal,
): Promise<Ably.TokenRequest> {
  signal.throwIfAborted();
  const capability: Record<string, CapabilityOp[]> = {
    [getUserChannelName(userId)]: ["subscribe"],
  };
  if (orgId !== undefined) {
    capability[foregroundChannelName(userId, orgId)] = ["presence"];
    capability[getOrgChannelName(orgId)] = ["subscribe"];
    capability[getUserOrgChannelName(userId, orgId)] = ["subscribe"];
    capability[sessionOutputChannelName(userId, orgId, "*")] = ["subscribe"];
    capability[`phone-use:${orgId}:${userId}:*`] = ["subscribe"];
    capability[`${computerUseHostChannelScope(userId, orgId)}:*`] = [
      "subscribe",
    ];
  }
  const tokenParams = {
    capability,
    ttl: 60 * 60 * 1000,
    clientId: userId,
  };
  const scope = `user:${userId}${orgId === undefined ? "" : `/org:${orgId}`}`;
  const tokenRequest = await ablyClient().auth.createTokenRequest(tokenParams);
  signal.throwIfAborted();
  L.debug(`Generated platform realtime token request for ${scope}`);
  return tokenRequest;
}

/** Wake one registered connection; HTTP remains authoritative for claiming. */
async function publishComputerUseCommandsChangedNow(
  channelName: string,
): Promise<void> {
  const channel = ablyClient().channels.get(channelName);
  const first = await settle(
    channel.publish(computerUseCommandsChangedEvent, null),
  );
  if (!first.ok) {
    // Repeating a wakeup is safe: only the HTTP queue claim can admit an action.
    await ablyClient()
      .channels.get(channelName)
      .publish(computerUseCommandsChangedEvent, null);
  }
}

export function publishComputerUseCommandsChanged(target: {
  readonly userId: string;
  readonly orgId: string;
  readonly hostId: string;
  readonly connectionGeneration: number;
}): Promise<void> {
  return publishComputerUseCommandsChangedNow(
    computerUseHostChannelName(
      target.userId,
      target.orgId,
      target.hostId,
      target.connectionGeneration,
    ),
  );
}

export function publishComputerUseCommandsChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
  readonly hostId: string;
  readonly connectionGeneration: number;
}): void {
  const channelName = computerUseHostChannelName(
    target.userId,
    target.orgId,
    target.hostId,
    target.connectionGeneration,
  );
  waitUntil(
    tapError(publishComputerUseCommandsChangedNow(channelName), (error) => {
      L.warn("Unable to publish computer-use command wakeup", {
        error,
        channelName,
      });
    }),
  );
}

export async function createBuiltInGenerationRealtimeSubscription(
  userId: string,
  generationId: string,
): Promise<BuiltInGenerationRealtimeSubscription> {
  return {
    channelName: getUserChannelName(userId),
    eventName: getBuiltInGenerationEventName(generationId),
    tokenRequest: await createPlatformUserRealtimeToken(userId),
  };
}

export function createComputerUseResultSubscription(
  target: {
    readonly userId: string;
    readonly orgId: string;
    readonly commandId: string;
    readonly timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<RealtimeSubscription | undefined> {
  signal.throwIfAborted();
  const channelName = computerUseCommandResultChannelName(
    target.userId,
    target.orgId,
    target.commandId,
  );
  return createResultSubscription(
    channelName,
    computerUseCommandResultChangedEvent,
    target.userId,
    target.timeoutMs,
    signal,
  );
}

async function createResultSubscription(
  channelName: string,
  eventName: string,
  userId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RealtimeSubscription | undefined> {
  const request = (async () => {
    return await ablyClient().auth.createTokenRequest({
      capability: { [channelName]: ["subscribe"] },
      clientId: userId,
      ttl: timeoutMs + 60_000,
    });
  })();
  const token = await settle(awaitWithSignal(request, signal), signal);
  if (!token.ok) {
    // #38733: notification delivery is optional; the created operation remains readable.
    L.warn("Unable to issue result subscription", {
      channelName,
    });
    return undefined;
  }
  return {
    channelName,
    eventName,
    tokenRequest: token.value,
  };
}

async function publishComputerUseResultChangedNow(
  channelName: string,
): Promise<void> {
  await ablyClient()
    .channels.get(channelName)
    .publish(computerUseCommandResultChangedEvent, null);
}

export function publishComputerUseResultChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
  readonly id: string;
}): void {
  const channelName = computerUseCommandResultChannelName(
    target.userId,
    target.orgId,
    target.id,
  );
  waitUntil(
    tapError(publishComputerUseResultChangedNow(channelName), (error) => {
      L.warn("Unable to publish computer-use result change", {
        error,
        channelName,
      });
    }),
  );
}

export async function createRunnerGroupRealtimeToken(
  group: string,
): Promise<Ably.TokenRequest> {
  const tokenRequest = await ablyClient().auth.createTokenRequest({
    capability: {
      [`runner-group:${group}`]: ["subscribe"],
    },
    ttl: 60 * 60 * 1000,
  });
  L.debug(`Generated runner group realtime token for ${group}`);
  return tokenRequest;
}

async function publishUserSignalNow(
  userIds: readonly string[],
  topic: string,
  payload: unknown,
): Promise<void> {
  const client = ablyClient();
  await Promise.all(
    userIds.map(async (userId) => {
      const channel = client.channels.get(getUserChannelName(userId));
      await channel.publish(topic, payload);
    }),
  );
  L.debug(`Published "${topic}" to ${userIds.length} user(s)`);
}

async function publishChatDatabaseSignalNow(
  target: { readonly userId: string; readonly orgId: string },
  topic: string,
  payload: unknown,
): Promise<void> {
  const channelName = getUserOrgChannelName(target.userId, target.orgId);
  const client = ablyClient();
  await client.channels.get(channelName).publish(topic, payload);
  L.debug(`Published "${topic}" to ${channelName}`);
}

export async function publishSessionOutputDelta(
  target: { readonly userId: string; readonly orgId: string },
  delta: SessionOutputDelta,
): Promise<void> {
  const channelName = sessionOutputChannelName(
    target.userId,
    target.orgId,
    delta.runId,
  );
  await ablyClient().channels.get(channelName).publish(delta.runId, delta);
}

function publishChatDatabaseSignal(
  target: { readonly userId: string; readonly orgId: string },
  topic: string,
  payload: unknown = null,
): Promise<void> {
  waitUntil(bestEffort(publishChatDatabaseSignalNow(target, topic, payload)));
  return Promise.resolve();
}

export function publishMailDraftChangedSafely(
  target: { readonly userId: string; readonly orgId: string },
  mailDraftId: string,
): Promise<void> {
  return publishChatDatabaseSignal(target, mailDraftChangedEvent(mailDraftId));
}

export function publishAgentSuggestionsChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  return publishChatDatabaseSignal(target, "agentSuggestionsChanged");
}

export function publishRemoteDevicesChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  return publishChatDatabaseSignal(target, "remoteDevicesChanged");
}

/**
 * Schedule a per-user invalidation/notification signal.
 *
 * Platform clients subscribe via the existing /api/realtime/token
 * endpoint and receive events published by the API backend. Ably delivery is
 * best-effort: callers only wait for the background work to be registered, so
 * a delayed or rejected publish cannot fail the business operation.
 */
export function publishUserSignal(
  userIds: readonly string[],
  topic: string,
  payload: unknown = null,
): Promise<void> {
  waitUntil(bestEffort(publishUserSignalNow(userIds, topic, payload)));
  return Promise.resolve();
}

export async function publishUserPreferenceChangedForUserSafely(
  userId: string,
  kinds: UserPreferenceChangedPayload["kinds"],
): Promise<void> {
  await publishUserSignal([userId], "userPreferenceChanged", {
    kinds,
  } satisfies UserPreferenceChangedPayload);
}

/** Account notices contain no account identity or credentials. */
export function publishPersonalModelProvidersChangedSafely(
  userId: string,
): Promise<void> {
  return publishUserSignal([userId], "runModelsChanged");
}

/** The onboarding ready step re-reads its recommendation job on this notice. */
export function publishOnboardingRecommendationChangedSafely(
  userId: string,
): Promise<void> {
  return publishUserSignal([userId], "onboardingRecommendationChanged");
}

/** Invalidate the aggregate Run capacity view after a committed state change. */
export function publishRunQueueChangedForOrgSafely(
  orgId: string,
): Promise<void> {
  waitUntil(bestEffort(publishOrgSignal(orgId, "runQueueChanged")));
  return Promise.resolve();
}

/**
 * Fire the per-user-org "thread list shape changed" signal. The App consumes
 * this topic to catch up its local thread-event view and reload derived thread
 * state. The payload is intentionally empty because the server is authoritative.
 */
export async function publishThreadListChanged(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await publishChatDatabaseSignal(target, "threadListChanged");
}

export async function publishThreadListChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await publishThreadListChanged(target);
}

/**
 * Fire the per-user-org signal that an input of `GET /api/indicators` changed:
 * a Run became pending, a Run terminal marker committed, or a thread was muted,
 * unmuted, hidden or deleted. Read-cursor changes use
 * `chatThreadReadCursorUpdated`.
 * The App refreshes indicators only on these two topics, so Run output
 * does not refetch them. Publish only after the change commits; the payload is
 * empty because the server is authoritative.
 */
export async function publishChatIndicatorsChangedSafely(target: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await publishChatDatabaseSignal(target, "chatIndicatorsChanged");
}

interface ChatThreadReadCursorUpdatedPayload {
  readonly threadId: string;
  readonly lastReadAt: string | null;
}

/**
 * Notify every tab for one user-org that authoritative chat read state changed.
 * Tabs consume the payload to refresh their indicator snapshots and clear
 * matching optimistic read marks.
 */
export async function publishChatThreadReadCursorUpdatedSafely(
  target: { readonly userId: string; readonly orgId: string },
  payload: ChatThreadReadCursorUpdatedPayload,
): Promise<void> {
  await publishChatDatabaseSignal(
    target,
    "chatThreadReadCursorUpdated",
    payload,
  );
}

/**
 * Notify the owner that a runner published a reusable presentation template.
 * The catalog is server-owned, so every open client re-fetches it instead of
 * trying to reconstruct the new entry from the notification payload.
 */
export async function publishPresentationTemplatesChangedForUserSafely(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "presentationTemplatesChanged");
}

export function publishPresentationTemplatesChangedForOrgSafely(
  orgId: string,
): Promise<void> {
  waitUntil(
    bestEffort(publishOrgSignal(orgId, "presentationTemplatesChanged")),
  );
  return Promise.resolve();
}

/** Re-read shell approval eligibility after a committed thread/run change. */
export async function publishDesktopShellAuthorizationChangedSafely(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "desktopShellAuthorizationChanged");
}

/**
 * Notify an open chat thread that server-owned detail fields changed without a
 * request from that client. The client re-fetches the authoritative detail.
 */
export async function publishChatThreadDetailChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadDetailChanged:${threadId}`);
}

/**
 * Notify the chat message background sync that a new row was appended. It
 * refreshes IndexedDB and forwards newly fetched rows into visible threads, so
 * derived UI state (e.g. rendered chat messages) updates live.
 *
 * `syncThroughSeqId` is an optional watermark for the last row appended by the
 * publishing mutation. Clients that have already cached that sequence can
 * skip a delayed duplicate notification. Omit it when the batch boundary is
 * not known; payload-less events retain the unconditional catch-up behavior.
 *
 * Best-effort: a failed publish must not fail the mutation that triggered it.
 */
export async function publishChatThreadMessageCreatedSafely(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly syncThroughSeqId?: number;
}): Promise<void> {
  await publishChatDatabaseSignal(
    args,
    `chatThreadMessageCreated:${args.threadId}`,
    args.syncThroughSeqId === undefined
      ? null
      : { syncThroughSeqId: args.syncThroughSeqId },
  );
}

/**
 * Notify a chat thread's UI that its linked automation set changed (created,
 * deleted, enabled, or disabled). The chat-thread header automation menu
 * subscribes to this topic and refetches its thread-scoped list.
 *
 * Best-effort: a failed publish must not fail the automation mutation that
 * triggers it. Payload is intentionally empty — the client re-fetches the
 * authoritative list on any delivery.
 */
export async function publishChatThreadAutomationsChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadAutomationsChanged:${threadId}`);
}

/**
 * Notify the user's chat threads that their connector permission grants
 * changed (allowed or denied from any client: chat permission card,
 * permission-allow page, or settings dialog). Chat threads subscribe to this
 * topic and invalidate all rendered permission cards at once — grants are few
 * and re-fetching them is cheap, so a single user-level signal beats
 * per-permission topics. Payload is intentionally empty.
 *
 * Best-effort: a failed publish must not fail the grant mutation that
 * triggers it.
 */
export async function publishConnectorPermissionUpdatedSafely(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "connectorPermissionUpdated");
}

/**
 * Notify a chat thread that a Browser user-action request changed. The card
 * re-fetches the persisted request state after this best-effort signal.
 */
export async function publishBrowserUserActionChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `browserUserActionChanged:${threadId}`);
}

/**
 * Notify the user's open chat surfaces that one managed browser changed
 * lifecycle state. The thread-scoped payload lets each card registry reload
 * only the matching shared signals.
 *
 * Best-effort: a failed publish must not fail browser resume or reclamation.
 */
export async function publishBrowserSessionChangedSafely(
  userId: string,
  browser: {
    readonly threadId: string;
    readonly operationId?: string;
  },
): Promise<void> {
  const payload: BrowserSessionChangedPayload = browser;
  await publishUserSignal([userId], "browserSessionChanged", payload);
}

/**
 * Notify a chat thread's UI that its visible workflow set changed. The slash
 * workflow composer subscribes to this topic and refetches the authoritative
 * agent-scoped workflow list.
 *
 * Best-effort: a failed publish must not fail the workflow mutation that
 * triggers it.
 */
export async function publishChatThreadWorkflowsChangedSafely(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadWorkflowsChanged:${threadId}`);
}

export async function publishBuiltInGenerationChanged(
  userId: string,
  generationId: string,
  payload: unknown,
): Promise<void> {
  await publishUserSignal(
    [userId],
    getBuiltInGenerationEventName(generationId),
    payload,
  );
}

/** Bound the provider operation itself; the durable job owns retries and cancellation. */
const rewardProjectionClient = singleton(() => {
  return new Ably.Rest({
    key: env("ABLY_API_KEY"),
    queryTime: false,
    httpRequestTimeout: 5000,
    httpMaxRetryCount: 0,
  });
});

/** Await provider acceptance so the durable projection job owns retry, not waitUntil. */
export async function publishMarketingRewardProjection(
  target: {
    readonly actorUserId: string;
    readonly beneficiaryUserId: string | null;
    readonly orgId: string;
    readonly rewardTarget: "user" | "org";
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const client = rewardProjectionClient();
  if (target.rewardTarget === "user") {
    if (!target.beneficiaryUserId) {
      throw new Error("Personal reward refresh has no beneficiary");
    }
    await client.channels
      .get(getUserChannelName(target.beneficiaryUserId))
      .publish(GET_STARTED_REWARDS_CHANGED_EVENT, null);
  } else {
    const published = await Promise.allSettled([
      client.channels
        .get(getUserChannelName(target.actorUserId))
        .publish(GET_STARTED_REWARDS_CHANGED_EVENT, null),
      client.channels
        .get(getOrgChannelName(target.orgId))
        .publish("slack:changed", null),
    ]);
    for (const result of published) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }
  signal.throwIfAborted();
}

/** Publish an org-scoped signal for events shared by organization members. */
export async function publishOrgSignal(
  orgId: string,
  topic: string,
  payload: unknown = null,
): Promise<void> {
  const client = ablyClient();
  const channel = client.channels.get(getOrgChannelName(orgId));
  await channel.publish(topic, payload);
  L.debug(`Published "${topic}" to org:${orgId}`);
}

/**
 * Notify a runner-group channel that a run should halt. The runner subscribes
 * to its group's channel and applies the requested cancellation mode.
 */
export async function publishCancelToRunnerGroup(
  group: string,
  runId: string,
  mode: RunnerCancellationMode,
): Promise<void> {
  const client = ablyClient();
  const channel = client.channels.get(`runner-group:${group}`);
  await channel.publish("cancel", { runId, mode });
  L.debug(`Published ${mode} cancel ${runId} to runner-group:${group}`);
}

export async function publishConnectorRuntimeSyncBatch(
  group: string,
  messages: Ably.Message[],
): Promise<void> {
  const channel = `runner-group:${group}`;
  const batch = await ablyClient().batchPublish({
    channels: [channel],
    messages,
  });
  const [result] = batch.results;
  if (result && "error" in result) {
    throw result.error;
  }
  if (
    batch.successCount !== 1 ||
    batch.failureCount !== 0 ||
    batch.results.length !== 1 ||
    result?.channel !== channel
  ) {
    throw new Error(
      "Ably did not acknowledge the connector runtime sync batch",
    );
  }
}

export async function publishSshInvalidationToRunnerGroup(
  group: string,
  notification: RunnerSshInvalidate,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("ssh-authority-invalidated", notification);
}

export async function publishVncInvalidationToRunnerGroup(
  group: string,
  notification: RunnerVncInvalidate,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("vnc-authority-invalidated", notification);
}

export async function publishActiveInputToRunnerGroup(
  group: string,
  runId: string,
): Promise<void> {
  const channel = ablyClient().channels.get(`runner-group:${group}`);
  await channel.publish("active-input", { runId });
  L.debug(`Published active input ${runId} to runner-group:${group}`);
}

export async function createPhoneUseToken(
  channel: string,
  userId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const result = await ablyClient().auth.createTokenRequest({
    capability: { [channel]: ["subscribe", "presence"] },
    ttl: 300_000,
    clientId: userId,
  });
  signal.throwIfAborted();
  return result;
}
export async function phoneUseDeviceIsPresent(
  target: {
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
    readonly generation: number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const channel = phoneUseChannel(
    target.orgId,
    target.userId,
    target.id,
    target.generation,
  );
  const result = await settleIncludingAbort(
    awaitWithSignal(
      ablyClient()
        .channels.get(channel)
        .presence.get({ clientId: target.userId, limit: 1 }),
      AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    ),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    throw new HTTPException(503, {
      res: Response.json(
        {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Phone presence is temporarily unavailable",
          },
        },
        { status: 503 },
      ),
      cause: result.error,
    });
  }
  return result.value.items.length > 0;
}
export function publishPhoneUseHint(
  channel: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  waitUntil(
    tapError(
      ablyClient().channels.get(channel).publish("commands.changed", {}),
      (error) => {
        L.warn("Unable to publish phone command change", { channel, error });
      },
    ),
  );
  return Promise.resolve();
}

export function createPhoneUseResultSubscription(
  target: { orgId: string; userId: string; id: string },
  signal: AbortSignal,
) {
  return createResultSubscription(
    phoneUseResultChannel(target.orgId, target.userId, target.id),
    phoneUseResultChangedEvent,
    target.userId,
    300_000,
    signal,
  );
}

export function publishPhoneUseResultChanged(target: {
  orgId: string;
  userId: string;
  id: string;
}): void {
  const channelName = phoneUseResultChannel(
    target.orgId,
    target.userId,
    target.id,
  );
  waitUntil(
    tapError(
      ablyClient()
        .channels.get(channelName)
        .publish(phoneUseResultChangedEvent, null),
      (error) => {
        L.warn("Unable to publish phone result change", { channelName, error });
      },
    ),
  );
}

export function publishPhoneUseDevicesChanged(target: {
  orgId: string;
  userId: string;
}): Promise<void> {
  return publishChatDatabaseSignal(target, phoneUseDevicesChangedEvent);
}
