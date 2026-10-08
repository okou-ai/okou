import { googleMeetTranscriptGeneratedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { connectors } from "@okouai/db/schema/connector";
import {
  googleWorkspaceEventSubscriptionStates,
  googleWorkspaceProcessedEvents,
} from "@okouai/db/schema/google-workspace-event";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNotNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { executeRawRows, parseRawRows } from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { now, nowDate } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import {
  bestEffort,
  safeJsonParse,
  settle,
  settleIncludingAbort,
  tapError,
} from "../utils";
import { AutomationEventSourceTiming } from "./automation-event-source-timing.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
} from "./builtin-connector-credential-runtime.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { GoogleMeetAutomationSourceChangedError } from "./workflow-google-meet-queue.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import { createConnectorRuntimeAuthSelection } from "./connector-catalog-slug-source.service";

const googleMeetRuntimeAuthSelection$ = createConnectorRuntimeAuthSelection({
  connectorSlugs: ["google-meet"],
});

const GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_MEET_TOKEN";
const GOOGLE_WORKSPACE_EVENTS_API_BASE =
  "https://workspaceevents.googleapis.com/v1";
const GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE =
  "google-meet-transcript-generated";
const GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE =
  "google.workspace.meet.transcript.v2.fileGenerated";
const GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS = 7 * 24 * 60 * 60;
const GOOGLE_WORKSPACE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const workspaceSubscriptionSchema = z
  .object({
    name: z.string(),
    targetResource: z.string().optional(),
    eventTypes: z.array(z.string()).optional(),
    notificationEndpoint: z
      .object({
        pubsubTopic: z.string().optional(),
      })
      .passthrough()
      .optional(),
    state: z.string().optional(),
    expireTime: z.string().optional(),
    ttl: z.string().optional(),
  })
  .passthrough();

const workspaceOperationSchema = z
  .object({
    response: workspaceSubscriptionSchema.optional(),
  })
  .passthrough();

const workspaceSubscriptionsListSchema = z.object({
  subscriptions: z.array(workspaceSubscriptionSchema).optional(),
  nextPageToken: z.string().optional(),
});

const pubSubPushSchema = z.object({
  message: z
    .object({
      data: z.string().optional(),
      messageId: z.string().optional(),
      message_id: z.string().optional(),
      attributes: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  subscription: z.string().optional(),
});

const cloudEventNamedResourceSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const workspaceCloudEventDataSchema = z
  .object({
    subscription: cloudEventNamedResourceSchema
      .extend({
        expire_time: z.string().optional(),
        state: z.string().optional(),
      })
      .optional(),
    transcript: cloudEventNamedResourceSchema.optional(),
    conferenceRecord: cloudEventNamedResourceSchema
      .extend({
        transcript: cloudEventNamedResourceSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

const workspaceCloudEventSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    subject: z.string().optional(),
    type: z.string(),
    time: z.string().optional(),
    specversion: z.string().optional(),
    spec_version: z.string().optional(),
    datacontenttype: z.string().optional(),
    data: workspaceCloudEventDataSchema.optional(),
  })
  .passthrough();

interface GoogleMeetAccess {
  readonly connectorId: string;
  readonly externalId: string | null;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

export interface PendingGoogleMeetSubscriptionDelete {
  readonly accessToken: string;
  readonly orgId: string;
  readonly subscriptionName: string;
  readonly userId: string;
}

type GoogleMeetAccessResult =
  | { readonly kind: "ok"; readonly access: GoogleMeetAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface WorkspaceEventsFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface WorkspaceEventsFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type WorkspaceEventsFetchResult<T> =
  | WorkspaceEventsFetchOk<T>
  | WorkspaceEventsFetchError;

type GoogleWorkspaceSubscriptionStateRow =
  typeof googleWorkspaceEventSubscriptionStates.$inferSelect;

interface DecodedWorkspacePubSubPush {
  readonly messageId: string;
  readonly subscription: string | null;
  readonly cloudEvent: z.infer<typeof workspaceCloudEventSchema>;
}

interface GoogleMeetTranscriptEventContext {
  readonly cloudEventId: string;
  readonly cloudEventType: string;
  readonly cloudEventSource: string;
  readonly cloudEventSubject: string | null;
  readonly cloudEventTime: string | null;
  readonly subscriptionName: string;
  readonly conferenceRecordName: string | null;
  readonly transcriptName: string;
}

interface GoogleMeetEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowTitle: string;
  readonly chatThreadId: string;
}

type GoogleWorkspaceWebhookResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string }
  | { readonly kind: "run_error"; readonly message: string };

type PubSubOidcClaims = {
  readonly email: string | null;
  readonly emailVerified: boolean;
};

function tokenNeedsRefresh(
  tokenExpiresAt: Date | null,
  currentTime: Date,
): boolean {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

function googleWorkspaceEventsTopicName():
  | { readonly kind: "ok"; readonly topicName: string }
  | { readonly kind: "bad_request"; readonly message: string } {
  const topicName = optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME");
  return topicName
    ? { kind: "ok", topicName }
    : {
        kind: "bad_request",
        message: "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME is not configured",
      };
}

function googleMeetSubscriptionStateForCleanup(
  states: readonly GoogleWorkspaceSubscriptionStateRow[],
): GoogleWorkspaceSubscriptionStateRow | undefined {
  const topic = googleWorkspaceEventsTopicName();
  return topic.kind === "ok"
    ? (states.find((candidate) => {
        return candidate.pubsubTopic === topic.topicName;
      }) ?? states[0])
    : states[0];
}

const resolveGoogleMeetAccess$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly refreshExpiredToken?: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetAccessResult> => {
    const currentTime = nowDate();
    const snapshot = await get(googleMeetRuntimeAuthSelection$);
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "google-meet",
      connectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (loaded.kind === "missing") {
      return {
        kind: "bad_request",
        message:
          "Connect Google Meet before adding a Google Meet event automation",
      };
    }
    if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Meet before using Google Meet event automations",
      };
    }
    const connection = loaded.connection;
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      connection,
      GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME,
    );
    if (accessTokenValueRef === null) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Meet before using Google Meet event automations",
      };
    }
    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      {
        connection,
        valueRefs: [accessTokenValueRef],
      },
      signal,
    );
    const accessToken = values.get(accessTokenValueRef);
    if (!accessToken) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Meet before using Google Meet event automations",
      };
    }
    if (
      !tokenNeedsRefresh(connection.tokenExpiresAt, currentTime) ||
      args.refreshExpiredToken === false
    ) {
      return {
        kind: "ok",
        access: {
          connectorId: connection.connectorId,
          externalId: connection.externalId,
          emailAddress: connection.externalEmail,
          accessToken,
        },
      };
    }
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName: GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME,
        persist: { markNeedsReconnectOnFailure: true },
      },
      signal,
    );
    if (refreshed.kind === "configuration-unavailable") {
      return {
        kind: "bad_request",
        message: "Google OAuth client env vars are not configured",
      };
    }
    if (refreshed.kind !== "ok") {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Meet before using Google Meet event automations",
      };
    }
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        externalId: connection.externalId,
        emailAddress: connection.externalEmail,
        accessToken: refreshed.accessToken,
      },
    };
  },
);

function workspaceEventsApiUrl(path: string): string {
  return `${GOOGLE_WORKSPACE_EVENTS_API_BASE}${path}`;
}

async function workspaceEventsFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<WorkspaceEventsFetchResult<T>> {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }

  return { kind: "ok", value: schema.parse(await response.json()) };
}

function workspaceOperationSubscription(
  operation: z.infer<typeof workspaceOperationSchema>,
): z.infer<typeof workspaceSubscriptionSchema> | null {
  return operation.response ?? null;
}

function eventTypesKey(eventTypes: readonly string[]): string {
  return [...eventTypes].sort().join("\n");
}

function meetTranscriptGeneratedEventTypes(): readonly string[] {
  return [GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE];
}

function googleMeetUserTargetResource(externalId: string): string {
  return `//cloudidentity.googleapis.com/users/${externalId}`;
}

function subscriptionExpireTime(
  subscription: z.infer<typeof workspaceSubscriptionSchema>,
  currentTime: Date,
): Date {
  const parsed = subscription.expireTime
    ? new Date(subscription.expireTime)
    : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(
        currentTime.getTime() +
          GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS * 1000,
      );
}

function subscriptionNeedsRenewal(
  state: GoogleWorkspaceSubscriptionStateRow,
  currentTime: Date,
): boolean {
  return (
    state.needsRepair ||
    state.expireTime.getTime() <=
      currentTime.getTime() + GOOGLE_WORKSPACE_RENEWAL_WINDOW_MS
  );
}

const loadWorkspaceSubscriptionState$ = command(
  async (
    { get },
    args: {
      readonly connectorId: string;
      readonly targetResource: string;
      readonly eventTypes: readonly string[];
      readonly topicName: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleWorkspaceSubscriptionStateRow | null> => {
    const [state] = await get(db$)
      .select()
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(
            googleWorkspaceEventSubscriptionStates.connectorId,
            args.connectorId,
          ),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          eq(
            googleWorkspaceEventSubscriptionStates.targetResource,
            args.targetResource,
          ),
          eq(
            googleWorkspaceEventSubscriptionStates.pubsubTopic,
            args.topicName,
          ),
          eq(
            googleWorkspaceEventSubscriptionStates.eventTypesKey,
            eventTypesKey(args.eventTypes),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return state ?? null;
  },
);

/**
 * Conditional unique upsert of one subscription state: it applies only while
 * the account exists and, when required, a consumer is live.
 */
function googleMeetSubscriptionPublicationSql(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly subscription: z.infer<typeof workspaceSubscriptionSchema>;
  readonly currentTime: Date;
  readonly consumerCondition: SQL | undefined;
}) {
  const expireTime = subscriptionExpireTime(
    args.subscription,
    args.currentTime,
  );
  const timestamp = sql`${args.currentTime.toISOString()}::timestamp`;
  const accountCondition = and(
    eq(connectors.id, args.connectorId),
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
  );
  const consumerGate =
    args.consumerCondition === undefined
      ? sql`TRUE`
      : sql`EXISTS (SELECT 1 FROM ${workflowAutomations} WHERE ${args.consumerCondition})`;
  return sql`INSERT INTO ${googleWorkspaceEventSubscriptionStates} (
      org_id, user_id, connector_id, provider, target_resource, event_types,
      event_types_key, subscription_name, pubsub_topic, state, expire_time,
      last_renewed_at, needs_repair, created_at, updated_at
    )
    SELECT ${args.orgId}, ${args.userId}, ${args.connectorId}::uuid,
      'google-meet', ${args.targetResource},
      ${JSON.stringify(args.eventTypes)}::jsonb, ${eventTypesKey(args.eventTypes)},
      ${args.subscription.name}, ${args.topicName},
      ${args.subscription.state ?? null}, ${expireTime.toISOString()}::timestamp,
      ${timestamp}, false, ${timestamp}, ${timestamp}
    WHERE EXISTS (SELECT 1 FROM ${connectors} WHERE ${accountCondition})
      AND ${consumerGate}
    ON CONFLICT (connector_id, provider, target_resource, pubsub_topic, event_types_key)
    DO UPDATE SET
      subscription_name = EXCLUDED.subscription_name,
      event_types = EXCLUDED.event_types,
      state = EXCLUDED.state,
      expire_time = EXCLUDED.expire_time,
      last_renewed_at = EXCLUDED.last_renewed_at,
      needs_repair = false,
      updated_at = EXCLUDED.updated_at
    RETURNING id`;
}

async function createWorkspaceSubscription(
  args: {
    readonly accessToken: string;
    readonly targetResource: string;
    readonly eventTypes: readonly string[];
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    workspaceEventsApiUrl("/subscriptions"),
    {
      method: "POST",
      body: JSON.stringify({
        targetResource: args.targetResource,
        eventTypes: args.eventTypes,
        notificationEndpoint: {
          pubsubTopic: args.topicName,
        },
        ttl: `${GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS}s`,
      }),
    },
    signal,
  );
  signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events create response omitted subscription",
      };
}

async function renewWorkspaceSubscription(
  args: {
    readonly accessToken: string;
    readonly subscriptionName: string;
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const url = new URL(workspaceEventsApiUrl(`/${args.subscriptionName}`));
  url.searchParams.set("updateMask", "ttl");
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    url.toString(),
    {
      method: "PATCH",
      body: JSON.stringify({
        name: args.subscriptionName,
        ttl: `${GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS}s`,
      }),
    },
    signal,
  );
  signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events renew response omitted subscription",
      };
}

async function reactivateWorkspaceSubscription(
  args: {
    readonly accessToken: string;
    readonly subscriptionName: string;
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    workspaceEventsApiUrl(`/${args.subscriptionName}:reactivate`),
    { method: "POST", body: JSON.stringify({}) },
    signal,
  );
  signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events reactivate response omitted subscription",
      };
}

async function deletePreparedGoogleMeetSubscription(
  pending: PendingGoogleMeetSubscriptionDelete,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(workspaceEventsApiUrl(`/${pending.subscriptionName}`));
  url.searchParams.set("allowMissing", "true");
  await workspaceEventsFetchJson(
    workspaceOperationSchema,
    pending.accessToken,
    url.toString(),
    { method: "DELETE" },
    signal,
  );
  signal.throwIfAborted();
}

/**
 * Best-effort remote cleanup after an account deletion committed. Skips a
 * subscription that local state has since adopted; a concurrent adoption after
 * this read may lose notifications until repair (accepted gap).
 */
export const deletePreparedGoogleMeetSubscriptionIfUnadopted$ = command(
  async (
    { get },
    args: {
      readonly pending: PendingGoogleMeetSubscriptionDelete;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const [adopted] = await get(db$)
      .select({ id: googleWorkspaceEventSubscriptionStates.id })
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        eq(
          googleWorkspaceEventSubscriptionStates.subscriptionName,
          args.pending.subscriptionName,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (adopted) {
      return;
    }
    await deletePreparedGoogleMeetSubscription(args.pending, signal);
  },
);

async function listWorkspaceSubscriptions(
  args: {
    readonly accessToken: string;
    readonly targetResource: string;
    readonly eventTypes: readonly string[];
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<
    readonly z.infer<typeof workspaceSubscriptionSchema>[]
  >
> {
  const subscriptions: z.infer<typeof workspaceSubscriptionSchema>[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(workspaceEventsApiUrl("/subscriptions"));
    url.searchParams.set("pageSize", "100");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const filter = `${args.eventTypes
      .map((eventType) => {
        return `event_types:"${eventType}"`;
      })
      .join(" OR ")} AND target_resource="${args.targetResource}"`;
    url.searchParams.set("filter", filter);

    const result = await workspaceEventsFetchJson(
      workspaceSubscriptionsListSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return result;
    }
    subscriptions.push(...(result.value.subscriptions ?? []));
    pageToken = result.value.nextPageToken ?? null;
  } while (pageToken);

  return { kind: "ok", value: subscriptions };
}

function workspaceSubscriptionMatches(args: {
  readonly subscription: z.infer<typeof workspaceSubscriptionSchema>;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
}): boolean {
  const eventTypes = new Set(args.subscription.eventTypes ?? []);
  return (
    args.subscription.targetResource === args.targetResource &&
    args.subscription.notificationEndpoint?.pubsubTopic === args.topicName &&
    args.eventTypes.every((eventType) => {
      return eventTypes.has(eventType);
    })
  );
}

async function adoptExistingWorkspaceSubscription(
  args: {
    readonly accessToken: string;
    readonly targetResource: string;
    readonly eventTypes: readonly string[];
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const list = await listWorkspaceSubscriptions(args, signal);
  signal.throwIfAborted();
  if (list.kind !== "ok") {
    return list;
  }
  const subscription = list.value.find((candidate) => {
    return workspaceSubscriptionMatches({
      subscription: candidate,
      targetResource: args.targetResource,
      eventTypes: args.eventTypes,
      topicName: args.topicName,
    });
  });
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 409,
        message:
          "Workspace Events subscription already exists for this Google Meet account but does not target the configured Pub/Sub topic",
      };
}

async function createOrAdoptWorkspaceSubscription(
  args: {
    readonly accessToken: string;
    readonly targetResource: string;
    readonly eventTypes: readonly string[];
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const created = await createWorkspaceSubscription(args, signal);
  signal.throwIfAborted();
  if (created.kind === "ok") {
    return created;
  }
  if (created.status !== 409) {
    return created;
  }
  return await adoptExistingWorkspaceSubscription(args, signal);
}

type GoogleMeetSubscriptionReconcileAction =
  | "unchanged"
  | "created"
  | "renewed"
  | "removed";

type GoogleMeetSubscriptionReconcileResult =
  | {
      readonly kind: "ok";
      readonly action: GoogleMeetSubscriptionReconcileAction;
    }
  | { readonly kind: "bad_request"; readonly message: string };

interface GoogleMeetSubscriptionPublication {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly subscription: z.infer<typeof workspaceSubscriptionSchema>;
  readonly currentTime: Date;
  readonly accessToken: string;
}

/**
 * Prepares the remote Workspace Events subscription outside any transaction.
 * Returns the subscription to publish, or a terminal result. Replacement and
 * repair may miss notifications (accepted, as for Calendar).
 */
const prepareGoogleMeetTranscriptGeneratedSubscription$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly action: "unchanged";
      }
    | {
        readonly kind: "prepared";
        readonly created: boolean;
        readonly publication: GoogleMeetSubscriptionPublication;
      }
    | { readonly kind: "bad_request"; readonly message: string }
  > => {
    const topicResult = googleWorkspaceEventsTopicName();
    if (topicResult.kind !== "ok") {
      return topicResult;
    }
    const accessResult = await set(resolveGoogleMeetAccess$, args, signal);
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return accessResult;
    }
    if (!accessResult.access.externalId) {
      return {
        kind: "bad_request",
        message:
          "Reconnect Google Meet before using Google Meet event automations; the connected account is missing a Google user id",
      };
    }

    const eventTypes = meetTranscriptGeneratedEventTypes();
    const targetResource = googleMeetUserTargetResource(
      accessResult.access.externalId,
    );
    const existing = await set(
      loadWorkspaceSubscriptionState$,
      {
        connectorId: accessResult.access.connectorId,
        targetResource,
        eventTypes,
        topicName: topicResult.topicName,
      },
      signal,
    );
    const currentTime = nowDate();
    if (existing && !subscriptionNeedsRenewal(existing, currentTime)) {
      return { kind: "ok", action: "unchanged" };
    }

    let subscription: WorkspaceEventsFetchResult<
      z.infer<typeof workspaceSubscriptionSchema>
    >;
    let created = existing === null;
    if (existing) {
      if (existing.needsRepair) {
        await reactivateWorkspaceSubscription(
          {
            accessToken: accessResult.access.accessToken,
            subscriptionName: existing.subscriptionName,
          },
          signal,
        );
        signal.throwIfAborted();
      }
      subscription = await renewWorkspaceSubscription(
        {
          accessToken: accessResult.access.accessToken,
          subscriptionName: existing.subscriptionName,
        },
        signal,
      );
      signal.throwIfAborted();
      if (subscription.kind !== "ok" && subscription.status === 404) {
        created = true;
        subscription = await createOrAdoptWorkspaceSubscription(
          {
            accessToken: accessResult.access.accessToken,
            targetResource,
            eventTypes,
            topicName: topicResult.topicName,
          },
          signal,
        );
      }
    } else {
      subscription = await createOrAdoptWorkspaceSubscription(
        {
          accessToken: accessResult.access.accessToken,
          targetResource,
          eventTypes,
          topicName: topicResult.topicName,
        },
        signal,
      );
    }

    signal.throwIfAborted();
    if (subscription.kind !== "ok") {
      return {
        kind: "bad_request",
        message: `Failed to ensure Google Meet Workspace Events subscription: ${subscription.message}`,
      };
    }

    return {
      kind: "prepared",
      created,
      publication: {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: accessResult.access.connectorId,
        targetResource,
        eventTypes,
        topicName: topicResult.topicName,
        subscription: subscription.value,
        currentTime,
        accessToken: accessResult.access.accessToken,
      },
    };
  },
);

/** Meet automations of one owner that target one connector, in any state. */
function googleMeetConnectorAutomationsCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    eq(
      workflowAutomations.eventType,
      GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
    ),
    eq(workflowAutomations.eventConnectorId, args.connectorId),
  );
}

function googleMeetConsumerStateCondition(allowStagedOfficialTarget: boolean) {
  return allowStagedOfficialTarget
    ? or(
        eq(workflowAutomations.enabled, true),
        and(
          eq(workflowAutomations.enabled, false),
          eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
          isNotNull(workflowAutomations.officialBlueprintKey),
        ),
      )
    : eq(workflowAutomations.enabled, true);
}

export const hasEnabledGoogleMeetConsumer$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly allowStagedOfficialTarget?: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [consumer] = await get(db$)
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          googleMeetConnectorAutomationsCondition(args),
          googleMeetConsumerStateCondition(
            args.allowStagedOfficialTarget === true,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return consumer !== undefined;
  },
);

const loadGoogleMeetSubscriptionStatesForOwner$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId?: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleWorkspaceSubscriptionStateRow[]> => {
    const states = await get(db$)
      .select()
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.orgId, args.orgId),
          eq(googleWorkspaceEventSubscriptionStates.userId, args.userId),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          args.connectorId === undefined
            ? undefined
            : eq(
                googleWorkspaceEventSubscriptionStates.connectorId,
                args.connectorId,
              ),
        ),
      );
    signal.throwIfAborted();
    return states;
  },
);

const pendingGoogleMeetSubscriptionDeleteForState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleWorkspaceSubscriptionStateRow;
    },
    signal: AbortSignal,
  ): Promise<PendingGoogleMeetSubscriptionDelete | null> => {
    const access = await set(
      resolveGoogleMeetAccess$,
      {
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.state.connectorId,
        refreshExpiredToken: false,
      },
      signal,
    );
    signal.throwIfAborted();
    return access.kind === "ok"
      ? {
          accessToken: access.access.accessToken,
          orgId: args.state.orgId,
          subscriptionName: args.state.subscriptionName,
          userId: args.state.userId,
        }
      : null;
  },
);

export const prepareGoogleMeetSubscriptionDeleteForConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<PendingGoogleMeetSubscriptionDelete | null> => {
    const states = await get(db$)
      .select()
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.orgId, args.orgId),
          eq(googleWorkspaceEventSubscriptionStates.userId, args.userId),
          eq(
            googleWorkspaceEventSubscriptionStates.connectorId,
            args.connectorId,
          ),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
        ),
      );
    signal.throwIfAborted();
    const state = googleMeetSubscriptionStateForCleanup(states);
    return state
      ? await set(
          pendingGoogleMeetSubscriptionDeleteForState$,
          { state },
          signal,
        )
      : null;
  },
);

const reconcileGoogleMeetSubscriptionLifecycle$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly allowStagedOfficialTarget?: boolean;
      readonly ensurePreparedOfficialTarget?: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetSubscriptionReconcileResult> => {
    const consumerArgs = {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
      allowStagedOfficialTarget: args.allowStagedOfficialTarget === true,
    };
    const wantsSubscription =
      args.ensurePreparedOfficialTarget === true ||
      (await set(hasEnabledGoogleMeetConsumer$, consumerArgs, signal));
    if (wantsSubscription) {
      const prepared = await set(
        prepareGoogleMeetTranscriptGeneratedSubscription$,
        args,
        signal,
      );
      if (prepared.kind !== "prepared") {
        return prepared;
      }
      const published = await set(
        publishGoogleMeetSubscription$,
        {
          ...consumerArgs,
          requireConsumer: args.ensurePreparedOfficialTarget !== true,
          publication: prepared.publication,
        },
        signal,
      );
      if (!published) {
        // The consumer went away while the remote subscription was prepared.
        // Removing a subscription this request created is best effort.
        if (prepared.created) {
          await settleIncludingAbort(
            bestEffort(
              deletePreparedGoogleMeetSubscription(
                {
                  accessToken: prepared.publication.accessToken,
                  orgId: args.orgId,
                  subscriptionName: prepared.publication.subscription.name,
                  userId: args.userId,
                },
                signal,
              ),
            ),
          );
        }
        return { kind: "ok", action: "unchanged" };
      }
      return {
        kind: "ok",
        action: prepared.created ? "created" : "renewed",
      };
    }

    const states = await set(
      loadGoogleMeetSubscriptionStatesForOwner$,
      consumerArgs,
      signal,
    );
    const state = googleMeetSubscriptionStateForCleanup(states);
    const pendingDelete = state
      ? await set(
          pendingGoogleMeetSubscriptionDeleteForState$,
          { state },
          signal,
        )
      : null;
    const removed = await set(
      removeGoogleMeetSubscriptionStates$,
      consumerArgs,
      signal,
    );
    if (!removed) {
      return { kind: "ok", action: "unchanged" };
    }
    // Remote cleanup follows the local decision and is best effort. A consumer
    // enabled meanwhile may lose notifications until its repair recreates the
    // subscription; that gap is accepted.
    if (pendingDelete) {
      const deleted = await settleIncludingAbort(
        bestEffort(deletePreparedGoogleMeetSubscription(pendingDelete, signal)),
      );
      signal.throwIfAborted();
      if (!deleted.ok) {
        throw deleted.error;
      }
    }
    return { kind: "ok", action: "removed" };
  },
);

/**
 * Short local publication: one conditional unique upsert that applies only
 * while the account exists and (when required) a consumer is live. No row is
 * locked; the connector FK protects a new row from a concurrent account
 * delete. A disable racing this statement may still publish one state, which
 * consumer-less removal cleans up (accepted notification/cleanup gap).
 */
const publishGoogleMeetSubscription$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly allowStagedOfficialTarget: boolean;
      readonly requireConsumer: boolean;
      readonly publication: GoogleMeetSubscriptionPublication;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const published = await settle(
      executeRawRows(
        set(writeDb$),
        googleMeetSubscriptionPublicationSql({
          ...args.publication,
          orgId: args.orgId,
          userId: args.userId,
          consumerCondition: args.requireConsumer
            ? and(
                googleMeetConnectorAutomationsCondition(args),
                googleMeetConsumerStateCondition(
                  args.allowStagedOfficialTarget,
                ),
              )
            : undefined,
        }),
        z.object({ id: z.string() }),
      ),
      signal,
    );
    if (!published.ok) {
      if (isForeignKeyViolation(published.error)) {
        return false;
      }
      throw published.error;
    }
    return published.value.length > 0;
  },
);

/**
 * Deletes local subscription state only while no consumer is enabled, in one
 * conditional DELETE; no automation row is locked. A consumer enabled or
 * retargeted concurrently may see a notification gap until its repair
 * recreates the subscription (accepted).
 */
const removeGoogleMeetSubscriptionStates$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly allowStagedOfficialTarget: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const removed = await set(writeDb$)
      .delete(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.orgId, args.orgId),
          eq(googleWorkspaceEventSubscriptionStates.userId, args.userId),
          eq(
            googleWorkspaceEventSubscriptionStates.connectorId,
            args.connectorId,
          ),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          notExists(
            set(writeDb$)
              .select({ id: workflowAutomations.id })
              .from(workflowAutomations)
              .where(
                and(
                  googleMeetConnectorAutomationsCondition(args),
                  googleMeetConsumerStateCondition(
                    args.allowStagedOfficialTarget,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ id: googleWorkspaceEventSubscriptionStates.id });
    signal.throwIfAborted();
    if (removed.length > 0) {
      return true;
    }
    return !(await set(hasEnabledGoogleMeetConsumer$, args, signal));
  },
);

export const ensureGoogleMeetTranscriptGeneratedSubscriptionForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly allowStagedOfficialTarget?: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetSubscriptionReconcileResult> => {
    return await set(
      reconcileGoogleMeetSubscriptionLifecycle$,
      {
        ...args,
        ensurePreparedOfficialTarget: args.allowStagedOfficialTarget === true,
      },
      signal,
    );
  },
);

const loadGoogleMeetConnectorInventory$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<Set<string>> => {
    // No row locks: reprojection reads the current selections/default and
    // rewrites only differing targets; an account change committed afterwards
    // is converged by its own repair. The inventory reads follow.
    await set(
      repairGoogleMeetAutomationAccountProjectionsForOwner$,
      args,
      signal,
    );
    signal.throwIfAborted();
    const automationRows = await get(db$)
      .selectDistinct({ connectorId: workflowAutomations.eventConnectorId })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          or(
            eq(workflowAutomations.enabled, true),
            and(
              eq(workflowAutomations.enabled, false),
              eq(
                workflowAutomations.officialReconciliationStatus,
                "reconciling",
              ),
              isNotNull(workflowAutomations.officialBlueprintKey),
            ),
          ),
          eq(workflowAutomations.kind, "event"),
          eq(
            workflowAutomations.eventType,
            GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
          ),
          isNotNull(workflowAutomations.eventConnectorId),
        ),
      );
    signal.throwIfAborted();
    const states = await get(db$)
      .select({
        connectorId: googleWorkspaceEventSubscriptionStates.connectorId,
      })
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.orgId, args.orgId),
          eq(googleWorkspaceEventSubscriptionStates.userId, args.userId),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
        ),
      );
    signal.throwIfAborted();
    return new Set(
      [...automationRows, ...states].flatMap((row) => {
        return row.connectorId === null ? [] : [row.connectorId];
      }),
    );
  },
);

const loadGoogleMeetAccountProjectionAutomations$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const automations = await db
      .select({
        id: workflowAutomations.id,
        workflowId: workflowAutomations.workflowId,
        eventConnectorId: workflowAutomations.eventConnectorId,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.kind, "event"),
          eq(
            workflowAutomations.eventType,
            GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
          ),
        ),
      );
    signal.throwIfAborted();
    return automations;
  },
);

const publishGoogleMeetAutomationProjection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly automation: {
        readonly id: string;
        readonly workflowId: string;
        readonly eventConnectorId: string | null;
      };
    },
    signal: AbortSignal,
  ): Promise<void> => {
    // No row locks: read the automation and its selected account plainly,
    // then retarget with a conditional UPDATE that applies only while the
    // observed target and the selection are unchanged. A concurrent change
    // makes it a no-op and is converged by that change's own repair.
    const { automation } = args;
    const selectionSql = workflowAutomationConnectorSelectionSql({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: automation.workflowId,
      connectorSlug: "google-meet",
    });
    const [selected] = parseRawRows(
      z.object({ connectorId: z.string().nullable() }),
      await get(rawSqlReadDb$).execute(selectionSql),
    );
    signal.throwIfAborted();
    const eventConnectorId = selected?.connectorId ?? null;
    if (eventConnectorId === automation.eventConnectorId) {
      return;
    }
    await set(writeDb$)
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          sql`${workflowAutomations.eventConnectorId} IS NOT DISTINCT FROM ${automation.eventConnectorId}::uuid`,
          sql`(${selectionSql}) IS NOT DISTINCT FROM ${eventConnectorId}::uuid`,
        ),
      );
    signal.throwIfAborted();
  },
);

const repairGoogleMeetAutomationAccountProjectionsForOwner$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const automations = await set(
      loadGoogleMeetAccountProjectionAutomations$,
      args,
      signal,
    );
    for (const automation of automations) {
      await set(
        publishGoogleMeetAutomationProjection$,
        { ...args, automation },
        signal,
      );
    }
  },
);

const reconcileGoogleMeetSubscriptionInventory$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetSubscriptionReconcileResult[]> => {
    const connectorIds = await set(
      loadGoogleMeetConnectorInventory$,
      args,
      signal,
    );
    const results: GoogleMeetSubscriptionReconcileResult[] = [];
    for (const connectorId of connectorIds) {
      results.push(
        await set(
          reconcileGoogleMeetSubscriptionLifecycle$,
          { ...args, connectorId, allowStagedOfficialTarget: true },
          signal,
        ),
      );
      signal.throwIfAborted();
    }
    return results;
  },
);

export const reconcileGoogleMeetSubscriptionsForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const results = await set(
      reconcileGoogleMeetSubscriptionInventory$,
      args,
      signal,
    );
    return results.every((result) => {
      return result.kind === "ok";
    });
  },
);

async function defaultPubSubOidcVerifier(
  token: string,
  audience: string,
  signal: AbortSignal,
): Promise<PubSubOidcClaims> {
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience,
  });
  signal.throwIfAborted();
  const payload = ticket.getPayload();
  return {
    email: payload?.email ?? null,
    emailVerified: payload?.email_verified === true,
  };
}

async function verifyGoogleWorkspacePubSubOidc(
  args: {
    readonly authorization: string | null;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "config_error"; readonly message: string }
> {
  const audience = optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE");
  const expectedEmail = optionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  );
  if (!audience || !expectedEmail) {
    return {
      kind: "config_error",
      message:
        "Google Workspace Events Pub/Sub push OIDC env vars are not configured",
    };
  }

  if (!args.authorization?.startsWith("Bearer ")) {
    return { kind: "unauthorized" };
  }

  const token = args.authorization.slice("Bearer ".length);
  const claims = await tapError(
    defaultPubSubOidcVerifier(token, audience, signal),
  );
  signal.throwIfAborted();
  if (!claims) {
    return { kind: "unauthorized" };
  }

  return claims.email === expectedEmail && claims.emailVerified
    ? { kind: "ok" }
    : { kind: "unauthorized" };
}

function decodeBase64Json(input: string | undefined): unknown {
  if (!input) {
    return undefined;
  }
  const decoded = Buffer.from(input, "base64").toString("utf8");
  return safeJsonParse(decoded);
}

function cloudEventFromPubSubPush(
  rawPush: z.infer<typeof pubSubPushSchema>,
):
  | DecodedWorkspacePubSubPush
  | { readonly kind: "bad_request"; readonly message: string } {
  const messageId = rawPush.message.messageId ?? rawPush.message.message_id;
  if (!messageId) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub message id",
    };
  }

  const attributes = rawPush.message.attributes ?? {};
  const decodedData = decodeBase64Json(rawPush.message.data);
  const attributeType = attributes["ce-type"];
  if (attributeType) {
    const parsed = workspaceCloudEventSchema.safeParse({
      id: attributes["ce-id"],
      source: attributes["ce-source"],
      subject: attributes["ce-subject"],
      type: attributeType,
      time: attributes["ce-time"],
      specversion: attributes["ce-specversion"],
      datacontenttype: attributes["content-type"],
      data: decodedData,
    });
    if (!parsed.success) {
      return {
        kind: "bad_request",
        message: "Invalid Google Workspace Events CloudEvent attributes",
      };
    }
    return {
      messageId,
      subscription: rawPush.subscription ?? null,
      cloudEvent: parsed.data,
    };
  }

  const parsed = workspaceCloudEventSchema.safeParse(decodedData);
  if (!parsed.success) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events CloudEvent payload",
    };
  }
  return {
    messageId,
    subscription: rawPush.subscription ?? null,
    cloudEvent: parsed.data,
  };
}

function decodeWorkspacePubSubPush(
  rawBody: string,
):
  | DecodedWorkspacePubSubPush
  | { readonly kind: "bad_request"; readonly message: string } {
  const rawPush = safeJsonParse(rawBody);
  if (rawPush === undefined) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub push payload",
    };
  }
  const push = pubSubPushSchema.safeParse(rawPush);
  if (!push.success) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub push payload",
    };
  }
  return cloudEventFromPubSubPush(push.data);
}

function subscriptionNameFromSource(source: string): string | null {
  const match = source.match(
    /^\/\/workspaceevents\.googleapis\.com\/(subscriptions\/[^/]+)$/,
  );
  return match?.[1] ?? null;
}

function dataRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function nestedName(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === "string"
    ? ((value as Record<string, unknown>).name as string)
    : null;
}

function transcriptNameFromCloudEventData(data: unknown): string | null {
  const root = dataRecord(data);
  const transcript = nestedName(root, "transcript");
  if (transcript) {
    return transcript;
  }
  const conferenceRecord = dataRecord(root.conferenceRecord);
  return nestedName(conferenceRecord, "transcript");
}

function subscriptionNameFromCloudEvent(
  cloudEvent: z.infer<typeof workspaceCloudEventSchema>,
): string | null {
  const sourceSubscription = subscriptionNameFromSource(cloudEvent.source);
  if (sourceSubscription) {
    return sourceSubscription;
  }
  const data = dataRecord(cloudEvent.data);
  const subscription = nestedName(data, "subscription");
  return subscription;
}

function conferenceRecordNameFromTranscriptName(
  transcriptName: string,
): string | null {
  const marker = "/transcripts/";
  const index = transcriptName.indexOf(marker);
  return index > 0 ? transcriptName.slice(0, index) : null;
}

function googleMeetTranscriptEventContext(
  decoded: DecodedWorkspacePubSubPush,
):
  | { readonly kind: "ok"; readonly context: GoogleMeetTranscriptEventContext }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "ignored" } {
  const { cloudEvent } = decoded;
  if (cloudEvent.type !== GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE) {
    return { kind: "ignored" };
  }
  const subscriptionName = subscriptionNameFromCloudEvent(cloudEvent);
  if (!subscriptionName) {
    return {
      kind: "bad_request",
      message: "Google Workspace Events CloudEvent missing subscription source",
    };
  }
  const transcriptName = transcriptNameFromCloudEventData(cloudEvent.data);
  if (!transcriptName) {
    return {
      kind: "bad_request",
      message: "Google Meet transcript event missing transcript resource name",
    };
  }
  return {
    kind: "ok",
    context: {
      cloudEventId: cloudEvent.id,
      cloudEventType: cloudEvent.type,
      cloudEventSource: cloudEvent.source,
      cloudEventSubject: cloudEvent.subject ?? null,
      cloudEventTime: cloudEvent.time ?? null,
      subscriptionName,
      transcriptName,
      conferenceRecordName:
        conferenceRecordNameFromTranscriptName(transcriptName),
    },
  };
}

const loadWorkspaceSubscriptionStateByName$ = command(
  async (
    { get },
    args: {
      readonly subscriptionName: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleWorkspaceSubscriptionStateRow | null> => {
    const db = get(db$);
    const [state] = await db
      .select()
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        eq(
          googleWorkspaceEventSubscriptionStates.subscriptionName,
          args.subscriptionName,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return state ?? null;
  },
);

const handleWorkspaceLifecycleEvent$ = command(
  async (
    { set },
    args: {
      readonly decoded: DecodedWorkspacePubSubPush;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const subscriptionName = subscriptionNameFromCloudEvent(
      args.decoded.cloudEvent,
    );
    if (!subscriptionName) {
      return;
    }
    const currentTime = nowDate();
    const data = dataRecord(args.decoded.cloudEvent.data);
    const subscription = dataRecord(data.subscription);
    const expireTime =
      typeof subscription.expire_time === "string"
        ? new Date(subscription.expire_time)
        : null;
    const update: {
      state?: string;
      expireTime?: Date;
      needsRepair: boolean;
      updatedAt: Date;
    } = {
      needsRepair:
        args.decoded.cloudEvent.type !==
        "google.workspace.events.subscription.v1.expirationReminder",
      updatedAt: currentTime,
    };
    if (
      args.decoded.cloudEvent.type ===
      "google.workspace.events.subscription.v1.suspended"
    ) {
      update.state = "SUSPENDED";
    } else if (
      args.decoded.cloudEvent.type ===
      "google.workspace.events.subscription.v1.expired"
    ) {
      update.state = "DELETED";
    }
    if (expireTime && !Number.isNaN(expireTime.getTime())) {
      update.expireTime = expireTime;
    }

    await db
      .update(googleWorkspaceEventSubscriptionStates)
      .set(update)
      .where(
        eq(
          googleWorkspaceEventSubscriptionStates.subscriptionName,
          subscriptionName,
        ),
      );
    signal.throwIfAborted();
  },
);

const loadGoogleMeetEventAutomations$ = command(
  async (
    { get, set },
    args: {
      readonly state: GoogleWorkspaceSubscriptionStateRow;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetEventAutomationRow[]> => {
    const db = get(db$);
    const automationRows = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
        workflowName: workflows.name,
        workflowDisplayName: workflows.displayName,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
          eq(
            workflowUserAutomationThreads.userId,
            workflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            workflowAutomations.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(workflowAutomations.orgId, args.state.orgId),
          eq(workflowAutomations.ownerUserId, args.state.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          eq(
            workflowAutomations.eventType,
            GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
          ),
          eq(workflowAutomations.eventConnectorId, args.state.connectorId),
        ),
      );
    signal.throwIfAborted();

    const currentTime = nowDate();
    const automations: GoogleMeetEventAutomationRow[] = [];
    for (const row of automationRows) {
      const config = googleMeetTranscriptGeneratedEventConfigSchema.safeParse(
        row.automation.eventConfig,
      );
      if (!config.success || config.data.scope.type !== "organizer_user") {
        continue;
      }
      const chatThreadId =
        row.chatThreadId ??
        (await set(
          ensureWorkflowUserAutomationThread$,
          {
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
            workflowId: row.automation.workflowId,
            agentId: row.agentId,
            workflowTitle: row.workflowDisplayName ?? row.workflowName,
            currentTime,
          },
          signal,
        ));
      signal.throwIfAborted();
      automations.push({
        automation: row.automation,
        agentId: row.agentId,
        workflowName: row.workflowName,
        workflowTitle: row.workflowDisplayName ?? row.workflowName,
        chatThreadId,
      });
    }
    return automations;
  },
);

const insertWorkspaceProcessedEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleWorkspaceSubscriptionStateRow;
      readonly automation: GoogleMeetEventAutomationRow;
      readonly decoded: DecodedWorkspacePubSubPush;
      readonly event: GoogleMeetTranscriptEventContext;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const [processed] = await db
      .insert(googleWorkspaceProcessedEvents)
      .values({
        subscriptionStateId: args.state.id,
        automationId: args.automation.automation.id,
        pubsubMessageId: args.decoded.messageId,
        cloudEventId: args.event.cloudEventId,
        cloudEventType: args.event.cloudEventType,
        conferenceRecordName: args.event.conferenceRecordName,
        transcriptName: args.event.transcriptName,
        createdAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: googleWorkspaceProcessedEvents.id });
    signal.throwIfAborted();
    return processed?.id ?? null;
  },
);

function buildGoogleMeetWorkflowAutomationBrief(
  event: GoogleMeetTranscriptEventContext,
): string {
  return `Google Meet transcript ready: ${event.transcriptName}`;
}

function googleMeetTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: GoogleMeetTranscriptEventContext;
}): WorkflowAutomationContext {
  return {
    workflowName: args.workflowName,
    eventType: "google-meet-transcript-generated",
    trigger: `Google Meet generated transcript ${args.event.transcriptName} for a meeting organized by the connected account (cloud event ${args.event.cloudEventId}).`,
    notes: [
      "Not included below: the transcript text. Connected Google Meet tools return transcript metadata and entries.",
    ],
    event: {
      automationId: args.automationId,
      eventType: GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
      googleWorkspaceEventType: args.event.cloudEventType,
      cloudEventId: args.event.cloudEventId,
      cloudEventSource: args.event.cloudEventSource,
      cloudEventSubject: args.event.cloudEventSubject,
      cloudEventTime: args.event.cloudEventTime,
      subscriptionName: args.event.subscriptionName,
      conferenceRecordName: args.event.conferenceRecordName,
      transcriptName: args.event.transcriptName,
    },
  };
}

interface GoogleMeetEventDispatchInput {
  readonly state: GoogleWorkspaceSubscriptionStateRow;
  readonly decoded: DecodedWorkspacePubSubPush;
  readonly event: GoogleMeetTranscriptEventContext;
  readonly apiStartTime: number;
  readonly sourceReadStartedAt: number;
  readonly sourceReadFinishedAt: number;
}

const deleteWorkspaceProcessedEvent$ = command(
  async ({ set }, processedId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(googleWorkspaceProcessedEvents)
      .where(eq(googleWorkspaceProcessedEvents.id, processedId));
    signal.throwIfAborted();
  },
);

const dispatchGoogleMeetTranscriptEventForAutomation$ = command(
  async (
    { set },
    args: GoogleMeetEventDispatchInput & {
      readonly automation: GoogleMeetEventAutomationRow;
    },
    signal: AbortSignal,
  ): Promise<"dispatched" | "duplicate" | "superseded"> => {
    const sourceTiming = new AutomationEventSourceTiming(
      "google_meet",
      args.apiStartTime,
      [
        {
          actionType:
            "api_dispatch_pre_create_agent_automation_event_load_source_state",
          startedAt: args.sourceReadStartedAt,
          finishedAt: args.sourceReadFinishedAt,
        },
      ],
    );
    const runTiming = sourceTiming.createRunTiming();
    const receiptStartedAt = now();
    const processedId = await set(insertWorkspaceProcessedEvent$, args, signal);
    runTiming.recordElapsed(
      "api_dispatch_pre_create_agent_automation_event_record_processed_event",
      receiptStartedAt,
    );
    if (!processedId) {
      return "duplicate";
    }
    const inputStartedAt = now();
    const context = googleMeetTriggerContext({
      workflowName: args.automation.workflowName,
      automationId: args.automation.automation.id,
      event: args.event,
    });
    const triggerBrief = buildGoogleMeetWorkflowAutomationBrief(args.event);
    runTiming.recordElapsed(
      "api_dispatch_pre_create_agent_automation_event_build_run_input",
      inputStartedAt,
    );
    const started = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: args.automation.automation,
            agentId: args.automation.agentId,
            chatThreadId: args.automation.chatThreadId,
          },
          automationContext: context,
          connectorSourceId: args.state.connectorId,
          apiStartTime: args.apiStartTime,
          triggerSource: "automation-event",
          triggerBrief,
          sourcePlan: {
            kind: "google-meet",
            source: {
              automationId: args.automation.automation.id,
              orgId: args.automation.automation.orgId,
              userId: args.automation.automation.ownerUserId,
              connectorSourceId: args.state.connectorId,
              subscriptionStateId: args.state.id,
              subscriptionName: args.state.subscriptionName,
            },
          },
          timing: runTiming.collectorForRunStart(),
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!started.ok) {
      if (started.error instanceof GoogleMeetAutomationSourceChangedError) {
        await set(deleteWorkspaceProcessedEvent$, processedId, signal);
        return "superseded";
      }
      throw started.error;
    }
    return "dispatched";
  },
);

type GoogleMeetTranscriptDispatchResult = {
  readonly kind: "ok";
  readonly dispatched: number;
  readonly duplicates: number;
};

const dispatchGoogleMeetTranscriptEventForState$ = command(
  async (
    { set },
    args: GoogleMeetEventDispatchInput & {
      readonly automations: readonly GoogleMeetEventAutomationRow[];
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetTranscriptDispatchResult> => {
    let dispatched = 0;
    let duplicates = 0;
    for (const automation of args.automations) {
      const result = await set(
        dispatchGoogleMeetTranscriptEventForAutomation$,
        { ...args, automation },
        signal,
      );
      dispatched += result === "dispatched" ? 1 : 0;
      duplicates += result === "duplicate" ? 1 : 0;
    }
    return { kind: "ok", dispatched, duplicates };
  },
);

async function authenticateAndDecodeGoogleWorkspacePush(
  args: {
    readonly authorization: string | null;
    readonly rawBody: string;
  },
  signal: AbortSignal,
): Promise<DecodedWorkspacePubSubPush | GoogleWorkspaceWebhookResult> {
  const auth = await verifyGoogleWorkspacePubSubOidc(
    { authorization: args.authorization },
    signal,
  );
  signal.throwIfAborted();
  if (auth.kind !== "ok") {
    return auth;
  }
  return decodeWorkspacePubSubPush(args.rawBody);
}

const loadCurrentGoogleMeetSubscriptionState$ = command(
  async (
    { set },
    subscriptionName: string,
    signal: AbortSignal,
  ): Promise<{
    readonly state: GoogleWorkspaceSubscriptionStateRow;
    readonly sourceReadStartedAt: number;
    readonly sourceReadFinishedAt: number;
  } | null> => {
    const sourceReadStartedAt = now();
    const state = await set(
      loadWorkspaceSubscriptionStateByName$,
      { subscriptionName },
      signal,
    );
    const sourceReadFinishedAt = now();
    if (!state || state.provider !== "google-meet") {
      return null;
    }
    await set(
      repairGoogleMeetAutomationAccountProjectionsForOwner$,
      { orgId: state.orgId, userId: state.userId },
      signal,
    );
    return { state, sourceReadStartedAt, sourceReadFinishedAt };
  },
);

export const dispatchGoogleWorkspaceEventsPubSubPush$ = command(
  async (
    { set },
    args: {
      readonly authorization: string | null;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleWorkspaceWebhookResult> => {
    const decoded = await authenticateAndDecodeGoogleWorkspacePush(
      args,
      signal,
    );
    if ("kind" in decoded) {
      return decoded;
    }

    if (
      decoded.cloudEvent.type.startsWith(
        "google.workspace.events.subscription.v1.",
      )
    ) {
      await set(handleWorkspaceLifecycleEvent$, { decoded }, signal);
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }

    const event = googleMeetTranscriptEventContext(decoded);
    if (event.kind === "ignored") {
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }
    if (event.kind !== "ok") {
      return event;
    }

    const source = await set(
      loadCurrentGoogleMeetSubscriptionState$,
      event.context.subscriptionName,
      signal,
    );
    if (!source) {
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }
    const automations = await set(
      loadGoogleMeetEventAutomations$,
      { state: source.state },
      signal,
    );
    const result = await set(
      dispatchGoogleMeetTranscriptEventForState$,
      {
        ...source,
        automations,
        decoded,
        event: event.context,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    return {
      kind: "ok",
      watchStates: 1,
      dispatched: result.dispatched,
      duplicates: result.duplicates,
    };
  },
);

interface GoogleMeetSubscriptionOwnerScope {
  readonly orgId: string;
  readonly userId: string;
}

interface GoogleMeetSubscriptionRenewalSummary {
  readonly renewed: number;
  readonly repaired: number;
  readonly failed: number;
}

const renewGoogleMeetSubscriptionScopes$ = command(
  async (
    { set },
    args: {
      readonly scopes: Iterable<GoogleMeetSubscriptionOwnerScope>;
    },
    signal: AbortSignal,
  ): Promise<GoogleMeetSubscriptionRenewalSummary> => {
    let renewed = 0;
    let repaired = 0;
    let failed = 0;
    for (const scope of args.scopes) {
      const results = await set(
        reconcileGoogleMeetSubscriptionInventory$,
        { orgId: scope.orgId, userId: scope.userId },
        signal,
      );
      signal.throwIfAborted();
      for (const result of results) {
        if (result.kind !== "ok") {
          failed++;
          continue;
        }
        renewed += result.action === "renewed" ? 1 : 0;
        repaired += result.action === "created" ? 1 : 0;
      }
    }
    return { renewed, repaired, failed };
  },
);

export const renewGoogleWorkspaceEventSubscriptions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const topicResult = googleWorkspaceEventsTopicName();
    if (topicResult.kind !== "ok") {
      return { renewed: 0, repaired: 0, failed: 0 };
    }

    const db = get(db$);
    const states = await db
      .select({
        orgId: googleWorkspaceEventSubscriptionStates.orgId,
        userId: googleWorkspaceEventSubscriptionStates.userId,
      })
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          eq(
            googleWorkspaceEventSubscriptionStates.pubsubTopic,
            topicResult.topicName,
          ),
        ),
      );
    signal.throwIfAborted();

    const automationRows = await db
      .select({
        orgId: workflowAutomations.orgId,
        userId: workflowAutomations.ownerUserId,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          eq(
            workflowAutomations.eventType,
            GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
          ),
        ),
      );
    signal.throwIfAborted();

    const scopes = new Map<string, GoogleMeetSubscriptionOwnerScope>();
    for (const scope of [...states, ...automationRows]) {
      scopes.set(`${scope.orgId}\n${scope.userId}`, scope);
    }

    return await set(
      renewGoogleMeetSubscriptionScopes$,
      { scopes: scopes.values() },
      signal,
    );
  },
);
