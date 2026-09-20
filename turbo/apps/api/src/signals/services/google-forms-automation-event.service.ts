import { createHash } from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import { command } from "ccstate";
import { and, asc, eq, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  googleFormsResponseSubmittedEventConfigSchema,
  type GoogleFormsResponseSubmittedEventConfig,
  type GoogleFormsResponseSubmittedEventCreateConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  googleFormsAutomationCursors,
  googleFormsProcessedEvents,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, safeUrlParse, settle, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection,
  loadBuiltinConnectorCredentialValues,
  refreshBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-runtime.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { reprojectGoogleFormsAutomationsForOwner } from "./google-forms-automation-account.service";
import type { AutomationRow } from "./workflow-automation-launch.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";

const log = logger("api:google-forms-automation-event");

const GOOGLE_FORMS_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_FORMS_TOKEN";
const GOOGLE_FORMS_API_BASE = "https://forms.googleapis.com/v1/forms";
const GOOGLE_FORMS_RESPONSE_FIELDS =
  "responses(responseId,createTime,lastSubmittedTime,respondentEmail),nextPageToken";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const FORM_EDIT_LINK_GUIDANCE =
  "Please open the form's edit page and copy the link from the address bar";
const UNPUBLISHED_FORM_WARNING =
  "This Google Form is not accepting responses yet. Publish it before expecting response events.";
const PUBSUB_CONFIGURATION_ERROR =
  "Google Forms Pub/Sub push is not configured";
const GOOGLE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const googleFormSchema = z.object({
  formId: z.string(),
  info: z.object({ title: z.string() }),
  publishSettings: z
    .object({
      publishState: z
        .object({
          isPublished: z.boolean().optional(),
          isAcceptingResponses: z.boolean().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const googleFormResponseSchema = z.object({
  responseId: z.string(),
  createTime: z.string(),
  lastSubmittedTime: z.string(),
  respondentEmail: z.string().nullable().optional(),
});

const googleFormResponsesSchema = z.object({
  responses: z.array(googleFormResponseSchema).optional(),
  nextPageToken: z.string().optional(),
});

const googleFormsWatchSchema = z.object({
  id: z.string(),
  createTime: z.string().optional(),
  expireTime: z.string(),
  eventType: z.literal("RESPONSES"),
  target: z
    .object({
      topic: z.object({ topicName: z.string() }),
    })
    .optional(),
});

const googleFormsWatchesSchema = z.object({
  watches: z.array(googleFormsWatchSchema).optional(),
});

const emptyGoogleFormsResponseSchema = z.object({});

const googleFormsErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
  }),
});

const pubSubPushSchema = z.object({
  message: z.object({
    messageId: z.string(),
    attributes: z.object({
      formId: z.string(),
      watchId: z.string(),
      eventType: z.literal("RESPONSES"),
    }),
    data: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

type GoogleFormsWatchStateRow = typeof googleFormsWatchStates.$inferSelect;
type GoogleFormResponse = z.infer<typeof googleFormResponseSchema>;

interface GoogleFormsAccess {
  readonly connectorId: string;
  readonly accessToken: string;
}

type GoogleFormsAccessResult =
  | { readonly kind: "ok"; readonly access: GoogleFormsAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface GoogleFormsFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GoogleFormsFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
  readonly googleStatus?: string;
}

type GoogleFormsFetchResult<T> = GoogleFormsFetchOk<T> | GoogleFormsFetchError;

type EnsureGoogleFormsWatchResult =
  | {
      readonly kind: "ok";
      readonly watchStateId: string | null;
    }
  | { readonly kind: "bad_request"; readonly message: string };

type GoogleFormsWatchReconcileResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "created" }
  | { readonly kind: "renewed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" };

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

async function resolveGoogleFormsAccess(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadBuiltinConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: "google-forms",
    connectorId: args.connectorId,
  });
  signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return {
      kind: "bad_request",
      message:
        "Connect Google Forms before adding a Google Forms response automation",
    };
  }
  if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Forms before using Google Forms response automations",
    };
  }
  const connection = loaded.connection;
  const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
    connection,
    GOOGLE_FORMS_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Forms before using Google Forms response automations",
    };
  }
  const values = await loadBuiltinConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  signal.throwIfAborted();
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Forms before using Google Forms response automations",
    };
  }
  if (!tokenNeedsRefresh(connection.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: { connectorId: connection.connectorId, accessToken },
    };
  }
  const refreshed = await refreshBuiltinConnectorCredentialAccess(
    {
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: GOOGLE_FORMS_ACCESS_TOKEN_ENVIRONMENT_NAME,
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
      message:
        "Reconnect Google Forms before using Google Forms response automations",
    };
  }
  return {
    kind: "ok",
    access: {
      connectorId: connection.connectorId,
      accessToken: refreshed.accessToken,
    },
  };
}

async function googleFormsFetchJson<T>(
  args: {
    readonly schema: z.ZodType<T>;
    readonly accessToken: string;
    readonly url: string;
    readonly init: RequestInit;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<T>> {
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
    return { kind: "error", status: 0, message: "Google Forms request failed" };
  }
  if (!response.ok) {
    const rawError = await response.text();
    const parsedError = safeJsonParse(rawError);
    const googleError = googleFormsErrorSchema.safeParse(parsedError);
    const message = googleError.success
      ? (googleError.data.error.message ?? rawError)
      : rawError;
    const googleStatus = googleError.success
      ? googleError.data.error.status
      : undefined;
    return {
      kind: "error",
      status: response.status,
      message,
      ...(googleStatus === undefined ? {} : { googleStatus }),
    };
  }
  const body = response.status === 204 ? {} : await response.json();
  return { kind: "ok", value: args.schema.parse(body) };
}

function formApiUrl(formId: string, suffix = ""): string {
  return `${GOOGLE_FORMS_API_BASE}/${encodeURIComponent(formId)}${suffix}`;
}

function canonicalFormUrl(formId: string): string {
  return `https://docs.google.com/forms/d/${formId}/edit`;
}

function googleFormIdFromUrl(
  value: string,
):
  | { readonly kind: "ok"; readonly formId: string }
  | { readonly kind: "bad_request"; readonly message: string } {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { kind: "ok", formId: trimmed };
  }
  const parsed = safeUrlParse(trimmed);
  if (!parsed) {
    return { kind: "bad_request", message: FORM_EDIT_LINK_GUIDANCE };
  }
  if (
    parsed.hostname === "forms.gle" ||
    parsed.hostname !== "docs.google.com"
  ) {
    return { kind: "bad_request", message: FORM_EDIT_LINK_GUIDANCE };
  }
  if (parsed.pathname.startsWith("/forms/d/e/")) {
    return { kind: "bad_request", message: FORM_EDIT_LINK_GUIDANCE };
  }
  const match = /^\/forms\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(parsed.pathname);
  return match?.[1]
    ? { kind: "ok", formId: match[1] }
    : { kind: "bad_request", message: FORM_EDIT_LINK_GUIDANCE };
}

async function fetchGoogleForm(
  args: {
    readonly accessToken: string;
    readonly formId: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<z.infer<typeof googleFormSchema>>> {
  return await googleFormsFetchJson(
    {
      schema: googleFormSchema,
      accessToken: args.accessToken,
      url: formApiUrl(args.formId),
      init: { method: "GET" },
    },
    signal,
  );
}

function responsesListUrl(args: {
  readonly formId: string;
  readonly cursor?: string;
  readonly pageToken?: string;
}): string {
  const url = new URL(formApiUrl(args.formId, "/responses"));
  url.searchParams.set("fields", GOOGLE_FORMS_RESPONSE_FIELDS);
  if (args.cursor !== undefined) {
    url.searchParams.set("filter", `timestamp > ${args.cursor}`);
  }
  if (args.pageToken !== undefined) {
    url.searchParams.set("pageToken", args.pageToken);
  }
  return url.toString();
}

async function newestGoogleFormResponseTime(
  args: {
    readonly accessToken: string;
    readonly formId: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<string>> {
  let pageToken: string | undefined;
  let newest: string | undefined;
  do {
    const page = await googleFormsFetchJson(
      {
        schema: googleFormResponsesSchema,
        accessToken: args.accessToken,
        url: responsesListUrl({
          formId: args.formId,
          ...(pageToken === undefined ? {} : { pageToken }),
        }),
        init: { method: "GET" },
      },
      signal,
    );
    signal.throwIfAborted();
    if (page.kind !== "ok") {
      return page;
    }
    for (const response of page.value.responses ?? []) {
      if (
        newest === undefined ||
        googleFormsTimestampMicros(response.lastSubmittedTime) >
          googleFormsTimestampMicros(newest)
      ) {
        newest = response.lastSubmittedTime;
      }
    }
    pageToken = page.value.nextPageToken;
  } while (pageToken !== undefined);
  return { kind: "ok", value: newest ?? nowDate().toISOString() };
}

function formIsNotAcceptingResponses(
  form: z.infer<typeof googleFormSchema>,
): boolean {
  return (
    form.publishSettings?.publishState?.isPublished !== true ||
    form.publishSettings?.publishState?.isAcceptingResponses !== true
  );
}

export async function prepareGoogleFormsResponseEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly eventConfig: GoogleFormsResponseSubmittedEventCreateConfig;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: GoogleFormsResponseSubmittedEventConfig;
      readonly seedCursor: string;
      readonly warning?: string;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const parsedId = googleFormIdFromUrl(args.eventConfig.formUrl);
  if (parsedId.kind !== "ok") {
    return { kind: "bad-request", message: parsedId.message };
  }
  if (
    !optionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME") ||
    !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE") ||
    !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL")
  ) {
    return { kind: "bad-request", message: PUBSUB_CONFIGURATION_ERROR };
  }
  const access = await resolveGoogleFormsAccess(
    {
      db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "bad-request", message: access.message };
  }
  const form = await fetchGoogleForm(
    {
      accessToken: access.access.accessToken,
      formId: parsedId.formId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (form.kind !== "ok") {
    return {
      kind: "bad-request",
      message:
        form.status === 403 || form.status === 404
          ? "You do not have access to this form, or it does not exist"
          : "Unable to read that Google Form with the connected account",
    };
  }
  const cursor = await newestGoogleFormResponseTime(
    {
      accessToken: access.access.accessToken,
      formId: parsedId.formId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (cursor.kind !== "ok") {
    return {
      kind: "bad-request",
      message: "Unable to read responses for that Google Form",
    };
  }
  return {
    kind: "ok",
    eventConfig: {
      provider: "google-forms",
      event: "response_submitted",
      connectorId: access.access.connectorId,
      form: {
        id: form.value.formId,
        title: form.value.info.title,
        url: canonicalFormUrl(form.value.formId),
      },
    },
    seedCursor: cursor.value,
    ...(formIsNotAcceptingResponses(form.value)
      ? { warning: UNPUBLISHED_FORM_WARNING }
      : {}),
  };
}

function googleFormsLifecycleLockKey(
  connectorId: string,
  formId: string,
): string {
  const scopeHash = createHash("sha256")
    .update(`${connectorId}\n${formId}`)
    .digest("hex");
  return `workflow_watch:google_forms:${scopeHash}`;
}

async function lockGoogleFormsLifecycle(
  db: Db,
  connectorId: string,
  formId: string,
): Promise<void> {
  const lockKey = googleFormsLifecycleLockKey(connectorId, formId);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

export async function hasEnabledGoogleFormsConsumer(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly formId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [consumer] = await args.db
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
        eq(workflowAutomations.eventConnectorId, args.connectorId),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${args.connectorId}`,
        sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${args.formId}`,
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return consumer !== undefined;
}

async function createGoogleFormsWatch(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<z.infer<typeof googleFormsWatchSchema>>> {
  return await googleFormsFetchJson(
    {
      schema: googleFormsWatchSchema,
      accessToken: args.accessToken,
      url: formApiUrl(args.formId, "/watches"),
      init: {
        method: "POST",
        body: JSON.stringify({
          watch: {
            target: { topic: { topicName: args.topicName } },
            eventType: "RESPONSES",
          },
        }),
      },
    },
    signal,
  );
}

async function listGoogleFormsWatches(
  args: {
    readonly accessToken: string;
    readonly formId: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<z.infer<typeof googleFormsWatchesSchema>>> {
  return await googleFormsFetchJson(
    {
      schema: googleFormsWatchesSchema,
      accessToken: args.accessToken,
      url: formApiUrl(args.formId, "/watches"),
      init: { method: "GET" },
    },
    signal,
  );
}

async function createOrAdoptGoogleFormsWatch(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly topicName: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<z.infer<typeof googleFormsWatchSchema>>> {
  const created = await createGoogleFormsWatch(args, signal);
  if (created.kind === "ok") {
    return created;
  }
  const duplicate =
    created.status === 400 && created.googleStatus === "FAILED_PRECONDITION";
  if (!duplicate) {
    return created;
  }
  const listed = await listGoogleFormsWatches(args, signal);
  if (listed.kind !== "ok") {
    return listed;
  }
  const adopted = listed.value.watches?.find((watch) => {
    return (
      watch.eventType === "RESPONSES" &&
      watch.target?.topic.topicName === args.topicName
    );
  });
  return adopted
    ? { kind: "ok", value: adopted }
    : {
        kind: "error",
        status: 400,
        message:
          "This form already has the maximum 20 Google Forms watch subscribers",
      };
}

async function renewGoogleFormsWatch(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly watchId: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<z.infer<typeof googleFormsWatchSchema>>> {
  return await googleFormsFetchJson(
    {
      schema: googleFormsWatchSchema,
      accessToken: args.accessToken,
      url: formApiUrl(
        args.formId,
        `/watches/${encodeURIComponent(args.watchId)}:renew`,
      ),
      init: { method: "POST", body: JSON.stringify({}) },
    },
    signal,
  );
}

async function deleteGoogleFormsWatch(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly watchId: string;
  },
  signal: AbortSignal,
): Promise<
  GoogleFormsFetchResult<z.infer<typeof emptyGoogleFormsResponseSchema>>
> {
  return await googleFormsFetchJson(
    {
      schema: emptyGoogleFormsResponseSchema,
      accessToken: args.accessToken,
      url: formApiUrl(
        args.formId,
        `/watches/${encodeURIComponent(args.watchId)}`,
      ),
      init: { method: "DELETE" },
    },
    signal,
  );
}

function missingGoogleFormsWatch(error: GoogleFormsFetchError): boolean {
  return (
    error.status === 403 &&
    error.googleStatus === "PERMISSION_DENIED" &&
    error.message.includes("Watch not found or permission denied.")
  );
}

function watchExpireTime(watch: z.infer<typeof googleFormsWatchSchema>): Date {
  const value = new Date(watch.expireTime);
  if (Number.isNaN(value.getTime())) {
    throw new Error(
      `Invalid Google Forms watch expiration: ${watch.expireTime}`,
    );
  }
  return value;
}

async function upsertGoogleFormsCursor(args: {
  readonly db: Db;
  readonly automationId: string;
  readonly watchStateId: string;
  readonly cursor: string;
  readonly currentTime: Date;
}): Promise<void> {
  await args.db
    .insert(googleFormsAutomationCursors)
    .values({
      automationId: args.automationId,
      watchStateId: args.watchStateId,
      lastSeenSubmittedTime: args.cursor,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: googleFormsAutomationCursors.automationId,
      set: {
        watchStateId: args.watchStateId,
        lastSeenSubmittedTime: args.cursor,
        updatedAt: args.currentTime,
      },
    });
}

async function lockGoogleFormsCursorTarget(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly automationId: string;
    readonly connectorId: string;
    readonly formId: string;
    readonly allowStagedOfficialTarget: boolean;
  },
): Promise<boolean> {
  const [automation] = await db
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
        eq(workflowAutomations.eventConnectorId, args.connectorId),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${args.connectorId}`,
        sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${args.formId}`,
        args.allowStagedOfficialTarget
          ? or(
              eq(workflowAutomations.enabled, true),
              and(
                eq(workflowAutomations.enabled, false),
                eq(
                  workflowAutomations.officialReconciliationStatus,
                  "reconciling",
                ),
                isNotNull(workflowAutomations.officialBlueprintKey),
              ),
            )
          : eq(workflowAutomations.enabled, true),
      ),
    )
    .for("update")
    .limit(1);
  return automation !== undefined;
}

async function seedGoogleFormsAutomationCursor(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly automationId: string;
    readonly connectorId: string;
    readonly formId: string;
    readonly watchStateId: string;
    readonly accessToken: string;
    readonly seedCursor?: string;
    readonly allowStagedOfficialTarget: boolean;
  },
  signal: AbortSignal,
): Promise<"seeded" | "superseded" | "failed"> {
  const cursor =
    args.seedCursor === undefined
      ? await newestGoogleFormResponseTime(args, signal)
      : { kind: "ok" as const, value: args.seedCursor };
  signal.throwIfAborted();
  if (cursor.kind !== "ok") {
    return "failed";
  }
  if (!(await lockGoogleFormsCursorTarget(args.db, args))) {
    return "superseded";
  }
  signal.throwIfAborted();
  await upsertGoogleFormsCursor({
    db: args.db,
    automationId: args.automationId,
    watchStateId: args.watchStateId,
    cursor: cursor.value,
    currentTime: nowDate(),
  });
  return "seeded";
}

export async function ensureGoogleFormsWatchForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly formId: string;
    readonly connectorId: string;
    readonly resetAutomationId?: string;
    readonly seedCursor?: string;
    readonly allowStagedOfficialTarget?: boolean;
  },
  signal: AbortSignal,
): Promise<EnsureGoogleFormsWatchResult> {
  const topicName = optionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME");
  if (
    !topicName ||
    !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE") ||
    !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL")
  ) {
    return { kind: "bad_request", message: PUBSUB_CONFIGURATION_ERROR };
  }
  const access = await resolveGoogleFormsAccess(args, signal);
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return access;
  }
  return await args.db.transaction(async (tx) => {
    await lockGoogleFormsLifecycle(tx, args.connectorId, args.formId);
    signal.throwIfAborted();
    const hasConsumer = await hasEnabledGoogleFormsConsumer(
      {
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        formId: args.formId,
      },
      signal,
    );
    if (!hasConsumer && args.allowStagedOfficialTarget !== true) {
      return { kind: "ok", watchStateId: null };
    }
    const [existing] = await tx
      .select()
      .from(googleFormsWatchStates)
      .where(
        and(
          eq(googleFormsWatchStates.formId, args.formId),
          eq(googleFormsWatchStates.connectorId, args.connectorId),
          eq(googleFormsWatchStates.orgId, args.orgId),
          eq(googleFormsWatchStates.userId, args.userId),
        ),
      )
      .limit(1);
    let state = existing;
    if (!state) {
      const watch = await createOrAdoptGoogleFormsWatch(
        {
          accessToken: access.access.accessToken,
          formId: args.formId,
          topicName,
        },
        signal,
      );
      signal.throwIfAborted();
      if (watch.kind !== "ok") {
        return {
          kind: "bad_request",
          message: watch.message.includes("maximum 20")
            ? watch.message
            : "Failed to register Google Forms watch for event automation setup",
        };
      }
      const currentTime = nowDate();
      const [inserted] = await tx
        .insert(googleFormsWatchStates)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          connectorId: access.access.connectorId,
          formId: args.formId,
          watchId: watch.value.id,
          topicName,
          expireTime: watchExpireTime(watch.value),
          lastRenewedAt: currentTime,
          needsRewatch: false,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning();
      if (!inserted) {
        throw new Error("Failed to persist Google Forms watch state");
      }
      state = inserted;
    }
    if (args.resetAutomationId !== undefined) {
      const seeded = await seedGoogleFormsAutomationCursor(
        {
          db: tx,
          orgId: args.orgId,
          userId: args.userId,
          automationId: args.resetAutomationId,
          connectorId: args.connectorId,
          formId: args.formId,
          watchStateId: state.id,
          accessToken: access.access.accessToken,
          ...(args.seedCursor === undefined
            ? {}
            : { seedCursor: args.seedCursor }),
          allowStagedOfficialTarget: args.allowStagedOfficialTarget === true,
        },
        signal,
      );
      if (seeded === "failed") {
        return {
          kind: "bad_request",
          message: "Unable to seed the Google Forms response cursor",
        };
      }
      if (seeded === "superseded") {
        return { kind: "ok", watchStateId: null };
      }
    }
    return { kind: "ok", watchStateId: state.id };
  });
}

async function markGoogleFormsWatchForRetry(
  db: Db,
  stateId: string,
): Promise<void> {
  await db
    .update(googleFormsWatchStates)
    .set({ needsRewatch: true, updatedAt: nowDate() })
    .where(eq(googleFormsWatchStates.id, stateId));
}

async function reconcileGoogleFormsWatchState(
  args: {
    readonly db: Db;
    readonly state: GoogleFormsWatchStateRow;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<GoogleFormsWatchReconcileResult> {
  return await args.db.transaction(async (tx) => {
    await lockGoogleFormsLifecycle(
      tx,
      args.state.connectorId,
      args.state.formId,
    );
    signal.throwIfAborted();
    const [state] = await tx
      .select()
      .from(googleFormsWatchStates)
      .where(eq(googleFormsWatchStates.id, args.state.id))
      .limit(1);
    if (!state) {
      return { kind: "unchanged" };
    }
    const hasConsumer = await hasEnabledGoogleFormsConsumer(
      {
        db: tx,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
        formId: state.formId,
      },
      signal,
    );
    const access = await resolveGoogleFormsAccess(
      {
        db: tx,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      await markGoogleFormsWatchForRetry(tx, state.id);
      return { kind: "failed" };
    }
    if (!hasConsumer) {
      const deleted = await deleteGoogleFormsWatch(
        {
          accessToken: access.access.accessToken,
          formId: state.formId,
          watchId: state.watchId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (deleted.kind !== "ok" && !missingGoogleFormsWatch(deleted)) {
        await markGoogleFormsWatchForRetry(tx, state.id);
        return { kind: "failed" };
      }
      await tx
        .delete(googleFormsWatchStates)
        .where(eq(googleFormsWatchStates.id, state.id));
      return { kind: "stopped" };
    }
    const renewalDue =
      args.renewBefore !== undefined &&
      (state.needsRewatch ||
        state.expireTime.getTime() <= args.renewBefore.getTime());
    if (!renewalDue) {
      return { kind: "unchanged" };
    }
    let renewed = await renewGoogleFormsWatch(
      {
        accessToken: access.access.accessToken,
        formId: state.formId,
        watchId: state.watchId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (renewed.kind !== "ok" && missingGoogleFormsWatch(renewed)) {
      renewed = await createOrAdoptGoogleFormsWatch(
        {
          accessToken: access.access.accessToken,
          formId: state.formId,
          topicName: state.topicName,
        },
        signal,
      );
    }
    if (renewed.kind !== "ok") {
      await markGoogleFormsWatchForRetry(tx, state.id);
      return { kind: "failed" };
    }
    const currentTime = nowDate();
    await tx
      .update(googleFormsWatchStates)
      .set({
        watchId: renewed.value.id,
        expireTime: watchExpireTime(renewed.value),
        lastRenewedAt: currentTime,
        needsRewatch: false,
        updatedAt: currentTime,
      })
      .where(eq(googleFormsWatchStates.id, state.id));
    return renewed.value.id === state.watchId
      ? { kind: "renewed" }
      : { kind: "created" };
  });
}

async function prepareGoogleFormsWatchesForOwner(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  await args.db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: "google-forms" },
    });
    await reprojectGoogleFormsAutomationsForOwner(tx, args);
  });
  signal.throwIfAborted();

  const automations = await args.db
    .select({
      id: workflowAutomations.id,
      eventConfig: workflowAutomations.eventConfig,
      connectorId: workflowAutomations.eventConnectorId,
      cursorWatchStateId: googleFormsAutomationCursors.watchStateId,
      watchConnectorId: googleFormsWatchStates.connectorId,
      watchFormId: googleFormsWatchStates.formId,
      watchOrgId: googleFormsWatchStates.orgId,
      watchUserId: googleFormsWatchStates.userId,
    })
    .from(workflowAutomations)
    .leftJoin(
      googleFormsAutomationCursors,
      eq(googleFormsAutomationCursors.automationId, workflowAutomations.id),
    )
    .leftJoin(
      googleFormsWatchStates,
      eq(googleFormsWatchStates.id, googleFormsAutomationCursors.watchStateId),
    )
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
      ),
    );
  signal.throwIfAborted();
  let succeeded = true;
  for (const automation of automations) {
    const config = googleFormsResponseSubmittedEventConfigSchema.parse(
      automation.eventConfig,
    );
    if (automation.connectorId === null) {
      continue;
    }
    const cursorIsExact =
      automation.cursorWatchStateId !== null &&
      automation.watchConnectorId === automation.connectorId &&
      automation.watchFormId === config.form.id &&
      automation.watchOrgId === args.orgId &&
      automation.watchUserId === args.userId &&
      config.connectorId === automation.connectorId;
    if (cursorIsExact) {
      continue;
    }
    const ensured = await ensureGoogleFormsWatchForUser(
      {
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        connectorId: automation.connectorId,
        formId: config.form.id,
        resetAutomationId: automation.id,
      },
      signal,
    );
    signal.throwIfAborted();
    succeeded &&= ensured.kind === "ok";
  }
  return succeeded;
}

async function reconcileGoogleFormsWatchesForOwner(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly renewBefore?: Date;
  },
  signal: AbortSignal,
): Promise<boolean> {
  let succeeded = await prepareGoogleFormsWatchesForOwner(args, signal);
  signal.throwIfAborted();
  const states = await args.db
    .select()
    .from(googleFormsWatchStates)
    .where(
      and(
        eq(googleFormsWatchStates.orgId, args.orgId),
        eq(googleFormsWatchStates.userId, args.userId),
      ),
    );
  signal.throwIfAborted();
  for (const state of states) {
    const result = await reconcileGoogleFormsWatchState(
      {
        db: args.db,
        state,
        ...(args.renewBefore === undefined
          ? {}
          : { renewBefore: args.renewBefore }),
      },
      signal,
    );
    signal.throwIfAborted();
    succeeded &&= result.kind !== "failed";
  }
  return succeeded;
}

export async function reconcileGoogleFormsWatchesForUser(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  return await reconcileGoogleFormsWatchesForOwner(args, signal);
}

export interface PendingGoogleFormsWatchStop {
  readonly accessToken: string;
  readonly watches: readonly {
    readonly formId: string;
    readonly watchId: string;
  }[];
}

export async function prepareGoogleFormsWatchStopForConnector(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<PendingGoogleFormsWatchStop | null> {
  const access = await resolveGoogleFormsAccess(args, signal);
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return null;
  }
  const states = await args.db
    .select({
      formId: googleFormsWatchStates.formId,
      watchId: googleFormsWatchStates.watchId,
    })
    .from(googleFormsWatchStates)
    .where(eq(googleFormsWatchStates.connectorId, args.connectorId));
  signal.throwIfAborted();
  return { accessToken: access.access.accessToken, watches: states };
}

export async function stopPreparedGoogleFormsWatches(
  pending: PendingGoogleFormsWatchStop,
  signal: AbortSignal,
): Promise<void> {
  let failed = false;
  for (const watch of pending.watches) {
    const deleted = await deleteGoogleFormsWatch(
      {
        accessToken: pending.accessToken,
        formId: watch.formId,
        watchId: watch.watchId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (deleted.kind !== "ok" && !missingGoogleFormsWatch(deleted)) {
      failed = true;
    }
  }
  if (failed) {
    throw new Error("Failed to stop one or more Google Forms watches");
  }
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
  const audience = optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE");
  const expectedEmail = optionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  );
  if (!audience || !expectedEmail) {
    return {
      kind: "config_error",
      message: "Google Forms Pub/Sub push OIDC env vars are not configured",
    };
  }
  if (!args.authorization?.startsWith("Bearer ")) {
    return { kind: "unauthorized" };
  }
  const verifier =
    pubSubOidcVerifierOverride.get() ?? defaultPubSubOidcVerifier;
  const claims = await tapError(
    verifier(args.authorization.slice("Bearer ".length), audience, signal),
  );
  signal.throwIfAborted();
  return claims?.email === expectedEmail && claims.emailVerified
    ? { kind: "ok" }
    : { kind: "unauthorized" };
}

function decodePubSubPush(rawBody: string):
  | {
      readonly kind: "ok";
      readonly messageId: string;
      readonly formId: string;
      readonly watchId: string;
      readonly eventType: "RESPONSES";
    }
  | { readonly kind: "bad_request"; readonly message: string } {
  const raw = safeJsonParse(rawBody);
  if (raw === undefined) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  const push = pubSubPushSchema.safeParse(raw);
  if (!push.success) {
    return { kind: "bad_request", message: "Invalid Pub/Sub push payload" };
  }
  return {
    kind: "ok",
    messageId: push.data.message.messageId,
    formId: push.data.message.attributes.formId,
    watchId: push.data.message.attributes.watchId,
    eventType: push.data.message.attributes.eventType,
  };
}

type DecodedGoogleFormsPubSubPush = Extract<
  ReturnType<typeof decodePubSubPush>,
  { readonly kind: "ok" }
>;

interface GoogleFormsEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GoogleFormsResponseSubmittedEventConfig;
  readonly cursor: string;
}

async function loadGoogleFormsWatchStates(
  args: {
    readonly db: Db;
    readonly decoded: DecodedGoogleFormsPubSubPush;
  },
  signal: AbortSignal,
): Promise<GoogleFormsWatchStateRow[]> {
  const exact = await args.db
    .select()
    .from(googleFormsWatchStates)
    .where(
      and(
        eq(googleFormsWatchStates.watchId, args.decoded.watchId),
        eq(googleFormsWatchStates.formId, args.decoded.formId),
      ),
    );
  signal.throwIfAborted();
  return exact;
}

async function loadGoogleFormsEventAutomations(
  args: {
    readonly db: Db;
    readonly state: GoogleFormsWatchStateRow;
  },
  signal: AbortSignal,
): Promise<GoogleFormsEventAutomationRow[]> {
  const rows = await args.db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
      workflowName: workflows.name,
      workflowDisplayName: workflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      cursor: googleFormsAutomationCursors.lastSeenSubmittedTime,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .innerJoin(
      googleFormsAutomationCursors,
      eq(googleFormsAutomationCursors.automationId, workflowAutomations.id),
    )
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
        eq(googleFormsAutomationCursors.watchStateId, args.state.id),
        eq(workflowAutomations.orgId, args.state.orgId),
        eq(workflowAutomations.ownerUserId, args.state.userId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
        eq(workflowAutomations.eventConnectorId, args.state.connectorId),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${args.state.connectorId}`,
      ),
    );
  signal.throwIfAborted();
  const result: GoogleFormsEventAutomationRow[] = [];
  for (const row of rows) {
    const config = googleFormsResponseSubmittedEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (
      !config.success ||
      config.data.connectorId !== args.state.connectorId ||
      config.data.form.id !== args.state.formId
    ) {
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
          currentTime: nowDate(),
        });
      }));
    result.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
      cursor: row.cursor,
    });
  }
  return result;
}

async function listGoogleFormResponses(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly cursor: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<readonly GoogleFormResponse[]>> {
  let pageToken: string | undefined;
  const responses: GoogleFormResponse[] = [];
  do {
    const page = await googleFormsFetchJson(
      {
        schema: googleFormResponsesSchema,
        accessToken: args.accessToken,
        url: responsesListUrl({
          formId: args.formId,
          cursor: args.cursor,
          ...(pageToken === undefined ? {} : { pageToken }),
        }),
        init: { method: "GET" },
      },
      signal,
    );
    signal.throwIfAborted();
    if (page.kind !== "ok") {
      return page;
    }
    responses.push(...(page.value.responses ?? []));
    pageToken = page.value.nextPageToken;
  } while (pageToken !== undefined);
  responses.sort((left, right) => {
    const leftMicros = googleFormsTimestampMicros(left.lastSubmittedTime);
    const rightMicros = googleFormsTimestampMicros(right.lastSubmittedTime);
    return leftMicros < rightMicros ? -1 : leftMicros > rightMicros ? 1 : 0;
  });
  return { kind: "ok", value: responses };
}

function googleFormsTimestampMicros(value: string): bigint {
  const match = GOOGLE_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid Google Forms timestamp: ${value}`);
  }
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(`Invalid Google Forms timestamp: ${value}`);
  }
  const wholeSecond = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return BigInt(wholeSecond) * 1000n + BigInt(fraction.padEnd(6, "0"));
}

function googleFormsChangeType(
  response: GoogleFormResponse,
): "created" | "updated" {
  return googleFormsTimestampMicros(response.lastSubmittedTime) -
    googleFormsTimestampMicros(response.createTime) <
    1_000_000n
    ? "created"
    : "updated";
}

async function responsePreviouslyDelivered(args: {
  readonly db: Db;
  readonly automationId: string;
  readonly responseId: string;
  readonly lastSubmittedTime: string;
}): Promise<boolean> {
  const [previous] = await args.db
    .select({ id: googleFormsProcessedEvents.id })
    .from(googleFormsProcessedEvents)
    .where(
      and(
        eq(googleFormsProcessedEvents.automationId, args.automationId),
        eq(googleFormsProcessedEvents.responseId, args.responseId),
        ne(
          googleFormsProcessedEvents.lastSubmittedTime,
          args.lastSubmittedTime,
        ),
      ),
    )
    .limit(1);
  return previous !== undefined;
}

class GoogleFormsSourceTransitionChangedError extends Error {
  constructor() {
    super("Google Forms source changed before durable queue admission");
    this.name = "GoogleFormsSourceTransitionChangedError";
  }
}

async function persistGoogleFormsSourceTransition(
  args: {
    readonly tx: WorkflowQueueAdmissionTransaction;
    readonly state: GoogleFormsWatchStateRow;
    readonly automation: GoogleFormsEventAutomationRow;
    readonly decoded: DecodedGoogleFormsPubSubPush;
    readonly response: GoogleFormResponse;
    readonly cursor: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await lockConnectorAccountTarget(args.tx, {
    orgId: args.automation.automation.orgId,
    userId: args.automation.automation.ownerUserId,
    target: { kind: "builtin", connectorSlug: "google-forms" },
  });
  const [currentState] = await args.tx
    .select({ id: googleFormsWatchStates.id })
    .from(googleFormsWatchStates)
    .where(
      and(
        eq(googleFormsWatchStates.id, args.state.id),
        eq(googleFormsWatchStates.orgId, args.state.orgId),
        eq(googleFormsWatchStates.userId, args.state.userId),
        eq(googleFormsWatchStates.connectorId, args.state.connectorId),
        eq(googleFormsWatchStates.formId, args.decoded.formId),
        eq(googleFormsWatchStates.watchId, args.decoded.watchId),
      ),
    )
    .for("key share")
    .limit(1);
  const [currentAutomation] = await args.tx
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automation.automation.id),
        eq(workflowAutomations.orgId, args.state.orgId),
        eq(workflowAutomations.ownerUserId, args.state.userId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, args.state.connectorId),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${args.state.connectorId}`,
        sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${args.state.formId}`,
      ),
    )
    .for("update")
    .limit(1);
  const [currentCursor] = await args.tx
    .select({ automationId: googleFormsAutomationCursors.automationId })
    .from(googleFormsAutomationCursors)
    .where(
      and(
        eq(
          googleFormsAutomationCursors.automationId,
          args.automation.automation.id,
        ),
        eq(googleFormsAutomationCursors.watchStateId, args.state.id),
        eq(googleFormsAutomationCursors.lastSeenSubmittedTime, args.cursor),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!currentState || !currentAutomation || !currentCursor) {
    throw new GoogleFormsSourceTransitionChangedError();
  }
  const [processed] = await args.tx
    .insert(googleFormsProcessedEvents)
    .values({
      watchStateId: args.state.id,
      automationId: args.automation.automation.id,
      pubsubMessageId: args.decoded.messageId,
      responseId: args.response.responseId,
      lastSubmittedTime: args.response.lastSubmittedTime,
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: googleFormsProcessedEvents.id });
  if (!processed) {
    throw new GoogleFormsSourceTransitionChangedError();
  }
  const [advanced] = await args.tx
    .update(googleFormsAutomationCursors)
    .set({
      lastSeenSubmittedTime: args.response.lastSubmittedTime,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(
          googleFormsAutomationCursors.automationId,
          args.automation.automation.id,
        ),
        eq(googleFormsAutomationCursors.watchStateId, args.state.id),
        eq(googleFormsAutomationCursors.lastSeenSubmittedTime, args.cursor),
      ),
    )
    .returning({ automationId: googleFormsAutomationCursors.automationId });
  signal.throwIfAborted();
  if (!advanced) {
    throw new GoogleFormsSourceTransitionChangedError();
  }
}

function googleFormsTriggerContext(args: {
  readonly automation: GoogleFormsEventAutomationRow;
  readonly response: GoogleFormResponse;
  readonly previouslyDelivered: boolean;
}): WorkflowAutomationContext {
  const changeType = googleFormsChangeType(args.response);
  const respondent = args.response.respondentEmail ?? "an anonymous respondent";
  return {
    workflowName: args.automation.workflowName,
    eventType: "google-forms-response-submitted",
    trigger: `Google Forms response ${args.response.responseId} from ${respondent} was ${changeType} on ${args.automation.config.form.title}.`,
    notes: [
      `Response answers are not included below. Use GET /v1/forms/${args.automation.config.form.id}/responses/${args.response.responseId} for answers, then GET /v1/forms/${args.automation.config.form.id} to map questionId values to question text.`,
    ],
    event: {
      automationId: args.automation.automation.id,
      formId: args.automation.config.form.id,
      formTitle: args.automation.config.form.title,
      formUrl: args.automation.config.form.url,
      responseId: args.response.responseId,
      changeType,
      createTime: args.response.createTime,
      lastSubmittedTime: args.response.lastSubmittedTime,
      respondentEmail: args.response.respondentEmail ?? null,
      previouslyDelivered: args.previouslyDelivered,
    },
  };
}

function googleFormsTriggerBrief(args: {
  readonly automation: GoogleFormsEventAutomationRow;
  readonly response: GoogleFormResponse;
}): string {
  return [
    `Google Forms response ${googleFormsChangeType(args.response)}`,
    `Form: ${args.automation.config.form.title}`,
    `Response ID: ${args.response.responseId}`,
  ].join("\n");
}

type GoogleFormsRunStarter = (args: {
  readonly state: GoogleFormsWatchStateRow;
  readonly automation: GoogleFormsEventAutomationRow;
  readonly decoded: DecodedGoogleFormsPubSubPush;
  readonly response: GoogleFormResponse;
  readonly cursor: string;
  readonly previouslyDelivered: boolean;
  readonly timing: AutomationEventRunTiming;
}) => Promise<"ok" | "duplicate" | "error">;

const startGoogleFormsWorkflowRun$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
      readonly automation: GoogleFormsEventAutomationRow;
      readonly decoded: DecodedGoogleFormsPubSubPush;
      readonly response: GoogleFormResponse;
      readonly cursor: string;
      readonly previouslyDelivered: boolean;
      readonly timing: AutomationEventRunTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "duplicate" | "error"> => {
    const context = googleFormsTriggerContext(args);
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
          triggerBrief: googleFormsTriggerBrief(args),
          persistSourceTransition: async (tx) => {
            await persistGoogleFormsSourceTransition(
              {
                tx,
                state: args.state,
                automation: args.automation,
                decoded: args.decoded,
                response: args.response,
                cursor: args.cursor,
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
      if (started.error instanceof GoogleFormsSourceTransitionChangedError) {
        return "duplicate";
      }
      throw started.error;
    }
    return started.value.kind === "ok" || started.value.kind === "enqueued"
      ? "ok"
      : "error";
  },
);

type GoogleFormsDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

async function eventAlreadyProcessed(args: {
  readonly db: Db;
  readonly stateId: string;
  readonly automationId: string;
  readonly response: GoogleFormResponse;
}): Promise<boolean> {
  const [processed] = await args.db
    .select({ id: googleFormsProcessedEvents.id })
    .from(googleFormsProcessedEvents)
    .where(
      and(
        eq(googleFormsProcessedEvents.watchStateId, args.stateId),
        eq(googleFormsProcessedEvents.automationId, args.automationId),
        eq(googleFormsProcessedEvents.responseId, args.response.responseId),
        eq(
          googleFormsProcessedEvents.lastSubmittedTime,
          args.response.lastSubmittedTime,
        ),
      ),
    )
    .limit(1);
  return processed !== undefined;
}

async function dispatchGoogleFormsAutomation(
  args: {
    readonly db: Db;
    readonly state: GoogleFormsWatchStateRow;
    readonly automation: GoogleFormsEventAutomationRow;
    readonly decoded: DecodedGoogleFormsPubSubPush;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GoogleFormsRunStarter;
  },
  signal: AbortSignal,
): Promise<GoogleFormsDispatchStateResult> {
  const access = await resolveGoogleFormsAccess(
    {
      db: args.db,
      orgId: args.automation.automation.orgId,
      userId: args.automation.automation.ownerUserId,
      connectorId: args.state.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  const listed = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_external_events",
    async () => {
      return await listGoogleFormResponses(
        {
          accessToken: access.access.accessToken,
          formId: args.automation.config.form.id,
          cursor: args.automation.cursor,
        },
        signal,
      );
    },
  );
  if (listed.kind !== "ok") {
    log.warn("Google Forms response lookup failed", {
      automationId: args.automation.automation.id,
      status: listed.status,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  let cursor = args.automation.cursor;
  let dispatched = 0;
  let duplicates = 0;
  for (const response of listed.value) {
    if (
      await eventAlreadyProcessed({
        db: args.db,
        stateId: args.state.id,
        automationId: args.automation.automation.id,
        response,
      })
    ) {
      duplicates += 1;
      continue;
    }
    const previouslyDelivered = await responsePreviouslyDelivered({
      db: args.db,
      automationId: args.automation.automation.id,
      responseId: response.responseId,
      lastSubmittedTime: response.lastSubmittedTime,
    });
    const result = await args.startRun({
      state: args.state,
      automation: args.automation,
      decoded: args.decoded,
      response,
      cursor,
      previouslyDelivered,
      timing: args.sourceTiming.createRunTiming(),
    });
    signal.throwIfAborted();
    if (result === "error") {
      return {
        kind: "run_error",
        message: "Failed to start Google Forms response workflow run",
      };
    }
    if (result === "duplicate") {
      duplicates += 1;
      continue;
    }
    dispatched += 1;
    cursor = response.lastSubmittedTime;
  }
  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGoogleFormsWatchState(
  args: {
    readonly db: Db;
    readonly state: GoogleFormsWatchStateRow;
    readonly decoded: DecodedGoogleFormsPubSubPush;
    readonly sourceTiming: AutomationEventSourceTiming;
    readonly startRun: GoogleFormsRunStarter;
  },
  signal: AbortSignal,
): Promise<GoogleFormsDispatchStateResult> {
  const automations = await args.sourceTiming.measure(
    "api_dispatch_pre_create_agent_automation_event_load_automations",
    async () => {
      return await loadGoogleFormsEventAutomations(args, signal);
    },
  );
  let dispatched = 0;
  let duplicates = 0;
  for (const automation of automations) {
    const result = await dispatchGoogleFormsAutomation(
      {
        ...args,
        automation,
        sourceTiming: args.sourceTiming.fork(),
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

type GoogleFormsPubSubPushResult =
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

export const dispatchGoogleFormsPubSubPush$ = command(
  async (
    { set },
    args: {
      readonly authorization: string | null;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsPubSubPushResult> => {
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
    if (!optionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME")) {
      return {
        kind: "config_error",
        message: "GOOGLE_FORMS_PUBSUB_TOPIC_NAME is not configured",
      };
    }
    const db = set(writeDb$);
    const sourceTiming = new AutomationEventSourceTiming(
      "google_forms",
      args.apiStartTime,
    );
    const states = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await loadGoogleFormsWatchStates({ db, decoded }, signal);
      },
    );
    signal.throwIfAborted();
    const startRun: GoogleFormsRunStarter = async (runArgs) => {
      return await set(
        startGoogleFormsWorkflowRun$,
        { ...runArgs, apiStartTime: args.apiStartTime },
        signal,
      );
    };
    let dispatched = 0;
    let duplicates = 0;
    for (const state of states) {
      const result = await dispatchGoogleFormsWatchState(
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

interface GoogleFormsWatchOwner {
  readonly orgId: string;
  readonly userId: string;
}

async function renewGoogleFormsWatchOwners(
  args: {
    readonly db: Db;
    readonly owners: readonly GoogleFormsWatchOwner[];
    readonly renewBefore: Date;
  },
  signal: AbortSignal,
): Promise<{ readonly renewed: number; readonly failed: number }> {
  let renewed = 0;
  let failed = 0;
  for (const owner of args.owners) {
    const prepared = await prepareGoogleFormsWatchesForOwner(
      { db: args.db, ...owner },
      signal,
    );
    signal.throwIfAborted();
    failed += prepared ? 0 : 1;
    const states = await args.db
      .select()
      .from(googleFormsWatchStates)
      .where(
        and(
          eq(googleFormsWatchStates.orgId, owner.orgId),
          eq(googleFormsWatchStates.userId, owner.userId),
          or(
            eq(googleFormsWatchStates.needsRewatch, true),
            lte(googleFormsWatchStates.expireTime, args.renewBefore),
          ),
        ),
      )
      .orderBy(asc(googleFormsWatchStates.expireTime));
    signal.throwIfAborted();
    for (const state of states) {
      const result = await reconcileGoogleFormsWatchState(
        { db: args.db, state, renewBefore: args.renewBefore },
        signal,
      );
      signal.throwIfAborted();
      renewed += result.kind === "renewed" || result.kind === "created" ? 1 : 0;
      failed += result.kind === "failed" ? 1 : 0;
    }
  }
  return { renewed, failed };
}

export const renewGoogleFormsWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const renewBefore = new Date(nowDate().getTime() + WATCH_RENEWAL_WINDOW_MS);
    const [automationOwners, stateOwners] = await Promise.all([
      db
        .selectDistinct({
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
              "google-forms-response-submitted",
            ),
          ),
        ),
      db
        .selectDistinct({
          orgId: googleFormsWatchStates.orgId,
          userId: googleFormsWatchStates.userId,
        })
        .from(googleFormsWatchStates),
    ]);
    signal.throwIfAborted();
    const owners = new Map<
      string,
      { readonly orgId: string; readonly userId: string }
    >();
    for (const owner of [...automationOwners, ...stateOwners]) {
      owners.set(`${owner.orgId}\n${owner.userId}`, owner);
    }
    return await renewGoogleFormsWatchOwners(
      { db, owners: [...owners.values()], renewBefore },
      signal,
    );
  },
);

export const renewGoogleFormsWatchScope$ = command(
  async ({ set }, owner: GoogleFormsWatchOwner, signal: AbortSignal) => {
    return await renewGoogleFormsWatchOwners(
      {
        db: set(writeDb$),
        owners: [owner],
        renewBefore: new Date(nowDate().getTime() + WATCH_RENEWAL_WINDOW_MS),
      },
      signal,
    );
  },
);
