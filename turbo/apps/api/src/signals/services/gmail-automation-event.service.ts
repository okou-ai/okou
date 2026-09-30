import { Buffer } from "node:buffer";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { OAuth2Client } from "google-auth-library";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type GmailAutomationEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  gmailProcessedEvents,
  gmailWatchStates,
} from "@okouai/db/schema/gmail-event";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { optionalEnv } from "../../lib/env";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$ } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { safeJsonParse, settle, tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadConnectorRuntimeSnapshot$ } from "./connector-catalog-runtime.service";
import { builtinConnectorCredentialRuntimeValueRef } from "./builtin-connector-credential-runtime.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import type { AutomationRow } from "./workflow-automation-launch.service";
import { GmailAutomationSourceChangedError } from "./workflow-gmail-queue.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import {
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
} from "./builtin-connector-credential-command.service";

const log = logger("api:gmail-automation-event");

const GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME = "GMAIL_TOKEN";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const BODY_TEXT_LIMIT = 4000;
const EXCLUDED_INBOUND_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM"] as const;
const GMAIL_EVENT_TYPES = ["gmail-new-message", "gmail-label-applied"] as const;

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatch = NonNullable<GmailMatchRules["subject"]>;

const gmailWatchResponseSchema = z.object({
  historyId: z.string(),
  expiration: z.string(),
});

const gmailProfileResponseSchema = z.object({
  emailAddress: z.string(),
  historyId: z.string().optional(),
});

const gmailLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const gmailLabelsResponseSchema = z.object({
  labels: z.array(gmailLabelSchema).optional(),
});

const gmailHistoryMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

const gmailHistoryResponseSchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().optional(),
        messagesAdded: z
          .array(
            z.object({
              message: gmailHistoryMessageSchema,
            }),
          )
          .optional(),
        labelsAdded: z
          .array(
            z.object({
              message: gmailHistoryMessageSchema,
              labelIds: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().optional(),
});

const gmailMessageHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

interface GmailMessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly z.infer<typeof gmailMessageHeaderSchema>[];
  readonly body?: {
    readonly data?: string;
    readonly attachmentId?: string;
  };
  readonly parts?: readonly GmailMessagePart[];
}

const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() => {
  return z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(gmailMessageHeaderSchema).optional(),
    body: z
      .object({
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(gmailMessagePartSchema).optional(),
  });
});

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: gmailMessagePartSchema.optional(),
});

const pubSubPushSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
  }),
  subscription: z.string().optional(),
});

const gmailPubSubDataSchema = z.object({
  emailAddress: z.string(),
  historyId: z
    .union([z.string(), z.number().int().nonnegative()])
    .transform(String),
});

interface GmailAccess {
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

type GmailWatchStateRow = typeof gmailWatchStates.$inferSelect;

interface GmailFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GmailFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type GmailFetchResult<T> = GmailFetchOk<T> | GmailFetchError;

interface GmailHistoryMessageAdded {
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
}

interface GmailHistoryLabelAdded {
  readonly historyId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
}

type GmailHistoryMessageEvent =
  | GmailHistoryMessageAdded
  | GmailHistoryLabelAdded;

interface GmailMessageContext {
  readonly messageId: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
  readonly occurredAt: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
  readonly bodyText: string | null;
}

type GmailHistoryResult =
  | {
      readonly kind: "ok";
      readonly messagesAdded: readonly GmailHistoryMessageAdded[];
      readonly labelsAdded: readonly GmailHistoryLabelAdded[];
    }
  | { readonly kind: "stale_cursor" }
  | { readonly kind: "gmail_error"; readonly message: string };

interface PubSubOidcClaims {
  readonly email: string | null;
  readonly emailVerified: boolean;
}

type PubSubOidcVerifier = (
  token: string,
  audience: string,
  signal: AbortSignal,
) => Promise<PubSubOidcClaims>;

const pubSubOidcVerifierOverride = testOverride<PubSubOidcVerifier | undefined>(
  () => {
    return undefined;
  },
);

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

const resolveGmailAccess$ = command(
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
    const snapshot = await set(loadConnectorRuntimeSnapshot$, signal);
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

async function gmailFetchJson<T>(
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

type GmailLabelResolveResult =
  | {
      readonly kind: "ok";
      readonly labelId: string;
      readonly labelName: string;
    }
  | { readonly kind: "bad_request"; readonly message: string };

async function resolveGmailLabelByName(
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

function normalizeGmailAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

export const hasEnabledGmailConsumer$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
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
  async ({ set }, args: GmailPhysicalScopeInput, signal: AbortSignal) => {
    const db = set(writeDb$);
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

const reconcileGmailPhysicalScope$ = command(
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

function gmailPhysicalScopes(
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

const renewGmailPhysicalScopes$ = command(
  async (
    { set },
    args: {
      readonly scopes: readonly {
        readonly emailAddress: string;
        readonly topicName: string;
      }[];
      readonly renewBefore: Date;
    },
    signal: AbortSignal,
  ): Promise<{ readonly renewed: number; readonly failed: number }> => {
    let renewed = 0;
    let failed = 0;
    for (const scope of args.scopes) {
      const result = await set(
        reconcileGmailPhysicalScope$,
        { ...scope, renewBefore: args.renewBefore },
        signal,
      );
      renewed += result.kind === "renewed" ? 1 : 0;
      failed += result.kind === "failed" ? 1 : 0;
    }
    return { renewed, failed };
  },
);

const loadEnabledGmailConnectorIds$ = command(
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

const repairGmailAutomationProjections$ = command(
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
    { set },
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
    const db = set(writeDb$);
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

async function listGmailHistory(
  args: {
    readonly accessToken: string;
    readonly startHistoryId: string;
  },
  signal: AbortSignal,
): Promise<GmailHistoryResult> {
  let pageToken: string | null = null;
  const messagesAdded: GmailHistoryMessageAdded[] = [];
  const labelsAdded: GmailHistoryLabelAdded[] = [];

  do {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set("startHistoryId", args.startHistoryId);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const result = await gmailFetchJson(
      gmailHistoryResponseSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind !== "ok") {
      return result.status === 404
        ? { kind: "stale_cursor" }
        : { kind: "gmail_error", message: result.message };
    }

    for (const history of result.value.history ?? []) {
      for (const added of history.messagesAdded ?? []) {
        messagesAdded.push({
          historyId: history.id ?? args.startHistoryId,
          messageId: added.message.id,
          threadId: added.message.threadId ?? null,
          labelIds: added.message.labelIds ?? [],
        });
      }
      for (const added of history.labelsAdded ?? []) {
        labelsAdded.push({
          historyId: history.id ?? args.startHistoryId,
          messageId: added.message.id,
          threadId: added.message.threadId ?? null,
          labelIds:
            added.labelIds && added.labelIds.length > 0
              ? added.labelIds
              : (added.message.labelIds ?? []),
        });
      }
    }
    pageToken = result.value.nextPageToken ?? null;
  } while (pageToken);

  return { kind: "ok", messagesAdded, labelsAdded };
}

function headerValues(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): readonly string[] {
  return headers
    .filter((candidate) => {
      return candidate.name.toLowerCase() === name.toLowerCase();
    })
    .map((candidate) => {
      return candidate.value;
    });
}

function firstHeaderValue(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function gmailMessageOccurredAt(
  internalDate: string | undefined,
): string | null {
  if (internalDate) {
    const millis = Number(internalDate);
    if (Number.isFinite(millis)) {
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  return null;
}

function decodeGmailBodyData(data: string): string {
  return Buffer.from(
    data.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  ).toString("utf8");
}

function collectBodyText(part: GmailMessagePart | undefined): string {
  if (!part) {
    return "";
  }
  const ownText =
    part.body?.data &&
    (part.mimeType === "text/plain" || part.mimeType === "text/html")
      ? decodeGmailBodyData(part.body.data)
      : "";
  const childText = (part.parts ?? [])
    .map((child) => {
      return collectBodyText(child);
    })
    .filter((text) => {
      return text.length > 0;
    })
    .join("\n");
  return [ownText, childText]
    .filter((text) => {
      return text.length > 0;
    })
    .join("\n");
}

function messageIsInbound(message: GmailMessageContext): boolean {
  const labels = new Set(message.labelIds);
  if (!labels.has("INBOX")) {
    return false;
  }
  return !EXCLUDED_INBOUND_LABELS.some((label) => {
    return labels.has(label);
  });
}

async function fetchGmailMessageContext(
  args: {
    readonly accessToken: string;
    readonly event: GmailHistoryMessageEvent;
  },
  signal: AbortSignal,
): Promise<GmailMessageContext | null> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${args.event.messageId}`);
  url.searchParams.set("format", "full");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "To");
  url.searchParams.append("metadataHeaders", "Cc");
  url.searchParams.append("metadataHeaders", "Subject");

  const result = await gmailFetchJson(
    gmailMessageSchema,
    args.accessToken,
    url.toString(),
    { method: "GET" },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind !== "ok") {
    return null;
  }

  const headers = result.value.payload?.headers ?? [];
  const bodyText = collectBodyText(result.value.payload).slice(
    0,
    BODY_TEXT_LIMIT,
  );
  return {
    messageId: result.value.id,
    threadId: result.value.threadId ?? null,
    labelIds: result.value.labelIds ?? [],
    occurredAt: gmailMessageOccurredAt(result.value.internalDate),
    from: firstHeaderValue(headers, "From"),
    to: headerValues(headers, "To"),
    cc: headerValues(headers, "Cc"),
    subject: firstHeaderValue(headers, "Subject"),
    bodyText: bodyText.length > 0 ? bodyText : null,
  };
}

function includesIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function textMatches(value: string | null, matcher: GmailTextMatch): boolean {
  const text = value ?? "";
  if (matcher.contains && !includesIgnoreCase(text, matcher.contains)) {
    return false;
  }
  if (
    matcher.containsAny &&
    !matcher.containsAny.some((needle) => {
      return includesIgnoreCase(text, needle);
    })
  ) {
    return false;
  }
  if (
    matcher.doesNotContain &&
    includesIgnoreCase(text, matcher.doesNotContain)
  ) {
    return false;
  }
  if (
    matcher.doesNotContainAny?.some((needle) => {
      return includesIgnoreCase(text, needle);
    })
  ) {
    return false;
  }
  return true;
}

function gmailMessageMatchesConfig(
  message: GmailMessageContext,
  config: GmailNewMessageEventConfig,
): boolean {
  if (config.threadId && message.threadId !== config.threadId) {
    return false;
  }
  const match = config.match;
  if (!match) {
    return true;
  }
  if (match.from && !textMatches(message.from, match.from)) {
    return false;
  }
  if (match.subject && !textMatches(message.subject, match.subject)) {
    return false;
  }
  if (match.body && !textMatches(message.bodyText, match.body)) {
    return false;
  }
  if (match.to && !textMatches(message.to.join(", "), match.to)) {
    return false;
  }
  if (match.cc && !textMatches(message.cc.join(", "), match.cc)) {
    return false;
  }
  return true;
}

async function defaultPubSubOidcVerifier(
  token: string,
  audience: string,
  signal: AbortSignal,
): Promise<PubSubOidcClaims> {
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token, audience });
  signal.throwIfAborted();
  const payload = ticket.getPayload();
  return {
    email: payload?.email ?? null,
    emailVerified: payload?.email_verified === true,
  };
}

async function verifyPubSubOidc(
  args: {
    readonly authorization: string | null;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "config_error"; readonly message: string }
> {
  const audience = optionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE");
  const expectedEmail = optionalEnv("GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL");
  if (!audience || !expectedEmail) {
    return {
      kind: "config_error",
      message: "Gmail Pub/Sub push OIDC env vars are not configured",
    };
  }

  if (!args.authorization?.startsWith("Bearer ")) {
    return { kind: "unauthorized" };
  }

  const token = args.authorization.slice("Bearer ".length);
  const verifier =
    pubSubOidcVerifierOverride.get() ?? defaultPubSubOidcVerifier;
  const claims = await tapError(verifier(token, audience, signal));
  signal.throwIfAborted();
  if (!claims) {
    return { kind: "unauthorized" };
  }

  return claims.email === expectedEmail && claims.emailVerified
    ? { kind: "ok" }
    : { kind: "unauthorized" };
}

function decodePubSubPush(rawBody: string):
  | {
      readonly kind: "ok";
      readonly messageId: string;
      readonly emailAddress: string;
      readonly historyId: string;
    }
  | { readonly kind: "bad_request"; readonly message: string } {
  const rawPush = safeJsonParse(rawBody);
  if (rawPush === undefined) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  const push = pubSubPushSchema.safeParse(rawPush);
  if (!push.success) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  const decoded = Buffer.from(push.data.message.data, "base64").toString(
    "utf8",
  );
  const rawData = safeJsonParse(decoded);
  if (rawData === undefined) {
    return { kind: "bad_request", message: "Invalid Gmail Pub/Sub data" };
  }
  const data = gmailPubSubDataSchema.safeParse(rawData);
  if (!data.success) {
    return { kind: "bad_request", message: "Invalid Gmail Pub/Sub data" };
  }
  return {
    kind: "ok",
    messageId: push.data.message.messageId,
    emailAddress: data.data.emailAddress,
    historyId: data.data.historyId,
  };
}

type GmailPubSubPushResult =
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

type DecodedGmailPubSubPush = Extract<
  ReturnType<typeof decodePubSubPush>,
  { readonly kind: "ok" }
>;

interface GmailEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GmailAutomationEventConfig;
}

type GmailLabelEventAutomationRow = GmailEventAutomationRow & {
  readonly config: GmailLabelAppliedEventConfig;
};

interface GmailWorkflowRunStartTestInput {
  readonly automationId: string;
  readonly workflowName: string;
  readonly emailAddress: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly subject: string | null;
  readonly triggerBrief: string;
}

type GmailRunStarterTestOverride = (
  args: GmailWorkflowRunStartTestInput,
) => Promise<"ok" | "error">;

const gmailRunStarterOverride = testOverride<
  GmailRunStarterTestOverride | undefined
>(() => {
  return undefined;
});

type GmailDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
      readonly needsRewatch?: boolean;
    }
  | { readonly kind: "run_error"; readonly message: string };

const loadGmailWatchStates$ = command(
  async (
    { set },
    args: {
      readonly decoded: DecodedGmailPubSubPush;
      readonly topicName: string;
    },
    signal: AbortSignal,
  ): Promise<GmailWatchStateRow[]> => {
    const db = set(writeDb$);
    const states = await db
      .select()
      .from(gmailWatchStates)
      .where(
        and(
          eq(
            sql`lower(${gmailWatchStates.emailAddress})`,
            normalizeGmailAddress(args.decoded.emailAddress),
          ),
          eq(gmailWatchStates.topicName, args.topicName),
        ),
      );
    signal.throwIfAborted();

    return states;
  },
);

const loadGmailEventAutomations$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
    },
    signal: AbortSignal,
  ): Promise<GmailEventAutomationRow[]> => {
    const db = set(writeDb$);
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
          eq(workflowAutomations.eventConnectorId, args.state.connectorId),
          inArray(workflowAutomations.eventType, [
            "gmail-new-message",
            "gmail-label-applied",
          ]),
        ),
      );
    signal.throwIfAborted();

    const currentTime = nowDate();
    const automations: GmailEventAutomationRow[] = [];
    for (const row of automationRows) {
      const config =
        row.automation.eventType === "gmail-label-applied"
          ? gmailLabelAppliedEventConfigSchema.safeParse(
              row.automation.eventConfig,
            )
          : gmailNewMessageEventConfigSchema.safeParse(
              row.automation.eventConfig,
            );
      if (!config.success) {
        continue;
      }
      const canFire = await set(
        workflowAutomationCanFire$,
        {
          automation: row.automation,
          agentId: row.agentId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!canFire) {
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
        chatThreadId,
        config: config.data,
      });
    }
    return automations;
  },
);

async function cachedGmailMessageContext(
  args: {
    readonly cache: Map<string, GmailMessageContext | null>;
    readonly accessToken: string;
    readonly event: GmailHistoryMessageEvent;
  },
  signal: AbortSignal,
): Promise<GmailMessageContext | null> {
  const cached = args.cache.get(args.event.messageId);
  if (cached !== undefined) {
    return cached;
  }

  const message = await fetchGmailMessageContext(
    {
      accessToken: args.accessToken,
      event: args.event,
    },
    signal,
  );
  signal.throwIfAborted();
  args.cache.set(args.event.messageId, message);

  return message;
}

const insertGmailProcessedEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly automation: GmailEventAutomationRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly event: GmailHistoryMessageEvent;
      readonly message: GmailMessageContext;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "inserted"; readonly id: string }
    | { readonly kind: "duplicate" }
    | { readonly kind: "stale_source" }
  > => {
    const db = set(writeDb$);
    // No row lock: the receipt's FK checks on the watch state and automation
    // are the implicit protection. A source removed concurrently surfaces as
    // a FK violation and maps to the same deterministic stale_source result.
    const [currentState] = await db
      .select({ id: gmailWatchStates.id })
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.id, args.state.id),
          eq(gmailWatchStates.connectorId, args.state.connectorId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!currentState) {
      return { kind: "stale_source" };
    }
    const inserted = await settle(
      db
        .insert(gmailProcessedEvents)
        .values({
          watchStateId: args.state.id,
          automationId: args.automation.automation.id,
          pubsubMessageId: args.decoded.messageId,
          historyId: args.event.historyId,
          messageId: args.event.messageId,
          threadId: args.message.threadId,
          createdAt: nowDate(),
        })
        .onConflictDoNothing()
        .returning({ id: gmailProcessedEvents.id }),
      signal,
    );
    if (!inserted.ok) {
      if (isForeignKeyViolation(inserted.error)) {
        return { kind: "stale_source" };
      }
      throw inserted.error;
    }
    const [processed] = inserted.value;
    return processed
      ? { kind: "inserted", id: processed.id }
      : { kind: "duplicate" };
  },
);

function gmailTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly automationConfig: GmailAutomationEventConfig;
  readonly emailAddress: string;
  readonly message: GmailMessageContext;
}): WorkflowAutomationContext {
  const matched =
    args.automationConfig.event === "label_applied"
      ? `Gmail label "${args.automationConfig.labelName}" was applied to a message`
      : "a new inbound Gmail message arrived";
  return {
    workflowName: args.workflowName,
    eventType:
      args.automationConfig.event === "label_applied"
        ? "gmail-label-applied"
        : "gmail-new-message",
    trigger: `${matched} on ${args.emailAddress} (Gmail message ${args.message.messageId}).`,
    notes: [
      "Not included below: the email body. Connected Gmail tools return the message and thread content.",
      "Sending is a user action. This automation prepares drafts; the user sends them.",
    ],
    event: {
      automationId: args.automationId,
      event: args.automationConfig.event,
      labelName:
        args.automationConfig.event === "label_applied"
          ? args.automationConfig.labelName
          : undefined,
      emailAddress: args.emailAddress,
      messageId: args.message.messageId,
      threadId: args.message.threadId,
      from: args.message.from,
      to: args.message.to,
      cc: args.message.cc,
      subject: args.message.subject,
    },
  };
}

function buildGmailWorkflowAutomationBrief(args: {
  readonly automationConfig: GmailAutomationEventConfig;
  readonly message: {
    readonly messageId: string;
    readonly threadId: string | null;
    readonly from: string | null;
    readonly subject: string | null;
  };
}): string {
  const title =
    args.automationConfig.event === "label_applied"
      ? `Gmail label applied: ${args.automationConfig.labelName}`
      : "Gmail new message";
  return [
    title,
    `From: ${args.message.from?.trim() || "Unknown sender"}`,
    `Subject: ${args.message.subject?.trim() || "(no subject)"}`,
  ].join("\n");
}

const dispatchGmailAutomationEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly automation: GmailEventAutomationRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly event: GmailHistoryMessageAdded;
      readonly message: GmailMessageContext;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<
    "dispatched" | "duplicate" | "skipped" | { readonly kind: "run_error" }
  > => {
    const db = set(writeDb$);
    const processed = await args.timing.measure(
      "api_dispatch_pre_create_agent_automation_event_record_processed_event",
      async () => {
        return await set(insertGmailProcessedEvent$, args, signal);
      },
    );
    signal.throwIfAborted();
    if (processed.kind === "stale_source") {
      return "skipped";
    }
    if (processed.kind === "duplicate") {
      return "duplicate";
    }
    const processedId = processed.id;

    const result = await set(
      startGmailWorkflowRun$,
      {
        automation: args.automation,
        connectorSourceId: args.state.connectorId,
        watchStateId: args.state.id,
        decoded: args.decoded,
        message: args.message,
        timing: args.timing,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result === "superseded") {
      await db
        .delete(gmailProcessedEvents)
        .where(eq(gmailProcessedEvents.id, processedId));
      signal.throwIfAborted();
      return "skipped";
    }
    if (result !== "ok") {
      await db
        .delete(gmailProcessedEvents)
        .where(eq(gmailProcessedEvents.id, processedId));
      signal.throwIfAborted();
      return { kind: "run_error" };
    }

    return "dispatched";
  },
);

function isGmailNewMessageAutomation(
  automation: GmailEventAutomationRow,
): automation is GmailEventAutomationRow & {
  readonly config: GmailNewMessageEventConfig;
} {
  return automation.config.event === "new_message";
}

function isGmailLabelAppliedAutomation(
  automation: GmailEventAutomationRow,
): automation is GmailEventAutomationRow & {
  readonly config: GmailLabelAppliedEventConfig;
} {
  return automation.config.event === "label_applied";
}

const updateResolvedGmailLabelId$ = command(
  async (
    { set },
    args: {
      readonly automation: GmailLabelEventAutomationRow;
      readonly connectorId: string;
      readonly watchStateId: string;
      readonly labelId: string;
    },
    signal: AbortSignal,
  ): Promise<GmailLabelEventAutomationRow | null> => {
    const db = set(writeDb$);
    if (args.automation.config.resolvedLabelId === args.labelId) {
      return args.automation;
    }
    const config: GmailLabelAppliedEventConfig = {
      ...args.automation.config,
      resolvedLabelId: args.labelId,
    };
    // One conditional UPDATE is the whole arbitration: watch removal,
    // reprojection or a user config change makes this publication a no-op.
    const [automation] = await db
      .update(workflowAutomations)
      .set({
        eventConfig: config,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(workflowAutomations.id, args.automation.automation.id),
          eq(workflowAutomations.orgId, args.automation.automation.orgId),
          eq(
            workflowAutomations.ownerUserId,
            args.automation.automation.ownerUserId,
          ),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.eventType, "gmail-label-applied"),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
          exists(
            db
              .select({ id: gmailWatchStates.id })
              .from(gmailWatchStates)
              .where(
                and(
                  eq(gmailWatchStates.id, args.watchStateId),
                  eq(gmailWatchStates.connectorId, args.connectorId),
                ),
              ),
          ),
          // Another notification can already have published this same label.
          // A different user configuration must never be overwritten.
          or(
            sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(args.automation.automation.eventConfig)}::jsonb`,
            eq(workflowAutomations.eventConfig, config),
          ),
        ),
      )
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    return automation ? { ...args.automation, automation, config } : null;
  },
);

const matchGmailLabelAutomation$ = command(
  async (
    { set },
    args: {
      readonly accessToken: string;
      readonly connectorId: string;
      readonly watchStateId: string;
      readonly automation: GmailLabelEventAutomationRow;
      readonly event: GmailHistoryLabelAdded;
      readonly labelCache: Map<string, GmailLabelResolveResult>;
    },
    signal: AbortSignal,
  ): Promise<GmailLabelEventAutomationRow | null> => {
    const eventLabelIds = new Set(args.event.labelIds);
    const resolvedLabelId = args.automation.config.resolvedLabelId;
    if (resolvedLabelId && eventLabelIds.has(resolvedLabelId)) {
      return args.automation;
    }

    const labelName = args.automation.config.labelName;
    const cached = args.labelCache.get(labelName);
    const label =
      cached ??
      (await resolveGmailLabelByName(
        {
          accessToken: args.accessToken,
          labelName,
        },
        signal,
      ));
    signal.throwIfAborted();
    if (!cached) {
      args.labelCache.set(labelName, label);
    }
    if (label.kind !== "ok") {
      log.warn("Gmail label event skipped because label lookup failed", {
        automationId: args.automation.automation.id,
        labelName,
        message: label.message,
      });
      return null;
    }
    if (!eventLabelIds.has(label.labelId)) {
      return null;
    }

    return await set(
      updateResolvedGmailLabelId$,
      {
        automation: args.automation,
        connectorId: args.connectorId,
        watchStateId: args.watchStateId,
        labelId: label.labelId,
      },
      signal,
    );
  },
);

const dispatchGmailNewMessageHistoryEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly accessToken: string;
      readonly automations: readonly GmailEventAutomationRow[];
      readonly event: GmailHistoryMessageAdded;
      readonly messageCache: Map<string, GmailMessageContext | null>;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailDispatchStateResult> => {
    const message = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_external_events",
      async () => {
        return await cachedGmailMessageContext(
          {
            cache: args.messageCache,
            accessToken: args.accessToken,
            event: args.event,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (!message || !messageIsInbound(message)) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    let dispatched = 0;
    let duplicates = 0;

    for (const automation of args.automations) {
      const runTiming = args.sourceTiming.createRunTiming();
      const matches = await runTiming.measure(
        "api_dispatch_pre_create_agent_automation_event_match_automations",
        () => {
          return (
            isGmailNewMessageAutomation(automation) &&
            gmailMessageMatchesConfig(message, automation.config)
          );
        },
      );
      signal.throwIfAborted();
      if (!matches) {
        continue;
      }
      const result = await set(
        dispatchGmailAutomationEvent$,
        {
          state: args.state,
          automation,
          decoded: args.decoded,
          event: args.event,
          message,
          timing: runTiming,
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
      if (typeof result !== "string") {
        return {
          kind: "run_error",
          message: "Failed to start Gmail event workflow run",
        };
      }
      dispatched += result === "dispatched" ? 1 : 0;
      duplicates += result === "duplicate" ? 1 : 0;
    }

    return { kind: "ok", dispatched, duplicates };
  },
);

const dispatchGmailLabelAppliedHistoryEvent$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly accessToken: string;
      readonly automations: readonly GmailEventAutomationRow[];
      readonly event: GmailHistoryLabelAdded;
      readonly messageCache: Map<string, GmailMessageContext | null>;
      readonly labelCache: Map<string, GmailLabelResolveResult>;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailDispatchStateResult> => {
    const labelAutomations = args.automations.filter(
      isGmailLabelAppliedAutomation,
    );
    if (labelAutomations.length === 0 || args.event.labelIds.length === 0) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const matchingAutomations: {
      readonly automation: (typeof labelAutomations)[number];
      readonly timing: AutomationEventRunTiming;
    }[] = [];
    for (const automation of labelAutomations) {
      const runTiming = args.sourceTiming.createRunTiming();
      const matched = await runTiming.measure(
        "api_dispatch_pre_create_agent_automation_event_match_automations",
        async () => {
          return await set(
            matchGmailLabelAutomation$,
            {
              accessToken: args.accessToken,
              connectorId: args.state.connectorId,
              watchStateId: args.state.id,
              automation,
              event: args.event,
              labelCache: args.labelCache,
            },
            signal,
          );
        },
      );
      signal.throwIfAborted();
      if (matched) {
        matchingAutomations.push({ automation: matched, timing: runTiming });
      }
    }
    if (matchingAutomations.length === 0) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const messageStartedAt = now();
    const message = await cachedGmailMessageContext(
      {
        cache: args.messageCache,
        accessToken: args.accessToken,
        event: args.event,
      },
      signal,
    );
    const messageFinishedAt = now();
    if (!message) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    let dispatched = 0;
    let duplicates = 0;

    for (const match of matchingAutomations) {
      match.timing.recordElapsed(
        "api_dispatch_pre_create_agent_automation_event_load_external_events",
        messageStartedAt,
        messageFinishedAt,
      );
      const result = await set(
        dispatchGmailAutomationEvent$,
        {
          state: args.state,
          automation: match.automation,
          decoded: args.decoded,
          event: args.event,
          message,
          timing: match.timing,
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
      if (typeof result !== "string") {
        return {
          kind: "run_error",
          message: "Failed to start Gmail event workflow run",
        };
      }
      dispatched += result === "dispatched" ? 1 : 0;
      duplicates += result === "duplicate" ? 1 : 0;
    }

    return { kind: "ok", dispatched, duplicates };
  },
);

const dispatchGmailHistoryEvents$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly decoded: DecodedGmailPubSubPush;
      readonly accessToken: string;
      readonly history: Extract<
        GmailHistoryResult,
        {
          readonly kind: "ok";
        }
      >;
      readonly automations: readonly GmailEventAutomationRow[];
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailDispatchStateResult> => {
    const messageCache = new Map<string, GmailMessageContext | null>();
    const labelCache = new Map<string, GmailLabelResolveResult>();
    let dispatched = 0;
    let duplicates = 0;

    for (const event of args.history.messagesAdded) {
      const result = await set(
        dispatchGmailNewMessageHistoryEvent$,
        {
          state: args.state,
          decoded: args.decoded,
          accessToken: args.accessToken,
          automations: args.automations,
          event,
          messageCache,
          sourceTiming: args.sourceTiming.fork(),
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
      if (result.kind !== "ok") {
        return result;
      }
      dispatched += result.dispatched;
      duplicates += result.duplicates;
    }

    for (const event of args.history.labelsAdded) {
      const result = await set(
        dispatchGmailLabelAppliedHistoryEvent$,
        {
          state: args.state,
          decoded: args.decoded,
          accessToken: args.accessToken,
          automations: args.automations,
          event,
          messageCache,
          labelCache,
          sourceTiming: args.sourceTiming.fork(),
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
      if (result.kind !== "ok") {
        return result;
      }
      dispatched += result.dispatched;
      duplicates += result.duplicates;
    }

    return { kind: "ok", dispatched, duplicates };
  },
);

const loadGmailDispatchAccess$ = command(
  async (
    { set },
    state: GmailWatchStateRow,
    signal: AbortSignal,
  ): Promise<GmailAccess | null> => {
    const owner = {
      orgId: state.orgId,
      userId: state.userId,
      connectorId: state.connectorId,
    };
    await set(repairGmailAutomationProjections$, owner, signal);
    const hasConsumer = await set(hasEnabledGmailConsumer$, owner, signal);
    if (!hasConsumer) {
      return null;
    }
    const access = await set(resolveGmailAccess$, owner, signal);
    return access.kind === "ok" ? access.access : null;
  },
);

const dispatchGmailWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly access: GmailAccess | null;
      readonly decoded: DecodedGmailPubSubPush;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailDispatchStateResult> => {
    const db = set(writeDb$);
    const access = args.access;
    if (!access) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const history = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_external_events",
      async () => {
        return await listGmailHistory(
          {
            accessToken: access.accessToken,
            startHistoryId: args.state.lastHistoryId,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (history.kind === "stale_cursor") {
      return { kind: "ok", dispatched: 0, duplicates: 0, needsRewatch: true };
    }
    if (history.kind === "gmail_error") {
      log.warn("Gmail history lookup failed", {
        watchStateId: args.state.id,
        message: history.message,
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const automations = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_automations",
      async () => {
        return await set(loadGmailEventAutomations$, args, signal);
      },
    );
    signal.throwIfAborted();
    const result = await set(
      dispatchGmailHistoryEvents$,
      {
        state: args.state,
        decoded: args.decoded,
        accessToken: access.accessToken,
        history,
        automations,
        sourceTiming: args.sourceTiming,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    if (result.kind !== "ok") {
      return result;
    }

    await db
      .update(gmailWatchStates)
      .set({
        lastHistoryId: args.decoded.historyId,
        needsRewatch: false,
        updatedAt: nowDate(),
      })
      .where(eq(gmailWatchStates.id, args.state.id));
    signal.throwIfAborted();

    return result;
  },
);

const startGmailWorkflowRun$ = command(
  async (
    { set },
    args: {
      readonly automation: GmailEventAutomationRow;
      readonly connectorSourceId: string;
      readonly watchStateId: string;
      readonly decoded: DecodedGmailPubSubPush;
      readonly message: GmailMessageContext;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error" | "superseded"> => {
    const runStarterOverride = gmailRunStarterOverride.get();
    if (runStarterOverride) {
      return await runStarterOverride({
        automationId: args.automation.automation.id,
        workflowName: args.automation.workflowName,
        emailAddress: args.decoded.emailAddress,
        messageId: args.message.messageId,
        threadId: args.message.threadId,
        subject: args.message.subject,
        triggerBrief: buildGmailWorkflowAutomationBrief({
          automationConfig: args.automation.config,
          message: args.message,
        }),
      });
    }
    const runInput = await args.timing.measure(
      "api_dispatch_pre_create_agent_automation_event_build_run_input",
      () => {
        const context = gmailTriggerContext({
          workflowName: args.automation.workflowName,
          automationId: args.automation.automation.id,
          automationConfig: args.automation.config,
          emailAddress: args.decoded.emailAddress,
          message: args.message,
        });
        return {
          context,
          triggerBrief: buildGmailWorkflowAutomationBrief({
            automationConfig: args.automation.config,
            message: args.message,
          }),
        };
      },
    );
    signal.throwIfAborted();
    const started = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: args.automation.automation,
            agentId: args.automation.agentId,
            chatThreadId: args.automation.chatThreadId,
          },
          automationContext: runInput.context,
          connectorSourceId: args.connectorSourceId,
          apiStartTime: args.apiStartTime,
          triggerSource: "automation-event",
          triggerBrief: runInput.triggerBrief,
          gmailSource: {
            automationId: args.automation.automation.id,
            orgId: args.automation.automation.orgId,
            userId: args.automation.automation.ownerUserId,
            connectorId: args.connectorSourceId,
            watchStateId: args.watchStateId,
            emailAddress: args.decoded.emailAddress,
            eventConfig: args.automation.automation.eventConfig,
          },
          timing: args.timing.collectorForRunStart(),
        },
        signal,
      ),
      signal,
    );
    if (!started.ok) {
      if (started.error instanceof GmailAutomationSourceChangedError) {
        return "superseded";
      }
      throw started.error;
    }
    return "ok";
  },
);

const repairRequestedGmailWatch$ = command(
  async (
    { set },
    args: {
      readonly state: GmailWatchStateRow;
      readonly needsRewatch: boolean;
    },
    signal: AbortSignal,
  ) => {
    if (args.needsRewatch) {
      await set(
        ensureGmailWatchForUser$,
        {
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
          forceRefresh: true,
        },
        signal,
      );
    }
  },
);

export const dispatchGmailPubSubPush$ = command(
  async (
    { set },
    args: {
      readonly authorization: string | null;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GmailPubSubPushResult> => {
    const auth = await verifyPubSubOidc(
      {
        authorization: args.authorization,
      },
      signal,
    );
    signal.throwIfAborted();
    if (auth.kind !== "ok") {
      return auth;
    }

    const decoded = decodePubSubPush(args.rawBody);
    if (decoded.kind !== "ok") {
      return decoded;
    }

    const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
    if (!topicName) {
      return {
        kind: "config_error",
        message: "GMAIL_PUBSUB_TOPIC_NAME is not configured",
      };
    }

    const sourceTiming = new AutomationEventSourceTiming(
      "gmail",
      args.apiStartTime,
    );
    const states = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await set(
          loadGmailWatchStates$,
          {
            decoded,
            topicName,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    let dispatched = 0;
    let duplicates = 0;

    for (const state of states) {
      const access = await set(loadGmailDispatchAccess$, state, signal);
      const result = await set(
        dispatchGmailWatchState$,
        {
          state,
          access,
          decoded,
          sourceTiming: sourceTiming.fork(),
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
      if (result.kind !== "ok") {
        return result;
      }
      await set(
        repairRequestedGmailWatch$,
        { state, needsRewatch: result.needsRewatch === true },
        signal,
      );
      dispatched += result.dispatched;
      duplicates += result.duplicates;
    }

    return {
      kind: "ok",
      watchStates: states.length,
      dispatched,
      duplicates,
    };
  },
);

export const renewGmailWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [automationOwners, stateOwners] = await Promise.all([
      db
        .selectDistinct({
          orgId: workflowAutomations.orgId,
          userId: workflowAutomations.ownerUserId,
        })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.kind, "event"),
            eq(workflowAutomations.enabled, true),
            inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
          ),
        ),
      db
        .selectDistinct({
          orgId: gmailWatchStates.orgId,
          userId: gmailWatchStates.userId,
        })
        .from(gmailWatchStates),
    ]);
    signal.throwIfAborted();
    const owners = new Map<
      string,
      { readonly orgId: string; readonly userId: string }
    >();
    for (const owner of [...automationOwners, ...stateOwners]) {
      owners.set(`${owner.orgId}\n${owner.userId}`, owner);
    }

    let repairFailures = 0;
    for (const owner of owners.values()) {
      await set(repairGmailAutomationProjections$, owner, signal);
      signal.throwIfAborted();
      const [connectorIds, states] = await Promise.all([
        set(loadEnabledGmailConnectorIds$, owner, signal),
        db
          .select({ connectorId: gmailWatchStates.connectorId })
          .from(gmailWatchStates)
          .where(
            and(
              eq(gmailWatchStates.orgId, owner.orgId),
              eq(gmailWatchStates.userId, owner.userId),
            ),
          ),
      ]);
      signal.throwIfAborted();
      const watchedConnectorIds = new Set(
        states.map((state) => {
          return state.connectorId;
        }),
      );
      for (const connectorId of connectorIds) {
        if (watchedConnectorIds.has(connectorId)) {
          continue;
        }
        const result = await set(
          ensureGmailWatchForUser$,
          { ...owner, connectorId },
          signal,
        );
        signal.throwIfAborted();
        repairFailures += result.kind === "ok" ? 0 : 1;
      }
    }

    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS,
    );
    const states = await db.select().from(gmailWatchStates);
    signal.throwIfAborted();
    const renewed = await set(
      renewGmailPhysicalScopes$,
      { scopes: gmailPhysicalScopes(states), renewBefore },
      signal,
    );
    return {
      renewed: renewed.renewed,
      failed: renewed.failed + repairFailures,
    };
  },
);

export const renewGmailWatchScope$ = command(
  async (
    { set },
    emailAddress: string,
    topicName: string,
    signal: AbortSignal,
  ) => {
    const currentTime = nowDate();
    return await set(
      renewGmailPhysicalScopes$,
      {
        scopes: [{ emailAddress, topicName }],
        renewBefore: new Date(currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS),
      },
      signal,
    );
  },
);
