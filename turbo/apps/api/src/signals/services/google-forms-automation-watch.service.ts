import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  observedWorkflowAutomationCondition,
  type WorkflowAutomationSnapshot,
} from "./workflow-automation-snapshot";
import {
  googleFormsResponseSubmittedEventConfigSchema,
  type GoogleFormsResponseSubmittedEventConfig,
  type GoogleFormsResponseSubmittedEventCreateConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  googleFormsAutomationCursors,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import * as z from "zod";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle, safeJsonParse, tapError, safeUrlParse } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  loadBuiltinConnectorCredentialConnection$,
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
  builtinConnectorCredentialRuntimeValueRef,
} from "./builtin-connector-credential-runtime.service";
import { googleFormsAccountProjectionStatement } from "./google-forms-automation-account.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { readConnectorRuntimeAuthSelection$ } from "./connector-catalog-slug-source.service";
import { officialAutomationLifecycleCondition } from "./workflow-automation-write-condition";

import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";

const GOOGLE_FORMS_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_FORMS_TOKEN";

const GOOGLE_FORMS_API_BASE = "https://forms.googleapis.com/v1/forms";

const GOOGLE_FORMS_RESPONSE_FIELDS =
  "responses(responseId,createTime,lastSubmittedTime,respondentEmail),nextPageToken";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const PUBSUB_CONFIGURATION_ERROR =
  "Google Forms Pub/Sub push is not configured";

const GOOGLE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

export const googleFormResponseSchema = z.object({
  responseId: z.string(),
  createTime: z.string(),
  lastSubmittedTime: z.string(),
  respondentEmail: z.string().nullable().optional(),
});

export const googleFormResponsesSchema = z.object({
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

export type GoogleFormsWatchStateRow =
  typeof googleFormsWatchStates.$inferSelect;

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

export type GoogleFormsFetchResult<T> =
  GoogleFormsFetchOk<T> | GoogleFormsFetchError;

type EnsureGoogleFormsWatchResult =
  | {
      readonly kind: "ok";
      readonly watchStateId: string | null;
      readonly enabledAutomation?: AutomationRow;
    }
  | { readonly kind: "bad_request" | "superseded"; readonly message: string };

type GoogleFormsWatchReconcileResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "created" }
  | { readonly kind: "renewed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" };

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

export const resolveGoogleFormsAccess$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsAccessResult> => {
    const currentTime = nowDate();
    const snapshot = await set(
      readConnectorRuntimeAuthSelection$,
      {
        connectorSlugs: ["google-forms"],
      },
      signal,
    );
    signal.throwIfAborted();
    const loaded = await set(loadBuiltinConnectorCredentialConnection$, {
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
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName: GOOGLE_FORMS_ACCESS_TOKEN_ENVIRONMENT_NAME,
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
  },
);

export async function googleFormsFetchJson<T>(
  args: {
    readonly schema: z.ZodType<T>;
    readonly accessToken: string;
    readonly url: string;
    readonly init: RequestInit;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<T>> {
  const response = await tapError(
    (async () => {
      const acceptedResponse = await settle(
        accept(
          fetch(args.url, {
            ...args.init,
            headers: {
              Authorization: `Bearer ${args.accessToken}`,
              "Content-Type": "application/json",
              ...args.init.headers,
            },
          }),
          [200, 204],
        ),
      );
      if (!acceptedResponse.ok) {
        const error = acceptedResponse.error;
        if (error instanceof HttpStatusError && error.status >= 300) {
          return error.response;
        }
        throw error;
      }
      return acceptedResponse.value;
    })(),
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

export function formApiUrl(formId: string, suffix = ""): string {
  return `${GOOGLE_FORMS_API_BASE}/${encodeURIComponent(formId)}${suffix}`;
}

export function responsesListUrl(args: {
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

export async function newestGoogleFormResponseTime(
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

export const hasEnabledGoogleFormsConsumer$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly formId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    const [consumer] = await db
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
  },
);

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

export async function deleteGoogleFormsWatch(
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

export function missingGoogleFormsWatch(error: GoogleFormsFetchError): boolean {
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

const prepareGoogleFormsWatch$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly formId: string;
      readonly topicName: string;
      readonly accessToken: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [existing] = await db
      .select({ needsRewatch: googleFormsWatchStates.needsRewatch })
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
    signal.throwIfAborted();
    return existing && !existing.needsRewatch
      ? null
      : await createOrAdoptGoogleFormsWatch(args, signal);
  },
);

async function prepareGoogleFormsCursor(
  args: {
    readonly accessToken: string;
    readonly formId: string;
    readonly resetAutomationId?: string;
    readonly seedCursor?: string;
  },
  signal: AbortSignal,
): Promise<GoogleFormsFetchResult<string> | null> {
  if (args.resetAutomationId === undefined) {
    return null;
  }
  return args.seedCursor === undefined
    ? await newestGoogleFormResponseTime(args, signal)
    : { kind: "ok", value: args.seedCursor };
}

function missingGoogleFormsConsumer(
  automationId: string | undefined,
): EnsureGoogleFormsWatchResult {
  return automationId === undefined
    ? { kind: "ok", watchStateId: null }
    : {
        kind: "superseded",
        message:
          "Google Forms automation changed during watch setup; retry the request",
      };
}

interface GoogleFormsActivation {
  readonly officialAutomation?: AutomationRow;
  readonly automationSnapshot: WorkflowAutomationSnapshot;
  readonly automationId: string;
  readonly workflowId: string;
  readonly eventConfig: GoogleFormsResponseSubmittedEventConfig;
  readonly nextRunAt: Date | null;
  readonly inheritedAutonomyBudget?: number;
}

function googleFormsPublicationHasConsumer(
  hasConsumer: boolean,
  args: {
    readonly allowStagedOfficialTarget?: boolean;
    readonly activation?: GoogleFormsActivation;
  },
) {
  return (
    hasConsumer ||
    args.allowStagedOfficialTarget === true ||
    args.activation !== undefined
  );
}

export const ensureGoogleFormsWatchForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly formId: string;
      readonly connectorId: string;
      readonly resetAutomationId?: string;
      readonly seedCursor?: string;
      readonly allowStagedOfficialTarget?: boolean;
      readonly activation?: GoogleFormsActivation;
    },
    signal: AbortSignal,
  ): Promise<EnsureGoogleFormsWatchResult> => {
    const topicName = optionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME");
    if (
      !topicName ||
      !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE") ||
      !optionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL")
    ) {
      return { kind: "bad_request", message: PUBSUB_CONFIGURATION_ERROR };
    }
    const access = await set(resolveGoogleFormsAccess$, args, signal);
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      return access;
    }
    const hasConsumer = await set(hasEnabledGoogleFormsConsumer$, args, signal);
    if (!googleFormsPublicationHasConsumer(hasConsumer, args)) {
      return missingGoogleFormsConsumer(args.resetAutomationId);
    }
    const prepared = await set(
      prepareGoogleFormsWatch$,
      {
        ...args,
        topicName,
        accessToken: access.access.accessToken,
      },
      signal,
    );
    if (prepared?.kind === "error") {
      return {
        kind: "bad_request",
        message: prepared.message.includes("maximum 20")
          ? prepared.message
          : "Failed to register Google Forms watch for event automation setup",
      };
    }
    // Cursor seeding can paginate remote responses. Finish it before publication.
    const cursor = await prepareGoogleFormsCursor(
      {
        ...args,
        accessToken: access.access.accessToken,
      },
      signal,
    );
    signal.throwIfAborted();
    if (cursor?.kind === "error") {
      return {
        kind: "bad_request",
        message: "Unable to seed the Google Forms response cursor",
      };
    }
    const publication = {
      ...args,
      topicName,
      watch: prepared?.kind === "ok" ? prepared.value : null,
      cursor: cursor?.kind === "ok" ? cursor.value : null,
    };
    return args.activation === undefined
      ? await set(publishGoogleFormsWatch$, publication, signal)
      : await set(
          publishGoogleFormsActivation$,
          { ...publication, activation: args.activation },
          signal,
        );
  },
);

interface GoogleFormsWatchPublication {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly formId: string;
  readonly topicName: string;
  readonly watch: z.infer<typeof googleFormsWatchSchema> | null;
  readonly cursor: string | null;
  readonly resetAutomationId?: string;
  readonly allowStagedOfficialTarget?: boolean;
  readonly activation?: GoogleFormsActivation;
}

const GOOGLE_FORMS_WATCH_CHANGED = {
  kind: "superseded",
  message: "Google Forms watch changed during setup; retry the request",
} as const;

function googleFormsCursorTargetCondition(args: {
  readonly automationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly formId: string;
  readonly allowStagedOfficialTarget?: boolean;
}) {
  return and(
    eq(workflowAutomations.id, args.automationId),
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.eventType, "google-forms-response-submitted"),
    eq(workflowAutomations.eventConnectorId, args.connectorId),
    sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ${args.connectorId}`,
    sql`${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${args.formId}`,
    args.allowStagedOfficialTarget === true
      ? or(
          eq(workflowAutomations.enabled, true),
          and(
            eq(workflowAutomations.enabled, false),
            eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
            isNotNull(workflowAutomations.officialBlueprintKey),
          ),
        )
      : eq(workflowAutomations.enabled, true),
  );
}

/** Reads the watch state for the publication, persisting a prepared watch. */
const upsertPreparedGoogleFormsWatchState$ = command(
  async (
    { set },
    args: GoogleFormsWatchPublication,
    signal: AbortSignal,
  ): Promise<GoogleFormsWatchStateRow | undefined> => {
    const db = set(writeDb$);
    if (args.watch === null) {
      const [current] = await db
        .select()
        .from(googleFormsWatchStates)
        .where(googleFormsWatchIdentityCondition(args))
        .limit(1);
      signal.throwIfAborted();
      return current;
    }
    const currentTime = nowDate();
    const [state] = await db
      .insert(googleFormsWatchStates)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        formId: args.formId,
        watchId: args.watch.id,
        topicName: args.topicName,
        expireTime: watchExpireTime(args.watch),
        lastRenewedAt: currentTime,
        needsRewatch: false,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoUpdate({
        target: [
          googleFormsWatchStates.connectorId,
          googleFormsWatchStates.formId,
        ],
        set: {
          watchId: args.watch.id,
          topicName: args.topicName,
          expireTime: watchExpireTime(args.watch),
          lastRenewedAt: currentTime,
          needsRewatch: false,
          updatedAt: currentTime,
        },
      })
      .returning();
    signal.throwIfAborted();
    return state;
  },
);

const publishGoogleFormsWatch$ = command(
  async (
    { set },
    args: GoogleFormsWatchPublication,
    signal: AbortSignal,
  ): Promise<EnsureGoogleFormsWatchResult> => {
    const db = set(writeDb$);
    const state = await set(upsertPreparedGoogleFormsWatchState$, args, signal);
    if (!state) {
      return GOOGLE_FORMS_WATCH_CHANGED;
    }
    if (args.resetAutomationId === undefined || args.cursor === null) {
      return { kind: "ok", watchStateId: state.id };
    }
    const timestamp = sql`${nowDate().toISOString()}::timestamp`;
    // Existing progress belongs to delivered responses, not watch preparation.
    // Repair only rebinds; explicit disable/source changes delete the old
    // cursor before a new baseline may be inserted.
    const seeded = (
      await db.execute(sql`INSERT INTO ${googleFormsAutomationCursors} (
        automation_id, watch_state_id, last_seen_submitted_time, created_at, updated_at
      )
      SELECT ${args.resetAutomationId}::uuid, ${state.id}::uuid, ${args.cursor},
        ${timestamp}, ${timestamp}
      WHERE EXISTS (
        SELECT 1 FROM ${workflowAutomations}
        WHERE ${googleFormsCursorTargetCondition({
          ...args,
          automationId: args.resetAutomationId,
        })}
      )
      ON CONFLICT (automation_id) DO UPDATE SET
        watch_state_id = EXCLUDED.watch_state_id,
        updated_at = EXCLUDED.updated_at
      RETURNING automation_id`)
    ).rowCount;
    signal.throwIfAborted();
    return seeded === 0
      ? {
          kind: "superseded",
          message:
            "Google Forms automation changed during watch setup; retry the request",
        }
      : { kind: "ok", watchStateId: state.id };
  },
);

function googleFormsWatchIdentityCondition(args: GoogleFormsWatchPublication) {
  return and(
    eq(googleFormsWatchStates.connectorId, args.connectorId),
    eq(googleFormsWatchStates.formId, args.formId),
    eq(googleFormsWatchStates.orgId, args.orgId),
    eq(googleFormsWatchStates.userId, args.userId),
  );
}

const publishGoogleFormsActivation$ = command(
  async (
    { set },
    args: GoogleFormsWatchPublication & {
      readonly activation: GoogleFormsActivation;
    },
    signal: AbortSignal,
  ): Promise<EnsureGoogleFormsWatchResult> => {
    const db = set(writeDb$);
    const { activation } = args;
    const cursor = args.cursor;
    if (cursor === null) {
      throw new Error("Google Forms activation requires its baseline");
    }
    const state = await set(upsertPreparedGoogleFormsWatchState$, args, signal);
    if (!state) {
      return GOOGLE_FORMS_WATCH_CHANGED;
    }
    const currentTime = nowDate();
    const columns = workflowAutomationColumns();
    const enabled = db.$with("enabled_google_forms_automation").as(
      db
        .update(workflowAutomations)
        .set({
          eventConnectorId: args.connectorId,
          eventConfig: activation.eventConfig,
          updatedAt: currentTime,
          enabled: true,
          nextRunAt: activation.nextRunAt,
          consecutiveFailures: 0,
          ...(activation.officialAutomation === undefined
            ? {}
            : { officialIntendedEnabled: true }),
          ...(activation.inheritedAutonomyBudget === undefined
            ? {}
            : { autonomyBudget: activation.inheritedAutonomyBudget }),
        })
        .where(
          and(
            eq(workflowAutomations.id, activation.automationId),
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.ownerUserId, args.userId),
            eq(workflowAutomations.workflowId, activation.workflowId),
            eq(
              workflowAutomations.eventType,
              "google-forms-response-submitted",
            ),
            activation.officialAutomation === undefined
              ? isNull(workflowAutomations.officialBlueprintKey)
              : and(
                  officialAutomationLifecycleCondition(
                    activation.officialAutomation,
                  ),
                  isNotNull(workflowAutomations.officialBlueprintKey),
                  eq(workflowAutomations.officialIntendedEnabled, false),
                  eq(workflowAutomations.enabled, false),
                ),
            observedWorkflowAutomationCondition({
              id: activation.automationId,
              ...activation.automationSnapshot,
            }),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    // Only the actual UPDATE row starts from the prepared activation baseline.
    const seededCursor = db.$with("seeded_google_forms_cursor").as(
      db
        .insert(googleFormsAutomationCursors)
        .select(
          db
            .select({
              automationId: enabled.id,
              watchStateId:
                sql`${sql.param(state.id, googleFormsAutomationCursors.watchStateId)}`
                  .mapWith(googleFormsAutomationCursors.watchStateId)
                  .as("watch_state_id"),
              lastSeenSubmittedTime:
                sql`${sql.param(cursor, googleFormsAutomationCursors.lastSeenSubmittedTime)}`
                  .mapWith(googleFormsAutomationCursors.lastSeenSubmittedTime)
                  .as("last_seen_submitted_time"),
              createdAt:
                sql`${sql.param(currentTime, googleFormsAutomationCursors.createdAt)}`
                  .mapWith(googleFormsAutomationCursors.createdAt)
                  .as("created_at"),
              updatedAt:
                sql`${sql.param(currentTime, googleFormsAutomationCursors.updatedAt)}`
                  .mapWith(googleFormsAutomationCursors.updatedAt)
                  .as("updated_at"),
            })
            .from(enabled),
        )
        .onConflictDoUpdate({
          target: googleFormsAutomationCursors.automationId,
          set: {
            watchStateId: state.id,
            lastSeenSubmittedTime: cursor,
            updatedAt: currentTime,
          },
        }),
    );
    // The cursor DML completes even though the result selects the enabled row.
    const [enabledAutomation] = await db
      .with(enabled, seededCursor)
      .select()
      .from(enabled);
    signal.throwIfAborted();
    return enabledAutomation
      ? { kind: "ok", watchStateId: state.id, enabledAutomation }
      : {
          kind: "superseded",
          message:
            "Google Forms automation changed during watch setup; retry the request",
        };
  },
);

const markGoogleFormsWatchForRetry$ = command(
  async (
    { set },
    state: GoogleFormsWatchStateRow,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(googleFormsWatchStates)
      .set({ needsRewatch: true, updatedAt: nowDate() })
      .where(googleFormsWatchResourceCondition(state));
    signal.throwIfAborted();
  },
);

/** A provider reply owns only the resource and expiration it observed. */
function googleFormsWatchResourceCondition(state: GoogleFormsWatchStateRow) {
  return and(
    eq(googleFormsWatchStates.id, state.id),
    eq(googleFormsWatchStates.orgId, state.orgId),
    eq(googleFormsWatchStates.userId, state.userId),
    eq(googleFormsWatchStates.connectorId, state.connectorId),
    eq(googleFormsWatchStates.formId, state.formId),
    eq(googleFormsWatchStates.watchId, state.watchId),
    eq(googleFormsWatchStates.topicName, state.topicName),
    eq(googleFormsWatchStates.expireTime, state.expireTime),
    eq(googleFormsWatchStates.needsRewatch, state.needsRewatch),
  );
}

function googleFormsWatchProgressIsReferenced(state: GoogleFormsWatchStateRow) {
  return exists(sql`(
    SELECT 1 FROM ${workflowAutomations}
    WHERE ${workflowAutomations.orgId} = ${state.orgId}
      AND ${workflowAutomations.ownerUserId} = ${state.userId}
      AND ${workflowAutomations.kind} = 'event'
      AND ${workflowAutomations.eventType} = 'google-forms-response-submitted'
      AND ${workflowAutomations.eventConnectorId} = ${state.connectorId}::uuid
      AND ${workflowAutomations.eventConfig} ->> 'connectorId' = ${state.connectorId}
      AND ${workflowAutomations.eventConfig} -> 'form' ->> 'id' = ${state.formId}
      AND (${workflowAutomations.enabled} OR (
        ${workflowAutomations.officialBlueprintKey} IS NOT NULL
        AND ${workflowAutomations.officialIntendedEnabled} = true
        AND ${workflowAutomations.officialReconciliationStatus} = 'needs_reconfiguration'
        AND EXISTS (
          SELECT 1 FROM ${googleFormsAutomationCursors}
          WHERE ${googleFormsAutomationCursors.automationId} = ${workflowAutomations.id}
            AND ${googleFormsAutomationCursors.watchStateId} = ${state.id}::uuid
        )
      ))
  )`);
}

const stopGoogleFormsWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
      readonly accessToken: string;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsWatchReconcileResult> => {
    const db = set(writeDb$);
    const deleted = await deleteGoogleFormsWatch(
      {
        accessToken: args.accessToken,
        formId: args.state.formId,
        watchId: args.state.watchId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (deleted.kind !== "ok" && !missingGoogleFormsWatch(deleted)) {
      await set(markGoogleFormsWatchForRetry$, args.state, signal);
      signal.throwIfAborted();
      return { kind: "failed" };
    }
    // Stopping the provider resource must not cascade away an intended same-source
    // interval. Manual stop/source replacement already discard their cursors.
    // A concurrent recovery may have adopted another provider resource; this
    // reply cannot delete or mark that newer resource by the shared local id.
    const referenced = googleFormsWatchProgressIsReferenced(args.state);
    const deletedState = db.$with("deleted_google_forms_watch").as(
      db
        .delete(googleFormsWatchStates)
        .where(
          and(googleFormsWatchResourceCondition(args.state), not(referenced)),
        )
        .returning({ id: googleFormsWatchStates.id }),
    );
    // Consume the actual deleted identity: only its surviving exact resource
    // can be marked for recreation. Both branches retain the statement snapshot.
    await db
      .with(deletedState)
      .update(googleFormsWatchStates)
      .set({ needsRewatch: true, updatedAt: nowDate() })
      .where(
        and(
          googleFormsWatchResourceCondition(args.state),
          notExists(
            db
              .select({ id: deletedState.id })
              .from(deletedState)
              .where(eq(deletedState.id, googleFormsWatchStates.id)),
          ),
        ),
      );
    signal.throwIfAborted();
    return { kind: "stopped" };
  },
);

export const reconcileGoogleFormsWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
      readonly renewBefore?: Date;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsWatchReconcileResult> => {
    const db = set(writeDb$);
    const [state] = await db
      .select()
      .from(googleFormsWatchStates)
      .where(eq(googleFormsWatchStates.id, args.state.id))
      .limit(1);
    signal.throwIfAborted();
    if (!state) {
      return { kind: "unchanged" };
    }
    const hasConsumer = await set(
      hasEnabledGoogleFormsConsumer$,
      state,
      signal,
    );
    const access = await set(resolveGoogleFormsAccess$, state, signal);
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      await set(markGoogleFormsWatchForRetry$, state, signal);
      signal.throwIfAborted();
      return { kind: "failed" };
    }
    if (!hasConsumer) {
      return await set(
        stopGoogleFormsWatchState$,
        { state, accessToken: access.access.accessToken },
        signal,
      );
    }
    if (args.renewBefore === undefined) {
      return { kind: "unchanged" };
    }
    // A successful remote stop followed by a failed/stale local write leaves a
    // healthy-looking row. Inspect provider authority even before local expiry.
    const listed = await listGoogleFormsWatches(
      { accessToken: access.access.accessToken, formId: state.formId },
      signal,
    );
    signal.throwIfAborted();
    if (listed.kind !== "ok") {
      await set(markGoogleFormsWatchForRetry$, state, signal);
      signal.throwIfAborted();
      return { kind: "failed" };
    }
    const remote = listed.value.watches?.find((watch) => {
      return (
        watch.id === state.watchId &&
        watch.target?.topic.topicName === state.topicName
      );
    });
    const renewalDue =
      state.needsRewatch ||
      state.expireTime.getTime() <= args.renewBefore.getTime();
    if (remote && !renewalDue) {
      return { kind: "unchanged" };
    }
    let renewed = remote
      ? await renewGoogleFormsWatch(
          {
            accessToken: access.access.accessToken,
            formId: state.formId,
            watchId: state.watchId,
          },
          signal,
        )
      : await createOrAdoptGoogleFormsWatch(
          {
            accessToken: access.access.accessToken,
            formId: state.formId,
            topicName: state.topicName,
          },
          signal,
        );
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
    signal.throwIfAborted();
    if (renewed.kind !== "ok") {
      await set(markGoogleFormsWatchForRetry$, state, signal);
      signal.throwIfAborted();
      return { kind: "failed" };
    }
    const watch = renewed.value;
    const currentTime = nowDate();
    const updated = await db
      .update(googleFormsWatchStates)
      .set({
        watchId: watch.id,
        expireTime: watchExpireTime(watch),
        lastRenewedAt: currentTime,
        needsRewatch: false,
        updatedAt: currentTime,
      })
      .where(googleFormsWatchResourceCondition(state));
    signal.throwIfAborted();
    if (updated.rowCount === 0) {
      return { kind: "unchanged" };
    }
    return { kind: watch.id === state.watchId ? "renewed" : "created" };
  },
);

export const reprojectGoogleFormsAutomationOwnership$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // One conditional UPDATE computes each target from the member's current
    // account set and default; an account change committed after its
    // snapshot is picked up by the next repair.
    await db.execute(googleFormsAccountProjectionStatement(args));
    signal.throwIfAborted();
  },
);

export const prepareGoogleFormsWatchesForOwner$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    await set(reprojectGoogleFormsAutomationOwnership$, args, signal);
    signal.throwIfAborted();

    const automations = await db
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
        eq(
          googleFormsWatchStates.id,
          googleFormsAutomationCursors.watchStateId,
        ),
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
      const connectorId = automation.connectorId;
      if (connectorId === null) {
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
      const ensured = await set(
        ensureGoogleFormsWatchForUser$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorId,
          formId: config.form.id,
          resetAutomationId: automation.id,
        },
        signal,
      );
      signal.throwIfAborted();
      succeeded &&= ensured.kind === "ok";
    }
    return succeeded;
  },
);

const reconcileGoogleFormsWatchesForOwner$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly renewBefore?: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    let succeeded = await set(prepareGoogleFormsWatchesForOwner$, args, signal);
    signal.throwIfAborted();
    const states = await db
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
      const result = await set(
        reconcileGoogleFormsWatchState$,
        {
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
  },
);

export const reconcileGoogleFormsWatchesForUser$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(reconcileGoogleFormsWatchesForOwner$, args, signal);
  },
);

export function googleFormsTimestampMicros(value: string): bigint {
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

const FORM_EDIT_LINK_GUIDANCE =
  "Please open the form's edit page and copy the link from the address bar";

const UNPUBLISHED_FORM_WARNING =
  "This Google Form is not accepting responses yet. Publish it before expecting response events.";

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

function formIsNotAcceptingResponses(
  form: z.infer<typeof googleFormSchema>,
): boolean {
  return (
    form.publishSettings?.publishState?.isPublished !== true ||
    form.publishSettings?.publishState?.isAcceptingResponses !== true
  );
}

export const prepareGoogleFormsResponseEventConfigForPersist$ = command(
  async (
    { set },
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
  > => {
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
    const access = await set(
      resolveGoogleFormsAccess$,
      {
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
  },
);

function googleFormsSelectedAccountCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorId?: string;
}) {
  const selection = sql`SELECT ${chatThreadConnectorSelections.connectorId}
    FROM ${workflowUserAutomationThreads}
    INNER JOIN ${chatThreadConnectorSelections}
      ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
      AND ${chatThreadConnectorSelections.connectorSlug} = 'google-forms'
    WHERE ${workflowUserAutomationThreads.orgId} = ${args.orgId}
      AND ${workflowUserAutomationThreads.userId} = ${args.userId}
      AND ${workflowUserAutomationThreads.workflowId} = ${args.workflowId}`;
  return and(
    args.connectorId === undefined
      ? undefined
      : eq(connectors.id, args.connectorId),
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.connectorSlug, "google-forms"),
    sql`CASE WHEN EXISTS (${selection}) THEN ${connectors.id} = (${selection} LIMIT 1)
      ELSE ${connectors.isDefault} END`,
  );
}

export const readGoogleFormsActivationAccount$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
    const [account] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(googleFormsSelectedAccountCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return account?.id ?? null;
  },
);

export interface PendingGoogleFormsWatchStop {
  readonly accessToken: string;
  readonly watches: readonly {
    readonly formId: string;
    readonly watchId: string;
  }[];
}

export const prepareGoogleFormsWatchStopForConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
    },
    signal: AbortSignal,
  ): Promise<PendingGoogleFormsWatchStop | null> => {
    const access = await set(resolveGoogleFormsAccess$, args, signal);
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      return null;
    }
    const db = get(db$);
    const states = await db
      .select({
        formId: googleFormsWatchStates.formId,
        watchId: googleFormsWatchStates.watchId,
      })
      .from(googleFormsWatchStates)
      .where(eq(googleFormsWatchStates.connectorId, args.connectorId));
    signal.throwIfAborted();
    return { accessToken: access.access.accessToken, watches: states };
  },
);

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
