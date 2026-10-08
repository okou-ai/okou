import { connectors } from "@okouai/db/schema/connector";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNotNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executeRawRows, parseRawRows } from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import { bestEffort, settle, settleIncludingAbort } from "../utils";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
} from "./builtin-connector-credential-runtime.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import { createConnectorRuntimeAuthSelection } from "./connector-catalog-slug-source.service";

const googleMeetRuntimeAuthSelection$ = createConnectorRuntimeAuthSelection({
  connectorSlugs: ["google-meet"],
});

const GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_MEET_TOKEN";

const GOOGLE_WORKSPACE_EVENTS_API_BASE =
  "https://workspaceevents.googleapis.com/v1";

export const GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE =
  "google-meet-transcript-generated";

export const GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE =
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
  WorkspaceEventsFetchOk<T> | WorkspaceEventsFetchError;

export type GoogleWorkspaceSubscriptionStateRow =
  typeof googleWorkspaceEventSubscriptionStates.$inferSelect;

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

export function googleWorkspaceEventsTopicName():
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

export function googleMeetSubscriptionStateForCleanup(
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

export async function deletePreparedGoogleMeetSubscription(
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
  "unchanged" | "created" | "renewed" | "removed";

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

export const pendingGoogleMeetSubscriptionDeleteForState$ = command(
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

export const repairGoogleMeetAutomationAccountProjectionsForOwner$ = command(
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

export const reconcileGoogleMeetSubscriptionInventory$ = command(
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
