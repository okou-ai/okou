import { GoogleFormsSourceTransitionChangedError } from "./workflow-google-forms-queue.service";
import {
  googleFormsResponseSubmittedEventConfigSchema,
  type GoogleFormsResponseSubmittedEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  googleFormsAutomationCursors,
  googleFormsProcessedEvents,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeJsonParse, settle, tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  AutomationEventSourceTiming,
  type AutomationEventRunTiming,
} from "./automation-event-source-timing.service";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import {
  googleFormResponseSchema,
  googleFormResponsesSchema,
  type GoogleFormsWatchStateRow,
  type GoogleFormsFetchResult,
  resolveGoogleFormsAccess$,
  googleFormsFetchJson,
  responsesListUrl,
  reconcileGoogleFormsWatchState$,
  prepareGoogleFormsWatchesForOwner$,
  googleFormsTimestampMicros,
} from "./google-forms-automation-watch.service";

const log = logger("api:google-forms-automation-event");

const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

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

type GoogleFormResponse = z.infer<typeof googleFormResponseSchema>;

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

const loadGoogleFormsWatchStates$ = command(
  async (
    { set },
    args: {
      readonly decoded: DecodedGoogleFormsPubSubPush;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsWatchStateRow[]> => {
    const db = set(writeDb$);
    const exact = await db
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
  },
);

const loadGoogleFormsEventAutomations$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsEventAutomationRow[]> => {
    const db = set(writeDb$);
    const rows = await db
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
      const canFire = await set(
        workflowAutomationCanFire$,
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
        (await set(
          ensureWorkflowUserAutomationThread$,
          {
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
            workflowId: row.automation.workflowId,
            agentId: row.agentId,
            workflowTitle: row.workflowDisplayName ?? row.workflowName,
            currentTime: nowDate(),
          },
          signal,
        ));
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
  },
);

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

function googleFormsChangeType(
  response: GoogleFormResponse,
): "created" | "updated" {
  return googleFormsTimestampMicros(response.lastSubmittedTime) -
    googleFormsTimestampMicros(response.createTime) <
    1_000_000n
    ? "created"
    : "updated";
}

const responsePreviouslyDelivered$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly responseId: string;
      readonly lastSubmittedTime: string;
    },
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [previous] = await db
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
  },
);

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
          sourcePlan: {
            kind: "google-forms",
            source: {
              orgId: args.state.orgId,
              userId: args.state.userId,
              connectorId: args.state.connectorId,
              automationId: args.automation.automation.id,
              watchStateId: args.state.id,
              formId: args.state.formId,
              watchId: args.decoded.watchId,
              pubsubMessageId: args.decoded.messageId,
              responseId: args.response.responseId,
              lastSubmittedTime: args.response.lastSubmittedTime,
              cursor: args.cursor,
            },
          },
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
    return "ok";
  },
);

type GoogleFormsDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

const eventAlreadyProcessed$ = command(
  async (
    { set },
    args: {
      readonly stateId: string;
      readonly automationId: string;
      readonly response: GoogleFormResponse;
    },
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [processed] = await db
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
  },
);

const dispatchGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
      readonly automation: GoogleFormsEventAutomationRow;
      readonly decoded: DecodedGoogleFormsPubSubPush;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsDispatchStateResult> => {
    const access = await set(
      resolveGoogleFormsAccess$,
      {
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
    signal.throwIfAborted();
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
        await set(eventAlreadyProcessed$, {
          stateId: args.state.id,
          automationId: args.automation.automation.id,
          response,
        })
      ) {
        duplicates += 1;
        continue;
      }
      const previouslyDelivered = await set(responsePreviouslyDelivered$, {
        automationId: args.automation.automation.id,
        responseId: response.responseId,
        lastSubmittedTime: response.lastSubmittedTime,
      });
      signal.throwIfAborted();
      const result = await set(
        startGoogleFormsWorkflowRun$,
        {
          state: args.state,
          automation: args.automation,
          decoded: args.decoded,
          response,
          cursor,
          previouslyDelivered,
          timing: args.sourceTiming.createRunTiming(),
          apiStartTime: args.apiStartTime,
        },
        signal,
      );
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
  },
);

const dispatchGoogleFormsWatchState$ = command(
  async (
    { set },
    args: {
      readonly state: GoogleFormsWatchStateRow;
      readonly decoded: DecodedGoogleFormsPubSubPush;
      readonly sourceTiming: AutomationEventSourceTiming;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleFormsDispatchStateResult> => {
    const automations = await args.sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_automations",
      async () => {
        return await set(
          loadGoogleFormsEventAutomations$,
          { state: args.state },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    let dispatched = 0;
    let duplicates = 0;
    for (const automation of automations) {
      const result = await set(
        dispatchGoogleFormsAutomation$,
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
  },
);

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
    const sourceTiming = new AutomationEventSourceTiming(
      "google_forms",
      args.apiStartTime,
    );
    const states = await sourceTiming.measure(
      "api_dispatch_pre_create_agent_automation_event_load_source_state",
      async () => {
        return await set(loadGoogleFormsWatchStates$, { decoded }, signal);
      },
    );
    signal.throwIfAborted();
    let dispatched = 0;
    let duplicates = 0;
    for (const state of states) {
      const result = await set(
        dispatchGoogleFormsWatchState$,
        {
          state,
          decoded,
          sourceTiming: sourceTiming.fork(),
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

const renewGoogleFormsWatchOwners$ = command(
  async (
    { set },
    args: {
      readonly owners: readonly GoogleFormsWatchOwner[];
      readonly renewBefore: Date;
    },
    signal: AbortSignal,
  ): Promise<{ readonly renewed: number; readonly failed: number }> => {
    const db = set(writeDb$);
    let renewed = 0;
    let failed = 0;
    for (const owner of args.owners) {
      const prepared = await set(
        prepareGoogleFormsWatchesForOwner$,
        { ...owner },
        signal,
      );
      signal.throwIfAborted();
      failed += prepared ? 0 : 1;
      const states = await db
        .select()
        .from(googleFormsWatchStates)
        .where(
          and(
            eq(googleFormsWatchStates.orgId, owner.orgId),
            eq(googleFormsWatchStates.userId, owner.userId),
          ),
        )
        .orderBy(asc(googleFormsWatchStates.expireTime));
      signal.throwIfAborted();
      for (const state of states) {
        const result = await set(
          reconcileGoogleFormsWatchState$,
          { state, renewBefore: args.renewBefore },
          signal,
        );
        signal.throwIfAborted();
        renewed +=
          result.kind === "renewed" || result.kind === "created" ? 1 : 0;
        failed += result.kind === "failed" ? 1 : 0;
      }
    }
    return { renewed, failed };
  },
);

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
    return await set(
      renewGoogleFormsWatchOwners$,
      { owners: [...owners.values()], renewBefore },
      signal,
    );
  },
);
