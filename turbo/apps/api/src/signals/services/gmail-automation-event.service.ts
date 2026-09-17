import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { command } from "ccstate";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { safeJsonParse, settle, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import type { AutomationRow } from "./workflow-automation-launch.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import { reprojectGmailAutomationsForOwner } from "./gmail-automation-account.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";

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

export interface PendingGmailWatchStop {
  readonly accessToken: string;
  readonly scopes: readonly {
    readonly emailAddress: string;
    readonly topicName: string;
  }[];
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

async function resolveGmailAccess(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly refreshExpiredToken?: boolean;
  },
  signal: AbortSignal,
): Promise<GmailAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
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
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    connection,
    GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      kind: "bad_request",
      message: "Reconnect Gmail before using Gmail event automations",
    };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
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
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
      persist: { db: args.db, markNeedsReconnectOnFailure: true },
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
}

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

async function gmailFetchNoContent(
  args: {
    readonly accessToken: string;
    readonly url: string;
    readonly init: RequestInit;
  },
  signal: AbortSignal,
): Promise<GmailFetchResult<null>> {
  const response = await tapError(
    fetch(args.url, {
      ...args.init,
      signal,
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        ...args.init.headers,
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
  return { kind: "ok", value: null };
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

export async function resolveGmailLabelForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly labelName: string;
  },
  signal: AbortSignal,
): Promise<GmailLabelResolveResult> {
  const accessResult = await resolveGmailAccess(args, signal);
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

async function stopGmailMailbox(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<GmailFetchResult<null>> {
  return await gmailFetchNoContent(
    {
      accessToken: args.accessToken,
      url: `${GMAIL_API_BASE}/stop`,
      init: { method: "POST", body: JSON.stringify({}) },
    },
    signal,
  );
}

function normalizeGmailAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

function gmailLifecycleLockKey(
  emailAddress: string,
  topicName: string,
): string {
  const scopeHash = createHash("sha256")
    .update(`${normalizeGmailAddress(emailAddress)}\n${topicName}`)
    .digest("hex");
  return `workflow_watch:gmail:${scopeHash}`;
}

async function lockGmailLifecycle(
  db: Db,
  emailAddress: string,
  topicName: string,
): Promise<void> {
  const lockKey = gmailLifecycleLockKey(emailAddress, topicName);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

export async function hasEnabledGmailConsumer(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [consumer] = await args.db
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
}

async function loadGmailPhysicalWatchStates(
  args: {
    readonly db: Db;
    readonly emailAddress: string;
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<GmailWatchStateRow[]> {
  const states = await args.db
    .select()
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
}

async function partitionGmailStatesByConsumer(
  args: {
    readonly db: Db;
    readonly states: readonly GmailWatchStateRow[];
    readonly excludedConnectorId?: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly active: GmailWatchStateRow[];
  readonly inactive: GmailWatchStateRow[];
}> {
  const active: GmailWatchStateRow[] = [];
  const inactive: GmailWatchStateRow[] = [];
  for (const state of args.states) {
    const hasConsumer =
      state.connectorId !== args.excludedConnectorId &&
      (await hasEnabledGmailConsumer(
        {
          db: args.db,
          orgId: state.orgId,
          userId: state.userId,
          connectorId: state.connectorId,
        },
        signal,
      ));
    (hasConsumer ? active : inactive).push(state);
  }
  return { active, inactive };
}

function watchExpirationDate(expiration: string): Date {
  const millis = Number(expiration);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid Gmail watch expiration: ${expiration}`);
  }
  return new Date(millis);
}

async function deleteGmailWatchStates(
  db: Db,
  states: readonly GmailWatchStateRow[],
): Promise<void> {
  if (states.length === 0) {
    return;
  }
  await db.delete(gmailWatchStates).where(
    inArray(
      gmailWatchStates.id,
      states.map((state) => {
        return state.id;
      }),
    ),
  );
}

async function persistEnsuredGmailWatch(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly access: GmailAccess;
  readonly emailAddress: string;
  readonly topicName: string;
  readonly activeStates: readonly GmailWatchStateRow[];
  readonly inactiveStates: readonly GmailWatchStateRow[];
  readonly resetCurrentCursor: boolean;
  readonly watch: z.infer<typeof gmailWatchResponseSchema>;
  readonly currentTime: Date;
}): Promise<void> {
  const expiration = watchExpirationDate(args.watch.expiration);
  await deleteGmailWatchStates(args.db, args.inactiveStates);
  if (args.activeStates.length > 0) {
    await args.db
      .update(gmailWatchStates)
      .set({
        watchExpirationAt: expiration,
        lastWatchRenewedAt: args.currentTime,
        needsRewatch: false,
        updatedAt: args.currentTime,
      })
      .where(
        inArray(
          gmailWatchStates.id,
          args.activeStates.map((state) => {
            return state.id;
          }),
        ),
      );
  }
  await args.db
    .insert(gmailWatchStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.access.connectorId,
      emailAddress: args.emailAddress,
      topicName: args.topicName,
      lastHistoryId: args.watch.historyId,
      watchExpirationAt: expiration,
      lastWatchRenewedAt: args.currentTime,
      needsRewatch: false,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: [gmailWatchStates.connectorId, gmailWatchStates.topicName],
      set: {
        emailAddress: args.emailAddress,
        ...(args.resetCurrentCursor
          ? { lastHistoryId: args.watch.historyId }
          : {}),
        watchExpirationAt: expiration,
        lastWatchRenewedAt: args.currentTime,
        needsRewatch: false,
        updatedAt: args.currentTime,
      },
    });
}

async function ensureGmailWatchWithResolvedAccess(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly access: GmailAccess;
    readonly emailAddress: string;
    readonly topicName: string;
    readonly forceRefresh: boolean;
    readonly allowStagedOfficialTarget: boolean;
  },
  signal: AbortSignal,
): Promise<EnsureGmailWatchResult> {
  return await args.db.transaction(async (tx) => {
    await lockGmailLifecycle(tx, args.emailAddress, args.topicName);
    signal.throwIfAborted();
    if (
      !args.allowStagedOfficialTarget &&
      !(await hasEnabledGmailConsumer(
        {
          db: tx,
          orgId: args.orgId,
          userId: args.userId,
          connectorId: args.access.connectorId,
        },
        signal,
      ))
    ) {
      return { kind: "ok" };
    }

    const states = await loadGmailPhysicalWatchStates(
      {
        db: tx,
        emailAddress: args.emailAddress,
        topicName: args.topicName,
      },
      signal,
    );
    const { active, inactive } = await partitionGmailStatesByConsumer(
      {
        db: tx,
        states,
      },
      signal,
    );
    const localState = active.find((state) => {
      return state.connectorId === args.access.connectorId;
    });
    const currentTime = nowDate();
    if (
      localState &&
      !args.forceRefresh &&
      !localState.needsRewatch &&
      localState.watchExpirationAt.getTime() >
        currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS
    ) {
      await deleteGmailWatchStates(tx, inactive);
      return { kind: "ok" };
    }

    const watch = await watchGmailMailbox(
      {
        accessToken: args.access.accessToken,
        topicName: args.topicName,
      },
      signal,
    );
    signal.throwIfAborted();
    if (watch.kind !== "ok") {
      return {
        kind: "bad_request",
        message: "Failed to register Gmail watch for event automation setup",
      };
    }
    await persistEnsuredGmailWatch({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      access: args.access,
      emailAddress: args.emailAddress,
      topicName: args.topicName,
      activeStates: active,
      inactiveStates: inactive,
      resetCurrentCursor: args.forceRefresh,
      watch: watch.value,
      currentTime,
    });
    signal.throwIfAborted();
    log.debug("Workflow watch lifecycle reconciled", {
      provider: "gmail",
      action: "ensure",
      result: "ok",
    });
    return { kind: "ok" };
  });
}

export async function ensureGmailWatchForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly forceRefresh?: boolean;
    readonly allowStagedOfficialTarget?: boolean;
  },
  signal: AbortSignal,
): Promise<EnsureGmailWatchResult> {
  const topicName = optionalEnv("GMAIL_PUBSUB_TOPIC_NAME");
  if (!topicName) {
    return {
      kind: "bad_request",
      message: "GMAIL_PUBSUB_TOPIC_NAME is not configured",
    };
  }

  const accessResult = await resolveGmailAccess(args, signal);
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }

  let emailAddress = accessResult.access.emailAddress;
  if (!emailAddress) {
    const profile = await fetchGmailProfile(
      accessResult.access.accessToken,
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

  return await ensureGmailWatchWithResolvedAccess(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      access: accessResult.access,
      emailAddress,
      topicName,
      forceRefresh: args.forceRefresh ?? false,
      allowStagedOfficialTarget: args.allowStagedOfficialTarget ?? false,
    },
    signal,
  );
}

interface GmailPhysicalScopeInput {
  readonly emailAddress: string;
  readonly topicName: string;
  readonly excludedConnectorId?: string;
  readonly preferredConnectorId?: string;
  readonly renewBefore?: Date;
}

interface ReconcileGmailPhysicalScopeArgs extends GmailPhysicalScopeInput {
  readonly db: Db;
}

async function resolveGmailAccessFromStates(
  args: {
    readonly db: Db;
    readonly states: readonly GmailWatchStateRow[];
    readonly preferredConnectorId?: string;
  },
  signal: AbortSignal,
): Promise<GmailAccess | null> {
  const candidates = args.preferredConnectorId
    ? [
        ...args.states.filter((state) => {
          return state.connectorId === args.preferredConnectorId;
        }),
        ...args.states.filter((state) => {
          return state.connectorId !== args.preferredConnectorId;
        }),
      ]
    : args.states;
  for (const state of candidates) {
    const result = await resolveGmailAccess(
      {
        db: args.db,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return result.access;
    }
  }
  return null;
}

async function reconcileActiveGmailStates(
  args: {
    readonly db: Db;
    readonly active: readonly GmailWatchStateRow[];
    readonly inactive: readonly GmailWatchStateRow[];
    readonly topicName: string;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<GmailWatchReconcileResult> {
  await deleteGmailWatchStates(args.db, args.inactive);
  if (args.inactive.length > 0) {
    log.debug("Workflow watch lifecycle reconciled", {
      provider: "gmail",
      action: "remove_local_state",
      result: "ok",
    });
  }
  const renewBefore = args.renewBefore;
  const renewalDue =
    renewBefore !== undefined &&
    args.active.some((state) => {
      return (
        state.needsRewatch ||
        state.watchExpirationAt.getTime() <= renewBefore.getTime()
      );
    });
  if (!renewalDue) {
    return args.inactive.length > 0
      ? { kind: "local_removed" }
      : { kind: "unchanged" };
  }

  const access = await resolveGmailAccessFromStates(
    {
      db: args.db,
      states: args.active,
    },
    signal,
  );
  if (!access) {
    return { kind: "failed" };
  }
  const watch = await watchGmailMailbox(
    {
      accessToken: access.accessToken,
      topicName: args.topicName,
    },
    signal,
  );
  signal.throwIfAborted();
  if (watch.kind !== "ok") {
    log.warn("Workflow watch lifecycle reconciliation failed", {
      provider: "gmail",
      action: "renew",
      result: "provider_error",
      status: watch.status,
    });
    return { kind: "failed" };
  }

  const currentTime = nowDate();
  await args.db
    .update(gmailWatchStates)
    .set({
      watchExpirationAt: watchExpirationDate(watch.value.expiration),
      lastWatchRenewedAt: currentTime,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(
      inArray(
        gmailWatchStates.id,
        args.active.map((state) => {
          return state.id;
        }),
      ),
    );
  log.debug("Workflow watch lifecycle reconciled", {
    provider: "gmail",
    action: "renew",
    result: "ok",
  });
  return { kind: "renewed" };
}

async function markGmailStatesForRetry(
  db: Db,
  states: readonly GmailWatchStateRow[],
): Promise<void> {
  await db
    .update(gmailWatchStates)
    .set({ needsRewatch: true, updatedAt: nowDate() })
    .where(
      inArray(
        gmailWatchStates.id,
        states.map((state) => {
          return state.id;
        }),
      ),
    );
}

async function stopInactiveGmailStates(
  args: {
    readonly db: Db;
    readonly states: readonly GmailWatchStateRow[];
    readonly preferredConnectorId?: string;
  },
  signal: AbortSignal,
): Promise<GmailWatchReconcileResult> {
  const access = await resolveGmailAccessFromStates(
    {
      db: args.db,
      states: args.states,
      ...(args.preferredConnectorId === undefined
        ? {}
        : { preferredConnectorId: args.preferredConnectorId }),
    },
    signal,
  );
  if (!access) {
    await markGmailStatesForRetry(args.db, args.states);
    return { kind: "failed" };
  }

  const stopped = await stopGmailMailbox(
    {
      accessToken: access.accessToken,
    },
    signal,
  );
  signal.throwIfAborted();
  if (stopped.kind !== "ok") {
    await markGmailStatesForRetry(args.db, args.states);
    log.warn("Workflow watch lifecycle reconciliation failed", {
      provider: "gmail",
      action: "stop",
      result: "provider_error",
      status: stopped.status,
    });
    return { kind: "failed" };
  }
  await deleteGmailWatchStates(args.db, args.states);
  log.debug("Workflow watch lifecycle reconciled", {
    provider: "gmail",
    action: "stop",
    result: "ok",
  });
  return { kind: "stopped" };
}

async function reconcileGmailPhysicalScopeLocked(
  db: Db,
  args: GmailPhysicalScopeInput,
  signal: AbortSignal,
): Promise<GmailWatchReconcileResult> {
  const states = await loadGmailPhysicalWatchStates(
    {
      db,
      emailAddress: args.emailAddress,
      topicName: args.topicName,
    },
    signal,
  );
  if (states.length === 0) {
    return { kind: "unchanged" };
  }
  const { active, inactive } = await partitionGmailStatesByConsumer(
    {
      db,
      states,
      ...(args.excludedConnectorId === undefined
        ? {}
        : { excludedConnectorId: args.excludedConnectorId }),
    },
    signal,
  );
  if (active.length > 0) {
    return await reconcileActiveGmailStates(
      {
        db,
        active,
        inactive,
        topicName: args.topicName,
        ...(args.renewBefore === undefined
          ? {}
          : { renewBefore: args.renewBefore }),
      },
      signal,
    );
  }
  return await stopInactiveGmailStates(
    {
      db,
      states,
      ...(args.preferredConnectorId === undefined
        ? {}
        : { preferredConnectorId: args.preferredConnectorId }),
    },
    signal,
  );
}

async function reconcileGmailPhysicalScope(
  args: ReconcileGmailPhysicalScopeArgs,
  signal: AbortSignal,
): Promise<GmailWatchReconcileResult> {
  return await args.db.transaction(async (tx) => {
    await lockGmailLifecycle(tx, args.emailAddress, args.topicName);
    signal.throwIfAborted();
    return await reconcileGmailPhysicalScopeLocked(tx, args, signal);
  });
}

function gmailPhysicalScopes(states: readonly GmailWatchStateRow[]): readonly {
  readonly emailAddress: string;
  readonly topicName: string;
}[] {
  const scopes = new Map<
    string,
    { readonly emailAddress: string; readonly topicName: string }
  >();
  for (const state of states) {
    const key = `${normalizeGmailAddress(state.emailAddress)}\n${state.topicName}`;
    scopes.set(key, {
      emailAddress: state.emailAddress,
      topicName: state.topicName,
    });
  }
  return [...scopes.values()];
}

async function renewGmailPhysicalScopes(
  args: {
    readonly db: Db;
    readonly scopes: readonly {
      readonly emailAddress: string;
      readonly topicName: string;
    }[];
    readonly renewBefore: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly renewed: number; readonly failed: number }> {
  let renewed = 0;
  let failed = 0;
  for (const scope of args.scopes) {
    const result = await reconcileGmailPhysicalScope(
      {
        db: args.db,
        ...scope,
        renewBefore: args.renewBefore,
      },
      signal,
    );
    signal.throwIfAborted();
    renewed += result.kind === "renewed" ? 1 : 0;
    failed += result.kind === "failed" ? 1 : 0;
  }
  return { renewed, failed };
}

async function loadEnabledGmailConnectorIds(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly string[]> {
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
  return consumers.flatMap((consumer) => {
    return consumer.connectorId === null ? [] : [consumer.connectorId];
  });
}

async function repairGmailAutomationProjections(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      ...args,
      target: { kind: "builtin", connectorSlug: "gmail" },
    });
    await reprojectGmailAutomationsForOwner(tx, args);
  });
}

export async function reconcileGmailWatchesForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  await repairGmailAutomationProjections(args.db, args);
  signal.throwIfAborted();
  const connectorIds = await loadEnabledGmailConnectorIds(args.db, args);
  signal.throwIfAborted();
  let succeeded = true;
  for (const connectorId of connectorIds) {
    const ensured = await ensureGmailWatchForUser(
      {
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    succeeded &&= ensured.kind === "ok";
  }

  const states = await args.db
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
    const preferredConnectorId = states.find((state) => {
      return (
        normalizeGmailAddress(state.emailAddress) ===
          normalizeGmailAddress(scope.emailAddress) &&
        state.topicName === scope.topicName
      );
    })?.connectorId;
    const result = await reconcileGmailPhysicalScope(
      {
        db: args.db,
        ...scope,
        ...(preferredConnectorId === undefined ? {} : { preferredConnectorId }),
      },
      signal,
    );
    succeeded &&= result.kind !== "failed";
  }
  return succeeded;
}

export async function prepareGmailWatchStopForConnector(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<PendingGmailWatchStop | null> {
  const states = await args.db
    .select()
    .from(gmailWatchStates)
    .where(
      and(
        eq(gmailWatchStates.orgId, args.orgId),
        eq(gmailWatchStates.userId, args.userId),
        eq(gmailWatchStates.connectorId, args.connectorId),
      ),
    );
  signal.throwIfAborted();
  const scopes = gmailPhysicalScopes(states);
  let shouldStop = states.length > 0;
  for (const scope of scopes) {
    const physicalStates = await loadGmailPhysicalWatchStates(
      { db: args.db, ...scope },
      signal,
    );
    const { active } = await partitionGmailStatesByConsumer(
      {
        db: args.db,
        states: physicalStates,
        excludedConnectorId: args.connectorId,
      },
      signal,
    );
    if (active.length > 0) {
      shouldStop = false;
      break;
    }
  }
  if (!shouldStop) {
    return null;
  }
  const access = await resolveGmailAccess(
    { ...args, refreshExpiredToken: false },
    signal,
  );
  signal.throwIfAborted();
  return access.kind === "ok"
    ? { accessToken: access.access.accessToken, scopes }
    : null;
}

export async function stopPreparedGmailWatch(
  args: { readonly db: Db; readonly pending: PendingGmailWatchStop },
  signal: AbortSignal,
): Promise<void> {
  await args.db.transaction(async (tx) => {
    const scopes = [...args.pending.scopes].sort((left, right) => {
      return `${normalizeGmailAddress(left.emailAddress)}\n${left.topicName}`.localeCompare(
        `${normalizeGmailAddress(right.emailAddress)}\n${right.topicName}`,
      );
    });
    for (const scope of scopes) {
      await lockGmailLifecycle(tx, scope.emailAddress, scope.topicName);
    }
    signal.throwIfAborted();

    const states: GmailWatchStateRow[] = [];
    for (const scope of scopes) {
      states.push(
        ...(await loadGmailPhysicalWatchStates({ db: tx, ...scope }, signal)),
      );
    }
    const { active } = await partitionGmailStatesByConsumer(
      { db: tx, states },
      signal,
    );
    if (active.length > 0) {
      return;
    }

    const stopped = await stopGmailMailbox(
      { accessToken: args.pending.accessToken },
      signal,
    );
    signal.throwIfAborted();
    if (stopped.kind !== "ok") {
      if (states.length > 0) {
        await markGmailStatesForRetry(tx, states);
      }
      log.warn("Workflow watch lifecycle reconciliation failed", {
        provider: "gmail",
        action: "stop_after_disconnect",
        result: "provider_error",
        status: stopped.status,
      });
      return;
    }
    await deleteGmailWatchStates(tx, states);
    log.debug("Workflow watch lifecycle reconciled", {
      provider: "gmail",
      action: "stop_after_disconnect",
      result: "ok",
    });
  });
}

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

type GmailRunStarter = (args: {
  readonly automation: GmailEventAutomationRow;
  readonly connectorSourceId: string;
  readonly watchStateId: string;
  readonly decoded: DecodedGmailPubSubPush;
  readonly message: GmailMessageContext;
  readonly timing: AutomationEventRunTiming;
}) => Promise<"ok" | "error" | "superseded">;

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

class GmailAutomationSourceChangedError extends Error {
  constructor() {
    super("Gmail automation source changed before durable queue admission");
    this.name = "GmailAutomationSourceChangedError";
  }
}

async function persistCurrentGmailAutomationSource(
  tx: WorkflowQueueAdmissionTransaction,
  args: {
    readonly automationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSourceId: string;
    readonly watchStateId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await lockConnectorAccountTarget(tx, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: "gmail" },
  });
  const [currentState] = await tx
    .select({ id: gmailWatchStates.id })
    .from(gmailWatchStates)
    .where(
      and(
        eq(gmailWatchStates.id, args.watchStateId),
        eq(gmailWatchStates.connectorId, args.connectorSourceId),
      ),
    )
    .for("key share")
    .limit(1);
  const [current] = await tx
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, args.connectorSourceId),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!currentState || !current) {
    throw new GmailAutomationSourceChangedError();
  }
}

type GmailDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

async function loadGmailWatchStates(
  args: {
    readonly db: Db;
    readonly decoded: DecodedGmailPubSubPush;
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<GmailWatchStateRow[]> {
  const states = await args.db
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
}

async function loadGmailEventAutomations(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
  },
  signal: AbortSignal,
): Promise<GmailEventAutomationRow[]> {
  const automationRows = await args.db
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
    const canFire = await workflowAutomationCanFire(
      args.db,
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
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
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
}

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

async function insertGmailProcessedEvent(
  args: {
    readonly db: Db;
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
> {
  return await args.db.transaction(async (tx) => {
    const [currentState] = await tx
      .select({ id: gmailWatchStates.id })
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.id, args.state.id),
          eq(gmailWatchStates.connectorId, args.state.connectorId),
        ),
      )
      .for("key share")
      .limit(1);
    signal.throwIfAborted();
    if (!currentState) {
      return { kind: "stale_source" };
    }

    const [processed] = await tx
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
      .returning({ id: gmailProcessedEvents.id });
    signal.throwIfAborted();
    return processed
      ? { kind: "inserted", id: processed.id }
      : { kind: "duplicate" };
  });
}

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

async function dispatchGmailAutomationEvent(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
    readonly automation: GmailEventAutomationRow;
    readonly decoded: DecodedGmailPubSubPush;
    readonly event: GmailHistoryMessageAdded;
    readonly message: GmailMessageContext;
    readonly timing: AutomationEventRunTiming;
    readonly startRun: GmailRunStarter;
  },
  signal: AbortSignal,
): Promise<
  "dispatched" | "duplicate" | "skipped" | { readonly kind: "run_error" }
> {
  const processed = await args.timing.measure(
    "api_dispatch_pre_create_agent_automation_event_record_processed_event",
    async () => {
      return await insertGmailProcessedEvent(args, signal);
    },
  );
  if (processed.kind === "stale_source") {
    return "skipped";
  }
  if (processed.kind === "duplicate") {
    return "duplicate";
  }
  const processedId = processed.id;

  const result = await args.startRun({
    automation: args.automation,
    connectorSourceId: args.state.connectorId,
    watchStateId: args.state.id,
    decoded: args.decoded,
    message: args.message,
    timing: args.timing,
  });
  signal.throwIfAborted();
  if (result === "superseded") {
    await args.db
      .delete(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.id, processedId));
    signal.throwIfAborted();
    return "skipped";
  }
  if (result !== "ok") {
    await args.db
      .delete(gmailProcessedEvents)
      .where(eq(gmailProcessedEvents.id, processedId));
    signal.throwIfAborted();
    return { kind: "run_error" };
  }

  return "dispatched";
}

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

async function updateResolvedGmailLabelId(
  args: {
    readonly db: Db;
    readonly automation: GmailEventAutomationRow & {
      readonly config: GmailLabelAppliedEventConfig;
    };
    readonly connectorId: string;
    readonly watchStateId: string;
    readonly labelId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.automation.config.resolvedLabelId === args.labelId) {
    return;
  }

  await args.db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      orgId: args.automation.automation.orgId,
      userId: args.automation.automation.ownerUserId,
      target: { kind: "builtin", connectorSlug: "gmail" },
    });
    const [currentState] = await tx
      .select({ id: gmailWatchStates.id })
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.id, args.watchStateId),
          eq(gmailWatchStates.connectorId, args.connectorId),
        ),
      )
      .for("key share")
      .limit(1);
    if (!currentState) {
      return;
    }
    await tx
      .update(workflowAutomations)
      .set({
        eventConfig: {
          ...args.automation.config,
          resolvedLabelId: args.labelId,
        },
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(workflowAutomations.id, args.automation.automation.id),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
        ),
      );
  });
  signal.throwIfAborted();
}

async function labelAppliedAutomationMatchesEvent(
  args: {
    readonly db: Db;
    readonly accessToken: string;
    readonly connectorId: string;
    readonly watchStateId: string;
    readonly automation: GmailEventAutomationRow & {
      readonly config: GmailLabelAppliedEventConfig;
    };
    readonly event: GmailHistoryLabelAdded;
    readonly labelCache: Map<string, GmailLabelResolveResult>;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const eventLabelIds = new Set(args.event.labelIds);
  const resolvedLabelId = args.automation.config.resolvedLabelId;
  if (resolvedLabelId && eventLabelIds.has(resolvedLabelId)) {
    return true;
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
    return false;
  }
  if (!eventLabelIds.has(label.labelId)) {
    return false;
  }

  await updateResolvedGmailLabelId(
    {
      db: args.db,
      automation: args.automation,
      connectorId: args.connectorId,
      watchStateId: args.watchStateId,
      labelId: label.labelId,
    },
    signal,
  );
  return true;
}

async function dispatchGmailNewMessageHistoryEvent(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
    readonly decoded: DecodedGmailPubSubPush;
    readonly accessToken: string;
    readonly automations: readonly GmailEventAutomationRow[];
    readonly event: GmailHistoryMessageAdded;
    readonly messageCache: Map<string, GmailMessageContext | null>;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GmailRunStarter;
  },
  signal: AbortSignal,
): Promise<GmailDispatchStateResult> {
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
    if (!matches) {
      continue;
    }
    const result = await dispatchGmailAutomationEvent(
      {
        db: args.db,
        state: args.state,
        automation,
        decoded: args.decoded,
        event: args.event,
        message,
        timing: runTiming,
        startRun: args.startRun,
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
}

async function dispatchGmailLabelAppliedHistoryEvent(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
    readonly decoded: DecodedGmailPubSubPush;
    readonly accessToken: string;
    readonly automations: readonly GmailEventAutomationRow[];
    readonly event: GmailHistoryLabelAdded;
    readonly messageCache: Map<string, GmailMessageContext | null>;
    readonly labelCache: Map<string, GmailLabelResolveResult>;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GmailRunStarter;
  },
  signal: AbortSignal,
): Promise<GmailDispatchStateResult> {
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
    const matches = await runTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_match_automations",
      async () => {
        return await labelAppliedAutomationMatchesEvent(
          {
            db: args.db,
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
    if (matches) {
      matchingAutomations.push({ automation, timing: runTiming });
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
    const result = await dispatchGmailAutomationEvent(
      {
        db: args.db,
        state: args.state,
        automation: match.automation,
        decoded: args.decoded,
        event: args.event,
        message,
        timing: match.timing,
        startRun: args.startRun,
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
}

async function dispatchGmailHistoryEvents(
  args: {
    readonly db: Db;
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
    readonly startRun: GmailRunStarter;
  },
  signal: AbortSignal,
): Promise<GmailDispatchStateResult> {
  const messageCache = new Map<string, GmailMessageContext | null>();
  const labelCache = new Map<string, GmailLabelResolveResult>();
  let dispatched = 0;
  let duplicates = 0;

  for (const event of args.history.messagesAdded) {
    const result = await dispatchGmailNewMessageHistoryEvent(
      {
        db: args.db,
        state: args.state,
        decoded: args.decoded,
        accessToken: args.accessToken,
        automations: args.automations,
        event,
        messageCache,
        sourceTiming: args.sourceTiming.fork(),
        startRun: args.startRun,
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
    const result = await dispatchGmailLabelAppliedHistoryEvent(
      {
        db: args.db,
        state: args.state,
        decoded: args.decoded,
        accessToken: args.accessToken,
        automations: args.automations,
        event,
        messageCache,
        labelCache,
        sourceTiming: args.sourceTiming.fork(),
        startRun: args.startRun,
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
}

async function hasCurrentGmailWatchConsumer(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
    readonly sourceTiming: AutomationEventSourceTiming;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const hasConsumer = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_automations",
    async () => {
      return await hasEnabledGmailConsumer(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
        },
        signal,
      );
    },
  );
  if (hasConsumer) {
    return true;
  }
  await repairGmailAutomationProjections(args.db, {
    orgId: args.state.orgId,
    userId: args.state.userId,
  });
  signal.throwIfAborted();
  return await hasEnabledGmailConsumer(
    {
      db: args.db,
      orgId: args.state.orgId,
      userId: args.state.userId,
      connectorId: args.state.connectorId,
    },
    signal,
  );
}

async function dispatchGmailWatchState(
  args: {
    readonly db: Db;
    readonly state: GmailWatchStateRow;
    readonly decoded: DecodedGmailPubSubPush;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GmailRunStarter;
  },
  signal: AbortSignal,
): Promise<GmailDispatchStateResult> {
  const hasConsumer = await hasCurrentGmailWatchConsumer(args, signal);
  if (!hasConsumer) {
    log.debug("Workflow watch dispatch skipped", {
      provider: "gmail",
      action: "dispatch",
      result: "no_consumer",
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const access = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_source_state",
    async () => {
      return await resolveGmailAccess(
        {
          db: args.db,
          orgId: args.state.orgId,
          userId: args.state.userId,
          connectorId: args.state.connectorId,
        },
        signal,
      );
    },
  );
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const history = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_external_events",
    async () => {
      return await listGmailHistory(
        {
          accessToken: access.access.accessToken,
          startHistoryId: args.state.lastHistoryId,
        },
        signal,
      );
    },
  );
  signal.throwIfAborted();
  if (history.kind === "stale_cursor") {
    await ensureGmailWatchForUser(
      {
        db: args.db,
        orgId: args.state.orgId,
        userId: args.state.userId,
        connectorId: args.state.connectorId,
        forceRefresh: true,
      },
      signal,
    );
    return { kind: "ok", dispatched: 0, duplicates: 0 };
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
      return await loadGmailEventAutomations(args, signal);
    },
  );
  const result = await dispatchGmailHistoryEvents(
    {
      db: args.db,
      state: args.state,
      decoded: args.decoded,
      accessToken: access.access.accessToken,
      history,
      automations,
      sourceTiming: args.sourceTiming,
      startRun: args.startRun,
    },
    signal,
  );
  if (result.kind !== "ok") {
    return result;
  }

  await args.db
    .update(gmailWatchStates)
    .set({
      lastHistoryId: args.decoded.historyId,
      needsRewatch: false,
      updatedAt: nowDate(),
    })
    .where(eq(gmailWatchStates.id, args.state.id));
  signal.throwIfAborted();

  return result;
}

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
          persistSourceTransition: async (tx) => {
            await persistCurrentGmailAutomationSource(
              tx,
              {
                automationId: args.automation.automation.id,
                orgId: args.automation.automation.orgId,
                userId: args.automation.automation.ownerUserId,
                connectorSourceId: args.connectorSourceId,
                watchStateId: args.watchStateId,
              },
              signal,
            );
          },
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
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
    return started.value.kind === "ok" || started.value.kind === "enqueued"
      ? "ok"
      : "error";
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
    const db = set(writeDb$);
    const states = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await loadGmailWatchStates(
          {
            db,
            decoded,
            topicName,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    const runStarterOverride = gmailRunStarterOverride.get();
    const startRun: GmailRunStarter = runStarterOverride
      ? async ({ automation, decoded, message }) => {
          return await runStarterOverride({
            automationId: automation.automation.id,
            workflowName: automation.workflowName,
            emailAddress: decoded.emailAddress,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            triggerBrief: buildGmailWorkflowAutomationBrief({
              automationConfig: automation.config,
              message,
            }),
          });
        }
      : async ({
          automation,
          connectorSourceId,
          watchStateId,
          decoded,
          message,
          timing,
        }) => {
          return await set(
            startGmailWorkflowRun$,
            {
              automation,
              connectorSourceId,
              watchStateId,
              decoded,
              message,
              timing,
              apiStartTime: args.apiStartTime,
            },
            signal,
          );
        };

    let dispatched = 0;
    let duplicates = 0;

    for (const state of states) {
      const result = await dispatchGmailWatchState(
        {
          db,
          state,
          decoded,
          sourceTiming: sourceTiming.fork(),
          startRun,
        },
        signal,
      );
      if (result.kind !== "ok") {
        return result;
      }
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
      await repairGmailAutomationProjections(db, owner);
      signal.throwIfAborted();
      const [connectorIds, states] = await Promise.all([
        loadEnabledGmailConnectorIds(db, owner),
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
        const result = await ensureGmailWatchForUser(
          { db, ...owner, connectorId },
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
    const renewed = await renewGmailPhysicalScopes(
      { db, scopes: gmailPhysicalScopes(states), renewBefore },
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
    return await renewGmailPhysicalScopes(
      {
        db: set(writeDb$),
        scopes: [{ emailAddress, topicName }],
        renewBefore: new Date(currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS),
      },
      signal,
    );
  },
);
