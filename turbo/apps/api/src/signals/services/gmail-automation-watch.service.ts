import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { tapError } from "../utils";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
} from "./builtin-connector-credential-runtime.service";
import { readConnectorRuntimeAuthSelection$ } from "./connector-catalog-slug-source.service";

const GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME = "GMAIL_TOKEN";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export const GMAIL_EVENT_TYPES = [
  "gmail-new-message",
  "gmail-label-applied",
] as const;

const gmailWatchResponseSchema = z.object({
  historyId: z.string(),
  expiration: z.string(),
});

const gmailProfileResponseSchema = z.object({
  emailAddress: z.string(),
  historyId: z.string().optional(),
});

export interface GmailAccess {
  readonly connectorId: string;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GmailAccessResult =
  | { readonly kind: "ok"; readonly access: GmailAccess }
  | { readonly kind: "bad_request"; readonly message: string };

type EnsureGmailWatchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad_request"; readonly message: string };

type GmailWatchReconcileResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "renewed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "local_removed" }
  | { readonly kind: "failed" };

export type GmailWatchStateRow = typeof gmailWatchStates.$inferSelect;

interface GmailFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GmailFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

export type GmailFetchResult<T> = GmailFetchOk<T> | GmailFetchError;

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

export const resolveGmailAccess$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly refreshExpiredToken?: boolean;
    },
    signal: AbortSignal,
  ): Promise<GmailAccessResult> => {
    const currentTime = nowDate();
    const snapshot = await set(
      readConnectorRuntimeAuthSelection$,
      {
        connectorSlugs: ["gmail"],
      },
      signal,
    );
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "gmail",
      connectorId: args.connectorId,
    });
    signal.throwIfAborted();
    if (loaded.kind === "missing") {
      return {
        kind: "bad_request",
        message: "Connect Gmail before adding a Gmail event automation",
      };
    }
    if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
      return {
        kind: "bad_request",
        message: "Reconnect Gmail before using Gmail event automations",
      };
    }
    const connection = loaded.connection;
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      connection,
      GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
    );
    if (accessTokenValueRef === null) {
      return {
        kind: "bad_request",
        message: "Reconnect Gmail before using Gmail event automations",
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
    signal.throwIfAborted();
    const accessToken = values.get(accessTokenValueRef);
    if (!accessToken) {
      return {
        kind: "bad_request",
        message: "Reconnect Gmail before using Gmail event automations",
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
        runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
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
        message: "Reconnect Gmail before using Gmail event automations",
      };
    }
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        emailAddress: connection.externalEmail,
        accessToken: refreshed.accessToken,
      },
    };
  },
);

export async function gmailFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<GmailFetchResult<T>> {
  const response = await tapError(
    fetch(url, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    }),
  );
  signal.throwIfAborted();
  if (!response) {
    return { kind: "error", status: 0, message: "Gmail request failed" };
  }

  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }

  return { kind: "ok", value: schema.parse(await response.json()) };
}

async function fetchGmailProfile(
  accessToken: string,
  signal: AbortSignal,
): Promise<GmailFetchResult<z.infer<typeof gmailProfileResponseSchema>>> {
  return await gmailFetchJson(
    gmailProfileResponseSchema,
    accessToken,
    `${GMAIL_API_BASE}/profile`,
    { method: "GET" },
    signal,
  );
}

async function watchGmailMailbox(
  args: {
    readonly accessToken: string;
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<GmailFetchResult<z.infer<typeof gmailWatchResponseSchema>>> {
  return await gmailFetchJson(
    gmailWatchResponseSchema,
    args.accessToken,
    `${GMAIL_API_BASE}/watch`,
    {
      method: "POST",
      body: JSON.stringify({ topicName: args.topicName }),
    },
    signal,
  );
}

export function normalizeGmailAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

function gmailStateHasEnabledConsumer() {
  return sql`EXISTS (
    SELECT 1 FROM ${workflowAutomations}
    WHERE ${workflowAutomations.orgId} = ${gmailWatchStates.orgId}
      AND ${workflowAutomations.ownerUserId} = ${gmailWatchStates.userId}
      AND ${workflowAutomations.eventConnectorId} = ${gmailWatchStates.connectorId}
      AND ${workflowAutomations.enabled}
      AND ${workflowAutomations.kind} = 'event'
      AND ${workflowAutomations.eventType} IN ('gmail-new-message', 'gmail-label-applied')
  )`.mapWith(pgBooleanDecoder);
}

function watchExpirationDate(expiration: string): Date {
  const millis = Number(expiration);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid Gmail watch expiration: ${expiration}`);
  }
  return new Date(millis);
}

interface GmailPhysicalScopeInput {
  readonly emailAddress: string;
  readonly topicName: string;
  readonly renewBefore?: Date;
}

const loadGmailPhysicalWatchStates$ = command(
  async ({ get }, args: GmailPhysicalScopeInput, signal: AbortSignal) => {
    const db = get(db$);
    const states = await db
      .select({
        ...getTableColumns(gmailWatchStates),
        hasConsumer: gmailStateHasEnabledConsumer(),
      })
      .from(gmailWatchStates)
      .where(
        and(
          eq(
            sql`lower(${gmailWatchStates.emailAddress})`,
            normalizeGmailAddress(args.emailAddress),
          ),
          eq(gmailWatchStates.topicName, args.topicName),
        ),
      )
      .orderBy(asc(gmailWatchStates.createdAt), asc(gmailWatchStates.id));
    signal.throwIfAborted();
    return states;
  },
);

const removeInactiveGmailWatchStates$ = command(
  async ({ set }, scope: GmailPhysicalScopeInput, signal: AbortSignal) => {
    const db = set(writeDb$);
    await db
      .delete(gmailWatchStates)
      .where(
        and(
          eq(
            sql`lower(${gmailWatchStates.emailAddress})`,
            normalizeGmailAddress(scope.emailAddress),
          ),
          eq(gmailWatchStates.topicName, scope.topicName),
          sql`NOT ${gmailStateHasEnabledConsumer()}`,
        ),
      );
    signal.throwIfAborted();
  },
);

interface GmailWatchPublicationInput {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly emailAddress: string;
  readonly topicName: string;
  readonly resetCurrentCursor: boolean;
  readonly forceRefresh: boolean;
  readonly allowStagedOfficialTarget: boolean;
  readonly accessToken: string;
}

/** Conditional unique upsert of one mailbox watch for a usable account and live consumer. */
function gmailWatchPublicationSql(
  args: GmailWatchPublicationInput,
  historyId: string,
  expiration: Date,
  currentTime: Date,
) {
  const timestamp = sql`${currentTime.toISOString()}::timestamp`;
  const expiresAt = sql`${expiration.toISOString()}::timestamp`;
  const accountCondition = and(
    eq(connectors.id, args.connectorId),
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.connectorSlug, "gmail"),
    eq(connectors.needsReconnect, false),
    sql`(${connectors.externalEmail} IS NULL OR lower(${connectors.externalEmail}) = ${normalizeGmailAddress(args.emailAddress)})`,
  );
  const consumerCondition = and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.eventConnectorId, args.connectorId),
    sql`(${workflowAutomations.enabled} OR (${args.allowStagedOfficialTarget}
      AND ${workflowAutomations.officialReconciliationStatus} = 'reconciling'
      AND ${workflowAutomations.officialBlueprintKey} IS NOT NULL))`,
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
  );
  const historyUpdate = args.resetCurrentCursor
    ? sql`EXCLUDED.last_history_id`
    : sql`${gmailWatchStates.lastHistoryId}`;
  return sql`INSERT INTO ${gmailWatchStates} (
      org_id, user_id, connector_id, email_address, topic_name,
      last_history_id, watch_expiration_at, last_watch_renewed_at,
      needs_rewatch, created_at, updated_at
    )
    SELECT ${args.orgId}, ${args.userId}, ${args.connectorId}::uuid,
      ${args.emailAddress}, ${args.topicName}, ${historyId}, ${expiresAt},
      ${timestamp}, false, ${timestamp}, ${timestamp}
    WHERE EXISTS (SELECT 1 FROM ${connectors} WHERE ${accountCondition})
      AND EXISTS (SELECT 1 FROM ${workflowAutomations} WHERE ${consumerCondition})
    ON CONFLICT (connector_id, topic_name) DO UPDATE SET
      email_address = EXCLUDED.email_address,
      last_history_id = ${historyUpdate},
      watch_expiration_at = EXCLUDED.watch_expiration_at,
      last_watch_renewed_at = EXCLUDED.last_watch_renewed_at,
      needs_rewatch = false,
      updated_at = EXCLUDED.updated_at
    RETURNING id`;
}

const publishGmailWatch$ = command(
  async (
    { set },
    args: GmailWatchPublicationInput,
    signal: AbortSignal,
  ): Promise<"published" | "inactive" | "failed"> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const [existing] = await db
      .select({
        watchExpirationAt: gmailWatchStates.watchExpirationAt,
        needsRewatch: gmailWatchStates.needsRewatch,
        hasConsumer: gmailStateHasEnabledConsumer(),
      })
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.connectorId, args.connectorId),
          eq(gmailWatchStates.topicName, args.topicName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      existing?.hasConsumer &&
      !args.forceRefresh &&
      !existing.needsRewatch &&
      existing.watchExpirationAt.getTime() >
        currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS
    ) {
      return "published";
    }
    const watchResult = await watchGmailMailbox(
      { accessToken: args.accessToken, topicName: args.topicName },
      signal,
    );
    signal.throwIfAborted();
    if (watchResult.kind !== "ok") {
      return "failed";
    }
    const watch = watchResult.value;
    const expiration = watchExpirationDate(watch.expiration);
    // Rolling-version watch interruptions are accepted. No users.stop,
    // compatibility acquisition or compensating rollout renewal is added.
    return await db.transaction(async (tx) => {
      // The unique upsert publishes only while the account is usable and a
      // consumer is enabled; no source row is locked. The connector FK check
      // protects a new row from a concurrent account delete.
      if (
        (
          await tx.execute(
            gmailWatchPublicationSql(
              args,
              watch.historyId,
              expiration,
              currentTime,
            ),
          )
        ).rowCount === 0
      ) {
        return "inactive";
      }
      await tx
        .update(gmailWatchStates)
        .set({
          watchExpirationAt: expiration,
          lastWatchRenewedAt: currentTime,
          needsRewatch: false,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(
              sql`lower(${gmailWatchStates.emailAddress})`,
              normalizeGmailAddress(args.emailAddress),
            ),
            eq(gmailWatchStates.topicName, args.topicName),
            gmailStateHasEnabledConsumer(),
          ),
        );
      signal.throwIfAborted();
      return "published";
    });
  },
);

export const ensureGmailWatchForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly forceRefresh?: boolean;
      readonly allowStagedOfficialTarget?: boolean;
    },
    signal: AbortSignal,
  ): Promise<EnsureGmailWatchResult> => {
    const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
    if (!topicName) {
      return {
        kind: "bad_request",
        message: "GMAIL_PUBSUB_TOPIC_NAME is not configured",
      };
    }
    const access = await set(resolveGmailAccess$, args, signal);
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      return access;
    }
    let emailAddress = access.access.emailAddress;
    if (!emailAddress) {
      const profile = await fetchGmailProfile(
        access.access.accessToken,
        signal,
      );
      signal.throwIfAborted();
      if (profile.kind !== "ok") {
        return {
          kind: "bad_request",
          message: "Failed to read Gmail profile for event automation setup",
        };
      }
      emailAddress = profile.value.emailAddress;
    }
    const scope = { emailAddress, topicName };
    const published = await set(
      publishGmailWatch$,
      {
        ...args,
        ...scope,
        resetCurrentCursor: args.forceRefresh ?? false,
        forceRefresh: args.forceRefresh ?? false,
        allowStagedOfficialTarget: args.allowStagedOfficialTarget ?? false,
        accessToken: access.access.accessToken,
      },
      signal,
    );
    if (published === "failed") {
      return {
        kind: "bad_request",
        message: "Failed to register Gmail watch for event automation setup",
      };
    }
    if (!args.allowStagedOfficialTarget) {
      await set(removeInactiveGmailWatchStates$, scope, signal);
    }
    return { kind: "ok" };
  },
);

export const reconcileGmailPhysicalScope$ = command(
  async (
    { set },
    args: GmailPhysicalScopeInput,
    signal: AbortSignal,
  ): Promise<GmailWatchReconcileResult> => {
    const states = await set(loadGmailPhysicalWatchStates$, args, signal);
    const active = states.filter((state) => {
      return state.hasConsumer;
    });
    await set(removeInactiveGmailWatchStates$, args, signal);
    if (active.length === 0) {
      return states.length === 0 ? { kind: "unchanged" } : { kind: "stopped" };
    }
    const renewBefore = args.renewBefore;
    if (
      renewBefore === undefined ||
      !active.some((state) => {
        return (
          state.needsRewatch ||
          state.watchExpirationAt.getTime() <= renewBefore.getTime()
        );
      })
    ) {
      return active.length === states.length
        ? { kind: "unchanged" }
        : { kind: "local_removed" };
    }
    let access: GmailAccess | null = null;
    for (const state of active) {
      const result = await set(
        resolveGmailAccess$,
        {
          orgId: state.orgId,
          userId: state.userId,
          connectorId: state.connectorId,
        },
        signal,
      );
      if (result.kind === "ok") {
        access = result.access;
        break;
      }
    }
    if (!access) {
      return { kind: "failed" };
    }
    const connectorId = access.connectorId;
    const source = active.find((state) => {
      return state.connectorId === connectorId;
    });
    if (!source) {
      return { kind: "failed" };
    }
    const published = await set(
      publishGmailWatch$,
      {
        orgId: source.orgId,
        userId: source.userId,
        connectorId: source.connectorId,
        emailAddress: args.emailAddress,
        topicName: args.topicName,
        accessToken: access.accessToken,
        resetCurrentCursor: false,
        forceRefresh: true,
        allowStagedOfficialTarget: false,
      },
      signal,
    );
    return published === "failed"
      ? { kind: "failed" }
      : published === "inactive"
        ? { kind: "unchanged" }
        : { kind: "renewed" };
  },
);

export function gmailPhysicalScopes(
  states: readonly GmailWatchStateRow[],
): readonly { readonly emailAddress: string; readonly topicName: string }[] {
  const scopes = new Map<
    string,
    { readonly emailAddress: string; readonly topicName: string }
  >();
  for (const state of states) {
    scopes.set(
      `${normalizeGmailAddress(state.emailAddress)}\n${state.topicName}`,
      { emailAddress: state.emailAddress, topicName: state.topicName },
    );
  }
  return [...scopes.values()];
}

export const loadEnabledGmailConnectorIds$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const consumers = await db
      .selectDistinct({ connectorId: workflowAutomations.eventConnectorId })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
        ),
      );
    signal.throwIfAborted();
    return consumers.flatMap((consumer) => {
      return consumer.connectorId === null ? [] : [consumer.connectorId];
    });
  },
);

export const repairGmailAutomationProjections$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // One conditional UPDATE computes each target from the current
    // selection and default-account rows; no rows are locked up front. An
    // account change committed after this statement's snapshot is picked
    // up by the next repair run.
    await db.execute(sql`
      WITH candidates AS (
        SELECT ${workflowAutomations.id} AS id,
          CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
            THEN ${chatThreadConnectorSelections.connectorId} ELSE ${connectors.id} END AS desired_connector_id
        FROM ${workflowAutomations}
        LEFT JOIN ${workflowUserAutomationThreads}
          ON ${workflowUserAutomationThreads.orgId} = ${workflowAutomations.orgId}
          AND ${workflowUserAutomationThreads.userId} = ${workflowAutomations.ownerUserId}
          AND ${workflowUserAutomationThreads.workflowId} = ${workflowAutomations.workflowId}
        LEFT JOIN ${chatThreadConnectorSelections}
          ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
          AND ${chatThreadConnectorSelections.connectorSlug} = 'gmail'
        LEFT JOIN ${connectors}
          ON ${connectors.orgId} = ${args.orgId} AND ${connectors.userId} = ${args.userId}
          AND ${connectors.connectorSlug} = 'gmail' AND ${connectors.isDefault}
        WHERE ${workflowAutomations.orgId} = ${args.orgId} AND ${workflowAutomations.ownerUserId} = ${args.userId}
          AND ${workflowAutomations.kind} = 'event' AND ${workflowAutomations.eventType} IN ('gmail-new-message', 'gmail-label-applied')
      )
      UPDATE ${workflowAutomations} SET event_connector_id = candidates.desired_connector_id,
        event_config = CASE WHEN ${workflowAutomations.eventType} = 'gmail-label-applied'
          THEN ${workflowAutomations.eventConfig} - 'resolvedLabelId' ELSE ${workflowAutomations.eventConfig} END
      FROM candidates WHERE ${workflowAutomations.id} = candidates.id
        AND ${workflowAutomations.eventConnectorId} IS DISTINCT FROM candidates.desired_connector_id
    `);
    signal.throwIfAborted();
  },
);

export const reconcileGmailWatchesForUser$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    await set(repairGmailAutomationProjections$, args, signal);
    const connectorIds = await set(loadEnabledGmailConnectorIds$, args, signal);
    let succeeded = true;
    for (const connectorId of connectorIds) {
      const ensured = await set(
        ensureGmailWatchForUser$,
        { ...args, connectorId },
        signal,
      );
      succeeded &&= ensured.kind === "ok";
    }
    const db = get(db$);
    const states = await db
      .select()
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.orgId, args.orgId),
          eq(gmailWatchStates.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    for (const scope of gmailPhysicalScopes(states)) {
      const result = await set(reconcileGmailPhysicalScope$, scope, signal);
      succeeded &&= result.kind !== "failed";
    }
    return succeeded;
  },
);

const gmailLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const gmailLabelsResponseSchema = z.object({
  labels: z.array(gmailLabelSchema).optional(),
});

async function fetchGmailLabels(
  accessToken: string,
  signal: AbortSignal,
): Promise<GmailFetchResult<z.infer<typeof gmailLabelsResponseSchema>>> {
  return await gmailFetchJson(
    gmailLabelsResponseSchema,
    accessToken,
    `${GMAIL_API_BASE}/labels`,
    { method: "GET" },
    signal,
  );
}

export type GmailLabelResolveResult =
  | {
      readonly kind: "ok";
      readonly labelId: string;
      readonly labelName: string;
    }
  | { readonly kind: "bad_request"; readonly message: string };

export async function resolveGmailLabelByName(
  args: {
    readonly accessToken: string;
    readonly labelName: string;
  },
  signal: AbortSignal,
): Promise<GmailLabelResolveResult> {
  const labels = await fetchGmailLabels(args.accessToken, signal);
  signal.throwIfAborted();
  if (labels.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Failed to read Gmail labels",
    };
  }

  const matches = (labels.value.labels ?? []).filter((label) => {
    return label.name === args.labelName;
  });
  if (matches.length === 0) {
    return {
      kind: "bad_request",
      message: `Gmail label not found: ${args.labelName}`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "bad_request",
      message: `Multiple Gmail labels matched name: ${args.labelName}`,
    };
  }

  const label = matches[0]!;
  return { kind: "ok", labelId: label.id, labelName: label.name };
}

export const resolveGmailLabelForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly labelName: string;
    },
    signal: AbortSignal,
  ): Promise<GmailLabelResolveResult> => {
    const accessResult = await set(resolveGmailAccess$, args, signal);
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return accessResult;
    }

    return await resolveGmailLabelByName(
      {
        accessToken: accessResult.access.accessToken,
        labelName: args.labelName,
      },
      signal,
    );
  },
);

export const hasEnabledGmailConsumer$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    const [consumer] = await db
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
          inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return consumer !== undefined;
  },
);
