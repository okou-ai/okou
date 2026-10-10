import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { readPublishedArchive } from "./helpers/published-archive";
import { publicChatActor } from "./helpers/public-chat-actor";
import { claimBudgetRun } from "./helpers/public-autonomy-budget";
import { createPublicAutomationResultEmailApi } from "./helpers/public-automation-result-email";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  officialWorkflowInstallationsContract,
  officialWorkflowsContract,
} from "@okouai/api-contracts/contracts/official-workflows";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";

import { http, HttpResponse } from "msw";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  settleIncludingAbort,
} from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { featureSwitchesRoutes } from "../feature-switches";
import { logsRoutes } from "../logs";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { officialWorkflowRoutes } from "../official-workflows";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";

import { userPreferencesRoutes } from "../user-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";

import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import { createRouteMocks } from "./helpers/route-test";
import { readWorkflowAutomationAutonomyFixture } from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const publicResults = createPublicAutomationResultEmailApi(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";
const GMAIL_TOPIC_NAME =
  "projects/vm0-ai-488909/topics/official-workflow-gmail-events";
const GOOGLE_FORMS_TOPIC_NAME =
  "projects/vm0-ai-488909/topics/official-workflow-google-forms-events";
const GOOGLE_FORMS_PUSH_AUDIENCE =
  "https://api.okou.ai/api/webhooks/google-forms";
const GOOGLE_FORMS_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const GOOGLE_FORM_ID = "1FAIpQLScOfficialWorkflowGoogleFormsTest";
const GOOGLE_FORM_URL = `https://docs.google.com/forms/d/${GOOGLE_FORM_ID}/edit`;
const GOOGLE_FORM_SEED_CURSOR = "2026-09-01T08:15:00.123456Z";
const NOTION_FIRST_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_FIRST_PAGE_URL = `https://www.notion.so/First-${NOTION_FIRST_PAGE_ID.replaceAll("-", "")}`;
const NOTION_SECOND_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_SECOND_PAGE_URL = `https://www.notion.so/Second-${NOTION_SECOND_PAGE_ID.replaceAll("-", "")}`;
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

// Official workflow Runs complete through the native Runner claim protocol,
// so fixtures select Fable, whose personal subscription route never uses Pi.
async function selectPersonalDefaultModel(actor: ApiTestUser): Promise<void> {
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions,
  };
}

function scheduledBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "daily",
    parameters: [
      {
        key: "cron-expression",
        type: "string",
        format: "text",
        required: false,
        default: "0 8 * * *",
      },
      {
        key: "include-weekends",
        type: "boolean",
        required: false,
        default: false,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "cron",
        cronExpression: { parameter: "cron-expression" },
      },
      autonomyBudget: 4,
    },
    runtime: { resultEmail },
  };
}

function loopBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "pulse",
    parameters: [
      {
        key: "interval-seconds",
        type: "integer",
        required: true,
      },
      {
        key: "autonomy-budget",
        type: "integer",
        required: false,
        default: 3,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "loop",
        intervalSeconds: { parameter: "interval-seconds" },
      },
      autonomyBudget: { parameter: "autonomy-budget" },
    },
    runtime: { resultEmail },
  };
}

function onceBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "one-shot",
    parameters: [
      {
        key: "at-time",
        type: "string",
        format: "date-time",
        required: true,
      },
      {
        key: "callback-url",
        type: "string",
        format: "url",
        required: true,
      },
      {
        key: "correlation-id",
        type: "string",
        format: "uuid",
        required: true,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "once",
        atTime: { parameter: "at-time" },
      },
    },
    runtime: { resultEmail },
  };
}

function gmailBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "gmail-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: { provider: "gmail", event: "new_message" },
    },
    runtime: { resultEmail: false },
  };
}

function gmailLabelBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "gmail-label-trigger",
    parameters: [
      {
        key: "label-name",
        type: "string",
        format: "text",
        required: true,
      },
    ],
    desiredState: {
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: { parameter: "label-name" },
      },
    },
    runtime: { resultEmail: false },
  };
}

function googleFormsBlueprint(
  autonomyBudget: number,
  formUrl = GOOGLE_FORM_URL,
): OfficialWorkflowBlueprint {
  return {
    key: "google-forms-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "google-forms-response-submitted",
      eventConfig: {
        provider: "google-forms",
        event: "response_submitted",
        formUrl,
      },
      autonomyBudget,
    },
    runtime: { resultEmail: false },
  };
}

function googleMeetBlueprint(
  autonomyBudget: number,
): OfficialWorkflowBlueprint {
  return {
    key: "google-meet-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: {
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      },
      autonomyBudget,
    },
    runtime: { resultEmail: false },
  };
}

function notionBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "notion-child-page-trigger",
    parameters: [
      {
        key: "parent-page-url",
        type: "string",
        format: "url",
        required: true,
      },
    ],
    desiredState: {
      kind: "event",
      eventType: "notion-child-page-created",
      eventConfig: {
        provider: "notion",
        event: "child_page_created",
        parentPageUrl: { parameter: "parent-page-url" },
      },
      autonomyBudget: 4,
    },
    runtime: { resultEmail: false },
  };
}

function configureOfficialGoogleFormsMock(args: {
  readonly formIds: readonly string[];
  readonly creatingWatch: (formId: string) => Promise<void>;
}): void {
  const watches = new Map<
    string,
    { readonly id: string; readonly expireTime: string }
  >();
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME", GOOGLE_FORMS_TOPIC_NAME);
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE",
    GOOGLE_FORMS_PUSH_AUDIENCE,
  );
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GOOGLE_FORMS_PUSH_SERVICE_ACCOUNT,
  );
  server.use(
    http.get("https://forms.googleapis.com/v1/forms/:formId", ({ params }) => {
      expect(args.formIds).toContain(params.formId);
      return HttpResponse.json({
        formId: params.formId,
        info: { title: "Official workflow survey" },
        publishSettings: {
          publishState: { isPublished: true, isAcceptingResponses: true },
        },
      });
    }),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/responses",
      ({ request, params }) => {
        expect(args.formIds).toContain(params.formId);
        expect(new URL(request.url).searchParams.get("pageSize")).toBeNull();
        return HttpResponse.json({
          responses: [
            {
              responseId: "official-google-forms-seed",
              createTime: GOOGLE_FORM_SEED_CURSOR,
              lastSubmittedTime: GOOGLE_FORM_SEED_CURSOR,
            },
          ],
        });
      },
    ),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      ({ params }) => {
        const watch = watches.get(String(params.formId));
        return HttpResponse.json({
          watches: watch
            ? [
                {
                  ...watch,
                  target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
                  eventType: "RESPONSES",
                  state: "ACTIVE",
                },
              ]
            : [],
        });
      },
    ),
    http.post(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      async ({ params }) => {
        const formId = String(params.formId);
        expect(args.formIds).toContain(formId);
        await args.creatingWatch(formId);
        const watch = {
          id: `official-google-forms-watch-${randomUUID()}`,
          expireTime: new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
        watches.set(formId, watch);
        return HttpResponse.json({
          ...watch,
          target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
          eventType: "RESPONSES",
          createTime: new Date(now()).toISOString(),
          state: "ACTIVE",
        });
      },
    ),
    http.delete(
      "https://forms.googleapis.com/v1/forms/:formId/watches/:watchId",
      ({ params }) => {
        const formId = String(params.formId);
        if (watches.get(formId)?.id === params.watchId) {
          watches.delete(formId);
        }
        return HttpResponse.json({});
      },
    ),
  );
}

function configureOfficialNotionPageMock(): void {
  const pages = new Map([
    [NOTION_FIRST_PAGE_ID, { title: "First page", url: NOTION_FIRST_PAGE_URL }],
    [
      NOTION_SECOND_PAGE_ID,
      { title: "Second page", url: NOTION_SECOND_PAGE_URL },
    ],
  ]);
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        const pageId = String(params.pageId);
        const page = pages.get(pageId);
        if (!page) {
          throw new Error(`Unexpected Official Workflow Notion page ${pageId}`);
        }
        return HttpResponse.json({
          object: "page",
          id: pageId,
          created_time: "2026-09-01T00:00:00.000Z",
          last_edited_time: "2026-09-01T00:00:00.000Z",
          archived: false,
          in_trash: false,
          url: page.url,
          parent: { type: "workspace" },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ type: "text", plain_text: page.title }],
            },
          },
        });
      },
    ),
  );
}

function configureOfficialGoogleMeetMock() {
  const testId = randomUUID();
  const accessToken = `official-google-meet-access-${testId}`;
  const externalId = `official-google-meet-user-${testId}`;
  const topicName = `projects/vm0-ai-488909/topics/official-google-meet-${testId}`;
  const recorder = { createCalls: 0 };
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME", topicName);

  server.use(
    http.post("https://oauth2.googleapis.com/token", () => {
      return HttpResponse.json({
        access_token: accessToken,
        refresh_token: `official-google-meet-refresh-${testId}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${accessToken}`,
      );
      return HttpResponse.json({
        id: externalId,
        email: `official-google-meet-${testId}@example.test`,
        name: "Official Google Meet User",
      });
    }),
    http.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        await expect(request.json()).resolves.toStrictEqual({
          targetResource: `//cloudidentity.googleapis.com/users/${externalId}`,
          eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
          notificationEndpoint: { pubsubTopic: topicName },
          ttl: "604800s",
        });
        recorder.createCalls += 1;
        return HttpResponse.json({
          response: {
            name: `subscriptions/official-google-meet-${testId}`,
            targetResource: `//cloudidentity.googleapis.com/users/${externalId}`,
            eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
            notificationEndpoint: { pubsubTopic: topicName },
            state: "ACTIVE",
            expireTime: "2099-09-01T00:00:00.000Z",
          },
        });
      },
    ),
    http.delete(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+$/,
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        expect(new URL(request.url).searchParams.get("allowMissing")).toBe(
          "true",
        );
        return HttpResponse.json({
          name: `operations/delete-official-google-meet-${testId}`,
          done: true,
        });
      },
    ),
  );
  return recorder;
}

function structureTransitionScheduleBlueprint(
  intervalSeconds = 3600,
): OfficialWorkflowBlueprint {
  return {
    key: "lifecycle-transition",
    parameters: [],
    desiredState: {
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds },
    },
    runtime: { resultEmail: false },
  };
}

function structureTransitionGmailBlueprint(
  eventType: "gmail-new-message" | "gmail-label-applied",
): OfficialWorkflowBlueprint {
  return {
    key: "lifecycle-transition",
    parameters: [],
    desiredState:
      eventType === "gmail-new-message"
        ? {
            kind: "event",
            eventType,
            eventConfig: { provider: "gmail", event: "new_message" },
          }
        : {
            kind: "event",
            eventType,
            eventConfig: {
              provider: "gmail",
              event: "label_applied",
              labelName: "Follow Up",
            },
          },
    runtime: { resultEmail: false },
  };
}

function structureTransitionCalendarBlueprint(
  key = "lifecycle-transition",
): OfficialWorkflowBlueprint {
  return {
    key,
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
    },
    runtime: { resultEmail: false },
  };
}

function configureOfficialCalendarWatchMock() {
  const recorder = {
    watchCalls: 0,
    stopCalls: 0,
    watchShouldFail: false,
    watchAccessTokens: [] as string[],
    stopAccessTokens: [] as string[],
  };
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  server.use(
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ params }) => {
        expect(params.calendarId).toBe("primary");
        return HttpResponse.json({
          items: [],
          nextSyncToken: "official-calendar-baseline",
        });
      },
    ),
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
        recorder.watchCalls++;
        recorder.watchAccessTokens.push(
          request.headers.get("authorization") ?? "",
        );
        expect(params.calendarId).toBe("primary");
        if (recorder.watchShouldFail) {
          return HttpResponse.json({ error: "watch failed" }, { status: 500 });
        }
        const body = (await request.json()) as {
          readonly id: string;
          readonly token: string;
        };
        return HttpResponse.json({
          id: body.id,
          resourceId: `official-calendar-resource-${recorder.watchCalls}`,
          resourceUri:
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.post(
      "https://www.googleapis.com/calendar/v3/channels/stop",
      ({ request }) => {
        recorder.stopCalls++;
        recorder.stopAccessTokens.push(
          request.headers.get("authorization") ?? "",
        );
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  return recorder;
}

function webhookBlueprint(resultEmail = false): OfficialWorkflowBlueprint {
  return {
    key: "webhook-trigger",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "webhook-received",
    },
    runtime: { resultEmail },
  };
}

function evolvedScheduledBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "daily",
    parameters: [
      {
        key: "cron-expression",
        type: "string",
        format: "text",
        required: false,
        default: "0 8 * * *",
      },
      {
        key: "autonomy-budget",
        type: "integer",
        required: false,
        default: 7,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "cron",
        cronExpression: { parameter: "cron-expression" },
      },
      autonomyBudget: { parameter: "autonomy-budget" },
    },
    runtime: { resultEmail: false },
  };
}

function unresolvedScheduledBlueprint(): OfficialWorkflowBlueprint {
  return {
    ...evolvedScheduledBlueprint(),
    parameters: [
      ...evolvedScheduledBlueprint().parameters.filter((parameter) => {
        return parameter.key !== "autonomy-budget";
      }),
      {
        key: "required-budget",
        type: "integer",
        required: true,
      },
    ],
    desiredState: {
      ...evolvedScheduledBlueprint().desiredState,
      autonomyBudget: { parameter: "required-budget" },
    },
  };
}

function withUnresolvedRequiredBudget(
  blueprint: OfficialWorkflowBlueprint,
): OfficialWorkflowBlueprint {
  return {
    ...blueprint,
    parameters: [
      ...blueprint.parameters,
      {
        key: "required-budget",
        type: "integer",
        required: true,
      },
    ],
    desiredState: {
      ...blueprint.desiredState,
      autonomyBudget: { parameter: "required-budget" },
    },
  };
}

function pulseOnceBlueprint(atTime: string): OfficialWorkflowBlueprint {
  return {
    key: "pulse",
    parameters: [
      {
        key: "at-time",
        type: "string",
        format: "date-time",
        required: false,
        default: atTime,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "once",
        atTime: { parameter: "at-time" },
      },
    },
    runtime: { resultEmail: false },
  };
}

function evolvedGmailLabelBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "gmail-label-trigger",
    parameters: [
      {
        key: "next-label-name",
        type: "string",
        format: "text",
        required: false,
        default: "Follow Up",
      },
    ],
    desiredState: {
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: { parameter: "next-label-name" },
      },
    },
    runtime: { resultEmail: false },
  };
}

function activeDefinition(
  name: string,
  blueprints: readonly OfficialWorkflowBlueprint[],
  instruction = "Execute only the accepted Definition content.",
): ActiveDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: `Display ${name}`,
      description: `Description for ${name}`,
      instruction,
      files: [{ path: "references/context.md", content: "accepted\n" }],
    },
    blueprints: [...blueprints],
    presentation: {
      category: "productivity",
      order: 1,
      marketingCopy: "Official catalog entry.",
    },
  };
}

async function syncClient(candidate: unknown) {
  const app = await setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
    isolatePg: true,
  });
  return app(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await accept(
    (await syncClient(candidate)).sync({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

function connectorDoctorDefinition(): ActiveDefinition {
  return activeDefinition("connector-doctor", [
    {
      key: "weekly-check",
      parameters: [],
      desiredState: {
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * 1",
        },
      },
      runtime: { resultEmail: false },
    },
  ]);
}

async function syncDeployedCatalog() {
  await syncCatalog(catalog([connectorDoctorDefinition()]));
  return await accept(
    setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
      cronOfficialWorkflowCatalogContract,
    ).sync({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

function stateClient() {
  return setupApp({
    context,
    routes: testOfficialWorkflowCatalogStateRoutes,
  })(testOfficialWorkflowCatalogStateContract);
}

async function runOfficialWorkflowReconciliationWorker() {
  const response = await accept(
    stateClient().action({
      body: { action: "run-reconciliation-worker" },
    }),
    [200],
  );
  if (!response.body.worker) {
    throw new Error(
      "Official Workflow reconciliation worker result is missing",
    );
  }
  return response.body.worker;
}

async function readOfficialWorkflowReconciliationState(args: {
  readonly definitionName?: string;
  readonly workflowId?: string;
}) {
  return await accept(
    stateClient().action({
      body: { action: "read", ...args },
    }),
    [200],
  );
}

function officialClient() {
  return setupApp({ context, routes: officialWorkflowRoutes })(
    officialWorkflowsContract,
  );
}

function morningBriefPreferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

function installationClient() {
  return setupApp({ context, routes: officialWorkflowRoutes })(
    officialWorkflowInstallationsContract,
  );
}

function workflowClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function workflowCollectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function workflowVisibilityClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function allThreadEventRows(actor: ApiTestUser, chatThreadId: string) {
  const rows = await chat.listThreadEventRows(actor, chatThreadId);
  let page = rows;
  // The endpoint caps each page at 50; a 32-hop chain spans multiple pages.
  while (page.length === 50) {
    const last = page.at(-1);
    if (!last) {
      throw new Error("Expected a cursor on a full event page");
    }
    page = await chat.listThreadEventRows(actor, chatThreadId, {
      lastEventId: last.id,
      lastSeqId: last.seqId,
    });
    rows.push(...page);
  }
  return rows;
}

/**
 * Run now only enqueues; the background pick launches the run. Flush the pick
 * and read the newest launched run from the automation thread.
 */
async function launchedAutomationRunId(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<string | undefined> {
  await flushWaitUntilForTest();
  const events = await allThreadEventRows(actor, chatThreadId);
  const launched = [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  return launched?.runId ?? undefined;
}

/** Every Run the actor can see for one Agent, through the public log list. */
async function listAgentRunLogIds(
  actor: ApiTestUser,
  agentId: string,
): Promise<readonly string[]> {
  const response = await accept(
    setupApp({ context, routes: logsRoutes })(logsListContract).list({
      headers: authHeaders(actor),
      query: { agentId, limit: 100 },
    }),
    [200],
  );
  return response.body.data.map((log) => {
    return log.id;
  });
}

async function cancelAgentRunsThroughLogs(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  for (const runId of await listAgentRunLogIds(actor, agentId)) {
    await runs.requestCancelRun(actor, runId, [200, 400]);
  }
}

// A failed reconciliation is retried on the app clock; its first backoff is
// one second, so a minute later the retry is due without touching the work row.
const RECONCILIATION_RETRY_DUE_MS = 60_000;

async function runDueOfficialWorkflowReconciliationRetry() {
  return await withMockNowForTest(
    now() + RECONCILIATION_RETRY_DUE_MS,
    async () => {
      return await runOfficialWorkflowReconciliationWorker();
    },
  );
}

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function requiredS3ObjectKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

function installCatalogStorageFixture() {
  const objects = new Map<string, Buffer>();
  let nextWriteError: Error | null = null;
  let heldWrite:
    | {
        readonly started: ReturnType<typeof createDeferredPromise<void>>;
        readonly release: ReturnType<typeof createDeferredPromise<void>>;
      }
    | undefined;
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = null;
        throw error;
      }
      const key = requiredS3ObjectKey(command.input.Key);
      if (heldWrite) {
        const gate = heldWrite;
        heldWrite = undefined;
        gate.started.resolve(undefined);
        return gate.release.promise.then(() => {
          objects.set(key, s3BodyBuffer(command.input.Body));
          return {};
        });
      }
      objects.set(key, s3BodyBuffer(command.input.Body));
      return Promise.resolve({});
    }
    if (command instanceof HeadObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({ ContentLength: body.length })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof GetObjectCommand) {
      const key = requiredS3ObjectKey(command.input.Key);
      const body = objects.get(key);
      return body
        ? Promise.resolve({
            Body: {
              async *[Symbol.asyncIterator]() {
                yield body;
              },
            },
            ContentLength: body.length,
          })
        : Promise.reject(missingS3Object(key));
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([Key, body]) => {
          return Key.startsWith(prefix)
            ? [{ Key, Size: body.length, LastModified: new Date(0) }]
            : [];
        }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
      return Promise.resolve({});
    }
    if (!fallback) {
      return Promise.reject(
        new Error(
          `Unexpected S3 command in Official Workflow storage fixture: ${command?.constructor.name ?? "unknown"}`,
        ),
      );
    }
    return fallback(command);
  });
  return {
    readObject(key: string): Buffer {
      const object = objects.get(key);
      if (!object) {
        throw new Error(`Missing test snapshot object ${key}`);
      }
      return object;
    },
    objectCount(): number {
      return objects.size;
    },
    failNextWrite(error: Error): void {
      nextWriteError = error;
    },
    holdNextWrite() {
      if (heldWrite) {
        throw new Error("An S3 write is already held");
      }
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      heldWrite = { started, release };
      return {
        started: started.promise,
        resolve(): void {
          release.resolve(undefined);
        },
        reject(error: Error): void {
          acknowledgeDetachedForTest(release.promise);
          release.reject(error);
        },
      };
    },
  };
}

async function setOfficialWorkflowsEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const app = await setupApp({
    context,
    routes: featureSwitchesRoutes,
    isolatePg: true,
  });
  await accept(
    app(featureSwitchesContract).update({
      headers: authHeaders(actor),
      body: { switches: { [FeatureSwitchKey.OfficialWorkflows]: enabled } },
    }),
    [200],
  );
}

async function deliverClerkOrganizationCreated(
  actor: ApiTestUser,
  createdAt: Date,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: {
      id: actor.orgId,
      created_by: actor.userId,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function deliverClerkOrganizationMembershipCreated(
  actor: ApiTestUser,
  createdAt: Date,
  membershipId = `membership-${actor.userId}-${actor.orgId}`,
): Promise<void> {
  if (!actor.orgId || !actor.orgRole) {
    throw new Error("Expected organization-scoped Clerk member");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: membershipId,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function deliverClerkOrganizationMembershipDeleted(
  actor: ApiTestUser,
): Promise<void> {
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.deleted",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function listMorningBriefInstallations(actor: ApiTestUser) {
  const response = await accept(
    workflowCollectionClient().list({
      headers: authHeaders(actor),
      query: {},
    }),
    [200],
  );
  return response.body.filter((workflow) => {
    return workflow.official?.definitionName === "morning-brief";
  });
}

async function connectGoogleMeetForOfficialWorkflow(
  actor: ApiTestUser,
): Promise<void> {
  const started = await connectors.startOauth(actor, "google-meet", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  await connectors.completeOauthCallback("google-meet", {
    code: "official-google-meet-code",
    state,
  });
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "google-meet",
  );
  const account = accounts[0];
  if (!account) {
    throw new Error("Expected an Official Workflow Google Meet account");
  }
}

async function installOfficialWorkflowLifecycleScenario() {
  installCatalogStorageFixture();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const definitionName = `api-test-lifecycle-${suffix}`;
  const zeroBlueprintName = `api-test-lifecycle-zero-${suffix}`;
  await syncCatalog(
    catalog([
      activeDefinition(definitionName, [
        scheduledBlueprint(true),
        onceBlueprint(),
        loopBlueprint(),
      ]),
      activeDefinition(zeroBlueprintName, []),
    ]),
  );

  const { actor } = await workflowBdd.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped lifecycle actor");
  }
  const { agentId } = await workflowBdd.createAgent(actor);
  onTestFinished(async () => {
    await publicResults.cleanup(actor);
  });
  const headers = authHeaders(actor);
  await setOfficialWorkflowsEnabled(actor, true);
  const installBody = {
    agentId,
    blueprints: [
      {
        blueprintKey: "daily",
        bindings: [
          { key: "cron-expression", value: "0 7 * * *" },
          { key: "include-weekends", value: true },
        ],
      },
      {
        blueprintKey: "one-shot",
        bindings: [
          { key: "at-time", value: "2099-01-01T00:00:00Z" },
          { key: "callback-url", value: "https://example.com/callback" },
          {
            key: "correlation-id",
            value: "00000000-0000-4000-8000-000000000001",
          },
        ],
      },
      {
        blueprintKey: "pulse",
        bindings: [{ key: "interval-seconds", value: 3600 }],
      },
    ],
  };
  const installed = await accept(
    officialClient().install({
      headers,
      params: { definitionName },
      body: installBody,
    }),
    [201],
  );
  const dailyAutomation = installed.body.workflow.automations.find(
    (automation) => {
      return automation.official?.blueprintKey === "daily";
    },
  );
  if (!dailyAutomation) {
    throw new Error("Expected Official Workflow daily automation");
  }

  return {
    actor,
    agentId,
    dailyAutomation,
    definitionName,
    headers,
    installBody,
    installed,
    orgId: actor.orgId,
    zeroBlueprintName,
  };
}

async function ordinaryDelegationScenario() {
  const owned = await publicChatActor(context);
  return await owned.run(async () => {
    await runs.updateUserModelPreference(owned.actor, "claude-fable-5-1");
    const workflowId = await workflowBdd.createWorkflow(owned.actor, {
      agentId: owned.agentId,
      name: `ordinary-delegation-${randomUUID().slice(0, 8)}`,
    });
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(owned.actor),
        params: { workflowId },
      }),
      [200],
    );
    const sent = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Delegate a workflow",
    });
    const source = await claimBudgetRun(context, owned, sent);
    return { owned, actor: owned.actor, workflow: detail.body, source };
  });
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
});

describe("Morning Brief preference", () => {
  it("preserves enable intent while timezone is unavailable", async () => {
    const missingTimezone = await workflowBdd.setupWorkflowOrg();
    const timezoneHeaders = authHeaders(missingTimezone.actor);
    const unavailableTimezone = await accept(
      morningBriefPreferenceClient().get({ headers: timezoneHeaders }),
      [200],
    );
    expect(unavailableTimezone.body).toMatchObject({
      enabled: false,
      unavailableReason: "missing-timezone",
    });
    const rejectedTimezone = await accept(
      morningBriefPreferenceClient().update({
        headers: timezoneHeaders,
        body: { enabled: true },
      }),
      [200],
    );
    expect(rejectedTimezone.body).toMatchObject({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });

    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(missingTimezone.actor),
        query: {},
      }),
      [200],
    );
    expect(
      listed.body.filter((workflow) => {
        return workflow.official?.definitionName === "morning-brief";
      }),
    ).toHaveLength(0);
  });

  it("adopts the default Agent installation when installations exist across Agents", async () => {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const onboarding = await bdd.readOnboardingStatus(actor);
    if (!onboarding.defaultAgentId) {
      throw new Error("Expected a default Agent");
    }
    const alternate = await workflowBdd.createAgent(actor);

    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const onDefaultAgent = await installMorningBriefFromCatalog(
      actor,
      onboarding.defaultAgentId,
    );
    const onAlternateAgent = await installMorningBriefFromCatalog(
      actor,
      alternate.agentId,
    );

    const read = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(read.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });

    const paused = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({
      enabled: false,
      status: "paused",
    });

    // The adopted installation follows the preference; the other one is left
    // alone and keeps running.
    await expect(
      readMorningBriefAutomations(actor, onDefaultAgent),
    ).resolves.toMatchObject([{ enabled: false, nextRunAt: null }]);
    await expect(
      readMorningBriefAutomations(actor, onAlternateAgent),
    ).resolves.toMatchObject([{ enabled: true }]);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(2);
  });

  it("keeps the preference on its own installation after a catalog install on another Agent", async () => {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const onboarding = await bdd.readOnboardingStatus(actor);
    if (!onboarding.defaultAgentId) {
      throw new Error("Expected a default Agent");
    }
    const alternate = await workflowBdd.createAgent(actor);

    await connectBriefSource(actor);
    await setOfficialWorkflowsEnabled(actor, false);
    const headers = authHeaders(actor);

    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [managed] = await listMorningBriefInstallations(actor);
    if (!managed) {
      throw new Error("Expected a Preferences-managed installation");
    }
    expect(managed.agentId).toBe(onboarding.defaultAgentId);

    await setOfficialWorkflowsEnabled(actor, true);
    const onAlternateAgent = await installMorningBriefFromCatalog(
      actor,
      alternate.agentId,
    );

    const read = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(read.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });

    const paused = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, status: "paused" });
    await expect(
      readMorningBriefAutomations(actor, managed.id),
    ).resolves.toMatchObject([{ enabled: false }]);
    await expect(
      readMorningBriefAutomations(actor, onAlternateAgent),
    ).resolves.toMatchObject([{ enabled: true }]);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(2);
  });

  it("adopts the remaining installation once the enrolled one is uninstalled", async () => {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const alternate = await workflowBdd.createAgent(actor);

    await connectBriefSource(actor);
    await setOfficialWorkflowsEnabled(actor, false);
    const headers = authHeaders(actor);

    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [enrolled] = await listMorningBriefInstallations(actor);
    if (!enrolled) {
      throw new Error("Expected a Preferences-managed installation");
    }
    await setOfficialWorkflowsEnabled(actor, true);
    const onAlternateAgent = await installMorningBriefFromCatalog(
      actor,
      alternate.agentId,
    );
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: enrolled.id },
      }),
      [204],
    );

    // The enrollment still records the uninstalled brief. Ownership falls back
    // to the adoption rule instead of reporting that no brief exists, and the
    // adopted brief has never delivered, so it owns no thread yet.
    const read = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(read.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await expect(
      readMorningBriefAutomations(actor, onAlternateAgent),
    ).resolves.toMatchObject([{ enabled: true, chatThreadId: null }]);

    const paused = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, status: "paused" });
    await expect(
      readMorningBriefAutomations(actor, onAlternateAgent),
    ).resolves.toMatchObject([{ enabled: false }]);
    await expect(listMorningBriefInstallations(actor)).resolves.toMatchObject([
      { id: onAlternateAgent },
    ]);
  });
});

async function installMorningBriefFromCatalog(
  actor: ApiTestUser,
  agentId: string,
): Promise<string> {
  const response = await accept(
    officialClient().install({
      headers: authHeaders(actor),
      params: { definitionName: "morning-brief" },
      body: {
        agentId,
        blueprints: [{ blueprintKey: "daily-delivery", bindings: [] }],
      },
    }),
    [201],
  );
  return response.body.workflow.id;
}

async function readMorningBriefAutomations(
  actor: ApiTestUser,
  workflowId: string,
) {
  const response = await accept(
    installationClient().get({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  return response.body.workflow.automations;
}

function mockBriefMemberships(
  entries: readonly {
    readonly actor: ApiTestUser;
    readonly createdAt: Date;
    readonly membershipId?: string;
  }[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: entries.map(({ actor, createdAt, membershipId }) => {
        return {
          id: membershipId ?? `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:member",
          createdAt: createdAt.getTime(),
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        };
      }),
    },
  );
}

async function connectBriefSource(actor: ApiTestUser): Promise<void> {
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected default Agent");
  }
  mockGmailConnectorOAuth();
  const start = await connectors.startOauth(
    actor,
    "gmail",
    "oauth",
    onboarding.defaultAgentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "brief-code",
    state,
  });
  const membershipRead =
    context.mocks.clerk.organizations.getOrganizationMembershipList.getMockImplementation();
  await runs.enableAgentConnectors(actor, onboarding.defaultAgentId, ["gmail"]);
  if (membershipRead) {
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      membershipRead,
    );
  }
}

async function initializeBriefMember(actor: ApiTestUser, timezone: string) {
  return await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone, locale: "en-US" },
    }),
    [200],
  );
}

async function readBriefPreference(actor: ApiTestUser) {
  return await accept(
    morningBriefPreferenceClient().get({ headers: authHeaders(actor) }),
    [200],
  );
}

/** The member's Official schedule, read through the workflow detail endpoint. */
async function readBriefSchedule(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const [installation] = await listMorningBriefInstallations(actor);
  if (!installation) {
    throw new Error("Expected one Morning Brief installation");
  }
  const [automation] = await readMorningBriefAutomations(
    actor,
    installation.id,
  );
  return {
    nextRunAt: automation?.nextRunAt ?? null,
    timezone:
      automation?.kind === "schedule" && automation.schedule.type !== "loop"
        ? automation.schedule.timezone
        : null,
  };
}

async function prepareBriefMember({
  actor = bdd.user(),
  createdAt = new Date("2030-01-01T00:00:00.000Z"),
  catalogAvailable = true,
  bootstrap = true,
}: {
  readonly actor?: ApiTestUser;
  readonly createdAt?: Date;
  readonly catalogAvailable?: boolean;
  readonly bootstrap?: boolean;
} = {}) {
  installCatalogStorageFixture();
  if (catalogAvailable) {
    await syncDeployedCatalog();
  }
  mockBriefMemberships([{ actor, createdAt }]);
  await setOfficialWorkflowsEnabled(actor, false);
  if (bootstrap) {
    await deliverClerkOrganizationCreated(actor, createdAt);
  }
  return { actor, createdAt };
}

describe("Morning Brief explicit installation", () => {
  it("installs only from the preference toggle, not initialization or onboarding", async () => {
    const { actor } = await prepareBriefMember();
    const headers = authHeaders(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await bdd.completeOnboarding(actor, { timezone: "Asia/Shanghai" });
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await flushWaitUntilForTest();
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    const reenabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("reschedules an existing brief after a timezone change and keeps a paused brief paused", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [before] = await listMorningBriefInstallations(actor);
    await bdd.updateUserTimezone(actor, "America/Los_Angeles");
    const changed = await readBriefPreference(actor);
    expect(changed.body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    const changedSchedule = await readBriefSchedule(actor);
    expect(changedSchedule.timezone).toBe("America/Los_Angeles");
    expect(changedSchedule.nextRunAt).not.toBeNull();
    if (!changedSchedule.nextRunAt) {
      throw new Error("Expected next run");
    }
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        hour12: false,
      }).format(new Date(changedSchedule.nextRunAt)),
    ).toBe("07");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await initializeBriefMember(actor, "Asia/Shanghai");
    const [after] = await listMorningBriefInstallations(actor);
    expect(after?.id).toBe(before?.id);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(readBriefSchedule(actor)).resolves.toStrictEqual({
      timezone: "Asia/Tokyo",
      nextRunAt: null,
    });
  });

  it("installs a rejoined member's brief from their explicit preference", async () => {
    const owner = await prepareBriefMember({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const actor = bdd.user({ orgId: owner.actor.orgId, orgRole: "org:member" });
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await deliverClerkOrganizationMembershipDeleted(actor);
    await deliverClerkOrganizationMembershipCreated(
      actor,
      new Date(createdAt.getTime() + 1000),
      `rejoined-${actor.userId}-${actor.orgId}`,
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
    const enabled = await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      status: "enabled",
      enabled: true,
      unavailableReason: null,
    });
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("keeps an explicit timezone choice when initialization runs later", async () => {
    const { actor } = await prepareBriefMember();
    const invalid = await setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone: "Invalid/Timezone", locale: "en-US" },
    });
    expect(invalid.status).toBe(400);
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    const initialized = await initializeBriefMember(
      actor,
      "America/Los_Angeles",
    );
    expect(initialized.body.timezone).toBe("Asia/Tokyo");
    const saved = await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.timezone).toBe("Asia/Tokyo");
  });
});

describe("Official Workflow installations", () => {
  it("names a new Morning Brief thread in the default locale", async () => {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    await selectPersonalDefaultModel(actor);
    const { agentId } = await workflowBdd.createAgent(actor);

    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);

    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName: "morning-brief" },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "daily-delivery", bindings: [] }],
        },
      }),
      [201],
    );
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected the Morning Brief Automation");
    }

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const started = await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [201],
    );
    await expect(
      chat.readThreadMetadata(actor, started.body.chatThreadId),
    ).resolves.toMatchObject({ title: "Okou Morning Brief" });
    const startedRunId = await launchedAutomationRunId(
      actor,
      started.body.chatThreadId,
    );
    if (startedRunId) {
      await runs.requestCancelRun(actor, startedRunId, [200, 400]);
    }
  });

  it("requires a Preference timezone only when a schedule Blueprint omits one", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const defaultTimezoneDefinition = `api-test-default-timezone-${suffix}`;
    const fixedTimezoneDefinition = `api-test-fixed-timezone-${suffix}`;
    const fixedTimezoneBlueprint: OfficialWorkflowBlueprint = {
      ...scheduledBlueprint(),
      desiredState: {
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "0 8 * * *",
          timezone: "UTC",
        },
        autonomyBudget: 4,
      },
    };
    await syncCatalog(
      catalog([
        activeDefinition(defaultTimezoneDefinition, [scheduledBlueprint()]),
        activeDefinition(fixedTimezoneDefinition, [fixedTimezoneBlueprint]),
      ]),
    );

    const { actor } = await workflowBdd.setupWorkflowOrg();
    const { agentId } = await workflowBdd.createAgent(actor);

    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);

    const missingPreference = await accept(
      officialClient().install({
        headers,
        params: { definitionName: defaultTimezoneDefinition },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "daily", bindings: [] }],
        },
      }),
      [400],
    );
    expect(missingPreference.body.error.message).toBe(
      "A valid user timezone preference is required for Blueprint: daily",
    );

    const fixedTimezone = await accept(
      officialClient().install({
        headers,
        params: { definitionName: fixedTimezoneDefinition },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "daily", bindings: [] }],
        },
      }),
      [201],
    );
    expect(fixedTimezone.body.workflow.automations).toMatchObject([
      { schedule: { type: "cron", timezone: "UTC" } },
    ]);
  });

  it("accepts a 32-hop Blueprint budget and rejects a binding above the limit", async () => {
    installCatalogStorageFixture();
    const definitionName = `api-test-budget-${randomUUID()}`;
    const scheduled = evolvedScheduledBlueprint();
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          scheduled,
          {
            ...loopBlueprint(),
            desiredState: {
              ...loopBlueprint().desiredState,
              autonomyBudget: 32,
            },
          },
        ]),
      ]),
    );
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const { agentId } = await workflowBdd.createAgent(actor);

    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const blueprintBindings = (budget: number) => {
      return [
        {
          blueprintKey: "daily",
          bindings: [{ key: "autonomy-budget", value: budget }],
        },
        {
          blueprintKey: "pulse",
          bindings: [{ key: "interval-seconds", value: 3600 }],
        },
      ];
    };
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: blueprintBindings(33) },
      }),
      [400],
    );
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: blueprintBindings(32) },
      }),
      [201],
    );
    expect(installed.body.workflow.automations).toHaveLength(2);
    for (const automation of installed.body.workflow.automations) {
      await expect(
        readWorkflowAutomationAutonomyFixture(context, automation.id),
      ).resolves.toMatchObject({ autonomyBudget: 32, enabled: true });
    }
  });

  it("guards access and validates concurrent installations through public boundaries", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-install-${suffix}`;
    const zeroBlueprintName = `api-test-zero-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          scheduledBlueprint(true),
          onceBlueprint(),
          loopBlueprint(),
        ]),
        activeDefinition(zeroBlueprintName, []),
      ]),
    );

    const staffActor = bdd.user({ orgId: STAFF_ORG_ID });
    const staffHeaders = authHeaders(staffActor);
    await accept(officialClient().list({ headers: staffHeaders }), [200]);
    await setOfficialWorkflowsEnabled(staffActor, false);
    await accept(officialClient().list({ headers: staffHeaders }), [403]);

    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const actor = setup.actor;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);

    const headers = authHeaders(actor);
    await accept(officialClient().list({ headers }), [403]);
    await setOfficialWorkflowsEnabled(actor, true);
    const sharedAgentOwner = bdd.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const { agentId: publicAgentId } = await workflowBdd.createAgent(
      sharedAgentOwner,
      { visibility: "public" },
    );
    const { agentId: privateAgentId } = await workflowBdd.createAgent(
      sharedAgentOwner,
      { visibility: "private" },
    );

    authHeaders(actor);
    const publicAgentInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId: publicAgentId, blueprints: [] },
      }),
      [201],
    );
    expect(publicAgentInstallation.body.workflow).toMatchObject({
      agentId: publicAgentId,
      ownerUserId: actor.userId,
      visibility: "private",
    });
    expect(publicAgentInstallation.body.workflow.automations).toStrictEqual([]);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: publicAgentInstallation.body.workflow.id },
      }),
      [204],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId: privateAgentId, blueprints: [] },
      }),
      [403],
    );

    const discovered = await accept(officialClient().list({ headers }), [200]);
    expect(
      discovered.body.map((entry) => {
        return entry.name;
      }),
    ).toStrictEqual([definitionName, zeroBlueprintName]);
    const catalogDetail = await accept(
      officialClient().get({
        headers,
        params: { definitionName },
      }),
      [200],
    );
    expect(catalogDetail.body.workflow).toMatchObject({
      instruction: "Execute only the accepted Definition content.",
      files: [{ path: "references/context.md", content: "accepted\n" }],
    });
    expect(catalogDetail.body.lifecycle).toBe("active");

    const installBody = {
      agentId,
      blueprints: [
        {
          blueprintKey: "daily",
          bindings: [
            { key: "cron-expression", value: "0 7 * * *" },
            { key: "include-weekends", value: true },
          ],
        },
        {
          blueprintKey: "one-shot",
          bindings: [
            { key: "at-time", value: "2099-01-01T00:00:00Z" },
            { key: "callback-url", value: "https://example.com/callback" },
            {
              key: "correlation-id",
              value: "00000000-0000-4000-8000-000000000001",
            },
          ],
        },
        {
          blueprintKey: "pulse",
          bindings: [{ key: "interval-seconds", value: 3600 }],
        },
      ],
    };
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.slice(0, 2),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            ...installBody.blueprints,
            { blueprintKey: "unknown-blueprint", bindings: [] },
          ],
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: entry.bindings.filter((binding) => {
                    return binding.key !== "callback-url";
                  }),
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "pulse"
              ? {
                  ...entry,
                  bindings: [
                    { key: "interval-seconds", value: "not-an-integer" },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: [
                    ...entry.bindings,
                    { key: "unknown-parameter", value: true },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "one-shot"
              ? {
                  ...entry,
                  bindings: entry.bindings.map((binding) => {
                    return binding.key === "callback-url"
                      ? { ...binding, value: "not-a-url" }
                      : binding;
                  }),
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: installBody.blueprints.map((entry) => {
            return entry.blueprintKey === "daily"
              ? {
                  ...entry,
                  bindings: [
                    ...entry.bindings,
                    { key: "cron-expression", value: "0 11 * * *" },
                  ],
                }
              : entry;
          }),
        },
      }),
      [400],
    );
    const concurrent = await Promise.all([
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
    ]);
    expect(
      concurrent
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const installed = concurrent.find((response) => {
      return response.status === 201;
    });
    if (!installed || installed.status !== 201) {
      throw new Error("Expected one successful concurrent installation");
    }
    expect(installed.body.workflow).toMatchObject({
      agentId,
      official: {
        definitionName,
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    });
    expect(installed.body.workflow.automations).toHaveLength(3);
    expect(
      installed.body.workflow.automations.every((automation) => {
        return automation.enabled;
      }),
    ).toBeTruthy();
  });

  it("projects installed Official Workflow state and accepted definition content", async () => {
    const { dailyAutomation, definitionName, headers, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;
    expect(installed.body.workflow.automations).toHaveLength(3);
    expect(installed.body.definition).toMatchObject({
      name: definitionName,
      lifecycle: "active",
      blueprints: [{ key: "daily" }, { key: "one-shot" }, { key: "pulse" }],
    });
    expect(
      installed.body.workflow.automations.every((automation) => {
        return automation.enabled;
      }),
    ).toBeTruthy();
    expect(installed.body.workflow).toMatchObject({
      name: definitionName,
      visibility: "private",
      instruction: "Execute only the accepted Definition content.",
      fileContents: [{ path: "references/context.md", content: "accepted\n" }],
      canManage: false,
      canPublish: false,
      official: {
        definitionName,
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    });
    const workspaceEntries = await accept(
      automationClient().listWorkspace({ headers }),
      [200],
    );
    expect(
      workspaceEntries.body.find((entry) => {
        return entry.workflow.id === firstWorkflowId;
      }),
    ).toMatchObject({
      workflow: {
        official: {
          definitionName,
          installationState: "installed",
          definitionLifecycle: "active",
          readOnly: true,
        },
      },
      automation: { official: { reconciliationStatus: "current" } },
    });
    expect(dailyAutomation).toMatchObject({
      kind: "schedule",
      enabled: true,
      schedule: {
        type: "cron",
        cronExpression: "0 7 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        blueprintKey: "daily",
        reconciliationStatus: "current",
        intendedEnabled: true,
        parameterBindings: expect.arrayContaining([
          { key: "cron-expression", value: "0 7 * * *" },
          { key: "include-weekends", value: true },
        ]),
      },
    });
    expect(dailyAutomation.official?.parameterBindings).toHaveLength(2);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: true,
      officialBlueprintKey: "daily",
      officialResultEmailEnabled: true,
    });
    for (const automation of installed.body.workflow.automations) {
      if (automation.id === dailyAutomation.id) {
        continue;
      }
      await expect(
        readWorkflowAutomationAutonomyFixture(context, automation.id),
      ).resolves.toMatchObject({
        officialBlueprintKey: automation.official?.blueprintKey,
        officialResultEmailEnabled: false,
      });
    }
  });

  it("reads the accepted Official Workflow instruction after a catalog revision", async () => {
    const { definitionName, headers, installed, zeroBlueprintName } =
      await installOfficialWorkflowLifecycleScenario();
    // The setup helper acknowledges agent writes without retaining reads.
    // Replay those exact external uploads into a readable object store.
    const uploads = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return command;
      })
      .filter((command): command is PutObjectCommand => {
        return command instanceof PutObjectCommand;
      });
    const objects = createMiscRoutesApi(context);
    for (const upload of uploads) {
      objects.putS3Object(
        requiredS3ObjectKey(upload.input.Key),
        s3BodyBuffer(upload.input.Body),
      );
    }
    const instruction = "Use the newly accepted official instruction.";
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [scheduledBlueprint(true), onceBlueprint(), loopBlueprint()],
          instruction,
        ),
        activeDefinition(zeroBlueprintName, []),
      ]),
    );
    const current = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(current.body.workflow.instruction).toBe(instruction);
  });

  it("rejects duplicate Official Workflow installation on the same agent", async () => {
    const { definitionName, headers, installBody, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const duplicate = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [409],
    );
    expect(duplicate.body.error.message).toBe(
      "Official Workflow is already installed on this agent",
    );

    const unchanged = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unchanged.body.workflow).toMatchObject(installed.body.workflow);
  });

  it("keeps Official installations independent across agents and removes a deleted agent's installation", async () => {
    const { actor, definitionName, headers, installBody, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;
    const { agentId: secondAgentId } = await workflowBdd.createAgent(actor);

    const secondInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { ...installBody, agentId: secondAgentId },
      }),
      [201],
    );
    expect(secondInstallation.body.workflow.id).not.toBe(firstWorkflowId);
    await bdd.deleteAgent(actor, secondAgentId);
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: secondInstallation.body.workflow.id },
      }),
      [404],
    );

    const unchanged = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unchanged.body.workflow).toMatchObject(installed.body.workflow);
  });

  it("rejects an Official installation when an ordinary workflow owns the agent name", async () => {
    const { actor, definitionName, headers, installBody, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const { agentId: ordinaryAgentId } = await workflowBdd.createAgent(actor);

    await workflowBdd.createWorkflow(actor, {
      agentId: ordinaryAgentId,
      name: definitionName,
      visibility: "private",
    });
    const ordinaryConflict = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { ...installBody, agentId: ordinaryAgentId },
      }),
      [409],
    );
    expect(ordinaryConflict.body.error.message).toBe(
      `A private workflow named "${definitionName}" already exists on this agent`,
    );

    const unchanged = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unchanged.body.workflow).toMatchObject(installed.body.workflow);
  });

  it("rejects ordinary workflow and automation mutations of an Official installation", async () => {
    const { agentId, dailyAutomation, headers, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;
    await accept(
      workflowClient().update({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { displayName: "Forged edit" },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().publish({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().demote({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: agentId },
      }),
      [409],
    );
    await accept(
      workflowClient().chatThread({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      automationClient().create({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().update({
        headers,
        params: { id: dailyAutomation.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().delete({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [409],
    );

    const unchanged = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unchanged.body.workflow).toMatchObject(installed.body.workflow);
  });

  it("uninstalls and reinstalls Official Workflows, including zero-Blueprint installations", async () => {
    const {
      agentId,
      definitionName,
      headers,
      installBody,
      installed,
      zeroBlueprintName,
    } = await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;

    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [204],
    );
    await accept(
      installationClient().get({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [404],
    );
    const reinstalled = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [201],
    );
    expect(reinstalled.body.workflow.id).not.toBe(firstWorkflowId);

    const zeroInstalled = await accept(
      officialClient().install({
        headers,
        params: { definitionName: zeroBlueprintName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    expect(zeroInstalled.body.workflow.automations).toStrictEqual([]);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: zeroInstalled.body.workflow.id },
      }),
      [204],
    );
  });

  it.each(["reconfigure", "uninstall"] as const)(
    "releases Official copy locks during upload and rejects a concurrent %s",
    async (mutation) => {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-copy-prepare-${suffix}`;
      const blueprints = [loopBlueprint(), webhookBlueprint()];
      await syncCatalog(
        catalog([activeDefinition(definitionName, blueprints)]),
      );

      const { actor } = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
        tier: "team",
      });
      await selectPersonalDefaultModel(actor);
      const { agentId: sourceAgentId } = await workflowBdd.createAgent(actor);
      const { agentId: targetAgentId } = await workflowBdd.createAgent(actor);
      const pending: {
        copying?: Promise<unknown>;
        releaseCopy?: () => void;
      } = {};
      onTestFinished(async () => {
        pending.releaseCopy?.();
        await pending.copying;
      });
      const headers = authHeaders(actor);
      await setOfficialWorkflowsEnabled(actor, true);
      const installed = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: {
            agentId: sourceAgentId,
            blueprints: [
              {
                blueprintKey: "pulse",
                bindings: [{ key: "interval-seconds", value: 3600 }],
              },
              { blueprintKey: "webhook-trigger", bindings: [] },
            ],
          },
        }),
        [201],
      );
      const storage = installCatalogStorageFixture();
      const heldUpload = storage.holdNextWrite();
      let released = false;
      const releaseCopy = () => {
        if (!released && !context.signal.aborted) {
          released = true;
          heldUpload.resolve();
        }
      };
      pending.releaseCopy = releaseCopy;
      const pendingCopy = settleIncludingAbort(
        workflowClient().copy({
          headers,
          params: { workflowId: installed.body.workflow.id },
          body: { toAgentId: targetAgentId },
        }),
      );
      pending.copying = pendingCopy;
      await heldUpload.started;

      // Event automations require a shared user/org thread-event sequence.
      // The copy's blocked object upload must leave that sequence available
      // to a separate request from the same actor before publication resumes.
      const independentThread = await chat.createThread(actor, {
        agentId: sourceAgentId,
        title: "Independent work during an Official copy upload",
      });
      await expect(
        chat.readThreadMetadata(actor, independentThread.id),
      ).resolves.toMatchObject({ id: independentThread.id });

      switch (mutation) {
        case "reconfigure": {
          await accept(
            installationClient().reconfigure({
              headers,
              params: { workflowId: installed.body.workflow.id },
              body: {
                blueprints: [
                  {
                    blueprintKey: "pulse",
                    bindings: [{ key: "interval-seconds", value: 7200 }],
                  },
                ],
              },
            }),
            [200],
          );
          break;
        }
        case "uninstall": {
          await accept(
            installationClient().uninstall({
              headers,
              params: { workflowId: installed.body.workflow.id },
            }),
            [204],
          );
          break;
        }
      }

      const duringCopy = await accept(
        workflowCollectionClient().list({
          headers,
          query: { agentId: targetAgentId },
        }),
        [200],
      );
      expect(duringCopy.body).toStrictEqual([]);
      releaseCopy();
      const copied = await pendingCopy;
      if (!copied.ok) {
        throw copied.error;
      }
      expect(copied.value.status).toBe(409);
      const afterCopy = await accept(
        workflowCollectionClient().list({
          headers,
          query: { agentId: targetAgentId },
        }),
        [200],
      );
      expect(afterCopy.body).toStrictEqual([]);
      const automations = await accept(
        automationClient().listWorkspace({ headers }),
        [200],
      );
      expect(
        automations.body.some((automation) => {
          return automation.workflow.agentId === targetAgentId;
        }),
      ).toBeFalsy();
    },
    30_000,
  );

  describe.each([
    "installation release",
    "instruction release",
    "concurrent pause",
    "persisted reconciliation",
  ] as const)("workflow identity during %s races", (phase) => {
    async function prepareRace() {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-race-${suffix}`;
      const blueprint = gmailLabelBlueprint();
      await syncCatalog(
        catalog([
          activeDefinition(
            definitionName,
            [blueprint],
            "Accepted Definition revision one.",
          ),
        ]),
      );

      const setup = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      const actor = setup.actor;
      const { agentId } = await workflowBdd.createAgent(actor);

      mockGmailConnectorOAuth({
        email: `official-race-${suffix}@example.test`,
      });
      await workflowBdd.connectConnector(actor, "gmail");
      mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
      await setOfficialWorkflowsEnabled(actor, true);
      return { definitionName, blueprint, actor, agentId };
    }

    let prepared: Awaited<ReturnType<typeof prepareRace>>;
    beforeEach(async () => {
      prepared = await prepareRace();
    });

    it("preserves identity and reconciles the concurrent operation", async () => {
      const { definitionName, blueprint, actor, agentId } = prepared;

      const watchStarted = createDeferredPromise<void>(context.signal);
      const releaseWatch = createDeferredPromise<void>(context.signal);
      const labelLookupStarted = createDeferredPromise<void>(context.signal);
      const releaseLabelLookup = createDeferredPromise<void>(context.signal);
      let blockNextWatch = true;
      let blockNextLabelLookup = false;
      let stopCalls = 0;
      server.use(
        http.get(
          "https://gmail.googleapis.com/gmail/v1/users/me/labels",
          async () => {
            if (blockNextLabelLookup) {
              blockNextLabelLookup = false;
              labelLookupStarted.resolve(undefined);
              await releaseLabelLookup.promise;
            }
            return HttpResponse.json({
              labels: [
                { id: "Label_important", name: "Important" },
                { id: "Label_follow_up", name: "Follow Up" },
              ],
            });
          },
        ),
        http.post(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          async () => {
            if (blockNextWatch) {
              blockNextWatch = false;
              watchStarted.resolve(undefined);
              await releaseWatch.promise;
            }
            return HttpResponse.json({
              historyId: "100",
              expiration: "4102444800000",
            });
          },
        ),
        http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
          stopCalls++;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const headers = authHeaders(actor);
      const installBody = {
        agentId,
        blueprints: [
          {
            blueprintKey: "gmail-label-trigger",
            bindings: [{ key: "label-name", value: "Important" }],
          },
        ],
      };

      if (phase === "installation release") {
        const installing = accept(
          officialClient().install({
            headers,
            params: { definitionName },
            body: installBody,
          }),
          [409],
        );
        await watchStarted.promise;
        const installingWorkspaceAutomations = await accept(
          automationClient().listWorkspace({ headers }),
          [200],
        );
        expect(
          installingWorkspaceAutomations.body.some((entry) => {
            return entry.workflow.name === definitionName;
          }),
        ).toBeFalsy();
        await syncCatalog(
          catalog([
            activeDefinition(
              definitionName,
              [blueprint],
              "Accepted Definition revision two.",
            ),
          ]),
        );
        releaseWatch.resolve(undefined);
        const installConflict = await installing;
        expect(installConflict.body.error.message).toBe(
          "Official Workflow changed during installation; retry",
        );
        const afterInstallConflict = await accept(
          workflowCollectionClient().list({
            headers,
            query: { agentId },
          }),
          [200],
        );
        expect(
          afterInstallConflict.body.some((workflow) => {
            return workflow.name === definitionName;
          }),
        ).toBeFalsy();
        expect(stopCalls).toBe(0);
      } else {
        blockNextWatch = false;
        const installed = await accept(
          officialClient().install({
            headers,
            params: { definitionName },
            body:
              phase === "concurrent pause"
                ? {
                    ...installBody,
                    blueprints: [
                      {
                        blueprintKey: "gmail-label-trigger",
                        bindings: [{ key: "label-name", value: "Follow Up" }],
                      },
                    ],
                  }
                : installBody,
          }),
          [201],
        );
        const installedAutomation = installed.body.workflow.automations[0];
        if (!installedAutomation) {
          throw new Error("Expected Official Gmail automation");
        }

        if (phase === "instruction release") {
          blockNextLabelLookup = true;
          const reconfiguring = accept(
            installationClient().reconfigure({
              headers,
              params: { workflowId: installed.body.workflow.id },
              body: {
                blueprints: [
                  {
                    blueprintKey: "gmail-label-trigger",
                    bindings: [{ key: "label-name", value: "Follow Up" }],
                  },
                ],
              },
            }),
            [200],
          );
          await labelLookupStarted.promise;
          await syncCatalog(
            catalog([
              activeDefinition(
                definitionName,
                [blueprint],
                "Accepted Definition revision three.",
              ),
            ]),
          );
          releaseLabelLookup.resolve(undefined);
          const reconfiguredAcrossInstructionRelease = await reconfiguring;
          expect(
            reconfiguredAcrossInstructionRelease.body.workflow.automations[0],
          ).toMatchObject({
            id: installedAutomation.id,
            official: {
              reconciliationStatus: "current",
              parameterBindings: [{ key: "label-name", value: "Follow Up" }],
            },
          });
          const unchanged = await accept(
            installationClient().get({
              headers,
              params: { workflowId: installed.body.workflow.id },
            }),
            [200],
          );
          expect(unchanged.body.workflow.instruction).toBe(
            "Accepted Definition revision three.",
          );
          expect(
            unchanged.body.workflow.automations[0]?.official,
          ).toMatchObject({
            reconciliationStatus: "current",
            parameterBindings: [{ key: "label-name", value: "Follow Up" }],
          });

          const reconfigured = await accept(
            installationClient().reconfigure({
              headers,
              params: { workflowId: installed.body.workflow.id },
              body: {
                blueprints: [
                  {
                    blueprintKey: "gmail-label-trigger",
                    bindings: [{ key: "label-name", value: "Follow Up" }],
                  },
                ],
              },
            }),
            [200],
          );
          expect(reconfigured.body.workflow.automations[0]).toMatchObject({
            id: installedAutomation.id,
            chatThreadId: installedAutomation.chatThreadId,
            official: {
              reconciliationStatus: "current",
              parameterBindings: [{ key: "label-name", value: "Follow Up" }],
            },
          });
        } else if (phase === "concurrent pause") {
          const concurrentLookupStarted = createDeferredPromise<void>(
            context.signal,
          );
          const releaseConcurrentLookup = createDeferredPromise<void>(
            context.signal,
          );
          let blockConcurrentLookup = true;
          server.use(
            http.get(
              "https://gmail.googleapis.com/gmail/v1/users/me/labels",
              async () => {
                if (blockConcurrentLookup) {
                  blockConcurrentLookup = false;
                  concurrentLookupStarted.resolve(undefined);
                  await releaseConcurrentLookup.promise;
                }
                return HttpResponse.json({
                  labels: [
                    { id: "Label_important", name: "Important" },
                    { id: "Label_follow_up", name: "Follow Up" },
                  ],
                });
              },
            ),
          );
          const concurrentReconfiguration = accept(
            installationClient().reconfigure({
              headers,
              params: { workflowId: installed.body.workflow.id },
              body: {
                blueprints: [
                  {
                    blueprintKey: "gmail-label-trigger",
                    bindings: [{ key: "label-name", value: "Important" }],
                  },
                ],
              },
            }),
            [200],
          );
          await concurrentLookupStarted.promise;
          await accept(
            automationClient().disable({
              headers,
              params: { id: installedAutomation.id },
            }),
            [200],
          );
          releaseConcurrentLookup.resolve(undefined);
          const reconfiguredAfterPause = await concurrentReconfiguration;
          expect(
            reconfiguredAfterPause.body.workflow.automations[0],
          ).toMatchObject({
            id: installedAutomation.id,
            enabled: false,
            official: {
              intendedEnabled: false,
              reconciliationStatus: "current",
              parameterBindings: [{ key: "label-name", value: "Important" }],
            },
          });
        } else {
          await accept(
            automationClient().disable({
              headers,
              params: { id: installedAutomation.id },
            }),
            [200],
          );
          let expiringWatchCalls = 0;
          server.use(
            http.post(
              "https://gmail.googleapis.com/gmail/v1/users/me/watch",
              () => {
                expiringWatchCalls++;
                return HttpResponse.json({
                  historyId: "101",
                  expiration: String(now() + 60_000),
                });
              },
            ),
          );
          await accept(
            automationClient().enable({
              headers,
              params: { id: installedAutomation.id },
            }),
            [200],
          );
          expect(expiringWatchCalls).toBe(1);

          const reconciliationWatchStarted = createDeferredPromise<void>(
            context.signal,
          );
          const releaseReconciliationWatch = createDeferredPromise<void>(
            context.signal,
          );
          server.use(
            http.post(
              "https://gmail.googleapis.com/gmail/v1/users/me/watch",
              async () => {
                reconciliationWatchStarted.resolve(undefined);
                await releaseReconciliationWatch.promise;
                return HttpResponse.json({
                  historyId: "102",
                  expiration: "4102444800000",
                });
              },
            ),
          );
          const persistedReconfiguration = accept(
            installationClient().reconfigure({
              headers,
              params: { workflowId: installed.body.workflow.id },
              body: {
                blueprints: [
                  {
                    blueprintKey: "gmail-label-trigger",
                    bindings: [{ key: "label-name", value: "Follow Up" }],
                  },
                ],
              },
            }),
            [200],
          );
          await reconciliationWatchStarted.promise;
          const disableDuringReconciliation = await accept(
            automationClient().disable({
              headers,
              params: { id: installedAutomation.id },
            }),
            [409],
          );
          expect(disableDuringReconciliation.body.error.message).toBe(
            "Official Workflow reconfiguration is in progress; retry shortly",
          );
          releaseReconciliationWatch.resolve(undefined);
          const reconfiguredAfterConflict = await persistedReconfiguration;
          expect(
            reconfiguredAfterConflict.body.workflow.automations[0],
          ).toMatchObject({
            id: installedAutomation.id,
            enabled: true,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "current",
              parameterBindings: [{ key: "label-name", value: "Follow Up" }],
            },
          });
        }
        await accept(
          installationClient().uninstall({
            headers,
            params: { workflowId: installed.body.workflow.id },
          }),
          [204],
        );
      }
    });
  });

  it.each(["installation retry", "resume retry", "agent deletion"] as const)(
    "preserves official workflow state through %s",
    async (scenario) => {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-watch-${suffix}`;
      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            scheduledBlueprint(),
            gmailBlueprint(),
          ]),
        ]),
      );

      const setup = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      const actor = setup.actor;
      const { agentId } = await workflowBdd.createAgent(actor);

      mockGmailConnectorOAuth({ email: `official-${suffix}@example.test` });
      await workflowBdd.connectConnector(actor, "gmail");
      mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
      let stopCalls = 0;
      server.use(
        http.post(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          () => {
            return scenario === "installation retry"
              ? HttpResponse.json({ error: "watch failed" }, { status: 500 })
              : HttpResponse.json({
                  historyId: "100",
                  expiration: "4102444800000",
                });
          },
        ),
        http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
          stopCalls++;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await setOfficialWorkflowsEnabled(actor, true);
      const headers = authHeaders(actor);
      const body = {
        agentId,
        blueprints: [
          {
            blueprintKey: "daily",
            bindings: [{ key: "cron-expression", value: "0 6 * * *" }],
          },
          { blueprintKey: "gmail-trigger", bindings: [] },
        ],
      };

      if (scenario === "installation retry") {
        await accept(
          officialClient().install({
            headers,
            params: { definitionName },
            body,
          }),
          [400],
        );
        const listedAfterFailure = await accept(
          workflowCollectionClient().list({
            headers,
            query: { agentId },
          }),
          [200],
        );
        expect(
          listedAfterFailure.body.some((workflow) => {
            return workflow.name === definitionName;
          }),
        ).toBeFalsy();
      }

      server.use(
        http.post(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          () => {
            return HttpResponse.json({
              historyId: "100",
              expiration: "4102444800000",
            });
          },
        ),
      );
      const retried = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body,
        }),
        [201],
      );
      expect(retried.body.workflow.automations).toHaveLength(2);
      expect(
        retried.body.workflow.automations.every((automation) => {
          return automation.enabled;
        }),
      ).toBeTruthy();
      if (scenario === "installation retry") {
        return;
      }

      if (scenario === "resume retry") {
        const gmailAutomation = retried.body.workflow.automations.find(
          (automation) => {
            return automation.official?.blueprintKey === "gmail-trigger";
          },
        );
        if (!gmailAutomation) {
          throw new Error("Expected retried Official Gmail automation");
        }
        await accept(
          automationClient().disable({
            headers,
            params: { id: gmailAutomation.id },
          }),
          [200],
        );
        server.use(
          http.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/watch",
            () => {
              return HttpResponse.json(
                { error: "resume watch failed" },
                { status: 500 },
              );
            },
          ),
        );
        await accept(
          automationClient().enable({
            headers,
            params: { id: gmailAutomation.id },
          }),
          [400],
        );
        const afterFailedResume = await accept(
          installationClient().get({
            headers,
            params: { workflowId: retried.body.workflow.id },
          }),
          [200],
        );
        expect(
          afterFailedResume.body.workflow.automations.find((automation) => {
            return automation.id === gmailAutomation.id;
          }),
        ).toMatchObject({
          enabled: false,
          official: {
            intendedEnabled: false,
            reconciliationStatus: "current",
          },
        });
        server.use(
          http.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/watch",
            () => {
              return HttpResponse.json({
                historyId: "101",
                expiration: "4102444800000",
              });
            },
          ),
        );
        await accept(
          automationClient().enable({
            headers,
            params: { id: gmailAutomation.id },
          }),
          [200],
        );
        return;
      }

      await bdd.deleteAgent(actor, agentId);
      await accept(
        installationClient().get({
          headers,
          params: { workflowId: retried.body.workflow.id },
        }),
        [404],
      );
      expect(stopCalls).toBe(0);
    },
  );

  it.each(["same source", "different form"])(
    "publishes the Official Forms %s with its watch interval",
    async (change) => {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-google-forms-${suffix}`;
      await syncCatalog(
        catalog([activeDefinition(definitionName, [googleFormsBlueprint(4)])]),
      );

      const { actor } = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      if (!actor.orgId) {
        throw new Error("Expected organization-scoped actor");
      }
      const { agentId } = await workflowBdd.createAgent(actor);

      mockGoogleFormsConnectorOAuth();
      await workflowBdd.connectConnector(actor, "google-forms");
      const nextFormId =
        change === "same source"
          ? GOOGLE_FORM_ID
          : `${GOOGLE_FORM_ID}${suffix}`;
      let installedWorkflowId: string | null = null;
      configureOfficialGoogleFormsMock({
        formIds: [GOOGLE_FORM_ID, nextFormId],
        creatingWatch: async (formId) => {
          if (formId === GOOGLE_FORM_ID || installedWorkflowId === null) {
            return;
          }
          const preparing = await accept(
            installationClient().get({
              headers: authHeaders(actor),
              params: { workflowId: installedWorkflowId },
            }),
            [200],
          );
          expect(preparing.body.workflow.automations).toContainEqual(
            expect.objectContaining({
              eventType: "google-forms-response-submitted",
              eventConfig: expect.objectContaining({
                form: expect.objectContaining({ id: GOOGLE_FORM_ID }),
              }),
            }),
          );
        },
      });
      await updateFeatureSwitchesForUser(
        context,
        { orgId: actor.orgId, userId: actor.userId },
        {
          [FeatureSwitchKey.OfficialWorkflows]: true,
        },
      );
      const headers = authHeaders(actor);
      const installed = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: {
            agentId,
            blueprints: [
              { blueprintKey: "google-forms-trigger", bindings: [] },
            ],
          },
        }),
        [201],
      );
      installedWorkflowId = installed.body.workflow.id;
      const initial = installed.body.workflow.automations.find((automation) => {
        return automation.official?.blueprintKey === "google-forms-trigger";
      });
      if (
        !initial ||
        initial.kind !== "event" ||
        initial.eventType !== "google-forms-response-submitted" ||
        !initial.official
      ) {
        throw new Error("Expected an Official Google Forms automation");
      }
      const connectorId = initial.eventConfig.connectorId;
      const initialFingerprint = initial.official.appliedFingerprint;

      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            googleFormsBlueprint(
              7,
              `https://docs.google.com/forms/d/${nextFormId}/edit`,
            ),
          ]),
        ]),
      );
      await expect(
        runOfficialWorkflowReconciliationWorker(),
      ).resolves.toMatchObject({ completed: 1, installations: 1, retried: 0 });

      const reconciled = await accept(
        installationClient().get({
          headers,
          params: { workflowId: installed.body.workflow.id },
        }),
        [200],
      );
      const current = reconciled.body.workflow.automations.find(
        (automation) => {
          return automation.id === initial.id;
        },
      );
      expect(current).toMatchObject({
        eventConfig: { connectorId, form: { id: nextFormId } },
        official: { reconciliationStatus: "current" },
      });
      expect(current?.official?.appliedFingerprint).not.toBe(
        initialFingerprint,
      );
    },
  );

  it("keeps an Official Forms automation paused during reconfiguration", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-google-forms-pause-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [googleFormsBlueprint(4)])]),
    );

    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);

    mockGoogleFormsConnectorOAuth();
    await workflowBdd.connectConnector(actor, "google-forms");
    const headers = authHeaders(actor);
    const nextFormId = `${GOOGLE_FORM_ID}${suffix}`;
    let automationId: string | null = null;
    let pausedDuringReconfiguration = false;
    configureOfficialGoogleFormsMock({
      formIds: [GOOGLE_FORM_ID, nextFormId],
      creatingWatch: async (formId) => {
        if (
          formId !== nextFormId ||
          automationId === null ||
          pausedDuringReconfiguration
        ) {
          return;
        }
        pausedDuringReconfiguration = true;
        await accept(
          automationClient().disable({
            headers,
            params: { id: automationId },
          }),
          [200],
        );
      },
    });
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      {
        [FeatureSwitchKey.OfficialWorkflows]: true,
      },
    );
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "google-forms-trigger", bindings: [] }],
        },
      }),
      [201],
    );
    const initial = installed.body.workflow.automations.find((automation) => {
      return automation.official?.blueprintKey === "google-forms-trigger";
    });
    if (!initial) {
      throw new Error("Expected an Official Google Forms automation");
    }
    automationId = initial.id;

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          googleFormsBlueprint(
            7,
            `https://docs.google.com/forms/d/${nextFormId}/edit`,
          ),
        ]),
      ]),
    );
    // The pause commits while the new form watch is being prepared; the
    // reconfiguration observed the enabled row and must not overwrite it.
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toMatchObject({ completed: 0, retried: 1 });
    expect(pausedDuringReconfiguration).toBeTruthy();

    const reconciled = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    const current = reconciled.body.workflow.automations.find((automation) => {
      return automation.id === initial.id;
    });
    expect(current).toMatchObject({
      enabled: false,
      eventConfig: { form: { id: GOOGLE_FORM_ID } },
      official: { intendedEnabled: false },
    });
  });

  it("reconfigures an Official Notion automation without a feature override", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-notion-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [notionBlueprint()])]),
    );

    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);

    mockNotionConnectorOAuth();
    await workflowBdd.connectConnector(actor, "notion");
    configureOfficialNotionPageMock();
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            {
              blueprintKey: "notion-child-page-trigger",
              bindings: [
                { key: "parent-page-url", value: NOTION_FIRST_PAGE_URL },
              ],
            },
          ],
        },
      }),
      [201],
    );
    const initial = installed.body.workflow.automations.find((automation) => {
      return automation.official?.blueprintKey === "notion-child-page-trigger";
    });
    if (
      !initial ||
      initial.kind !== "event" ||
      initial.eventType !== "notion-child-page-created" ||
      !initial.official
    ) {
      throw new Error("Expected an Official Notion automation");
    }
    const connectorId = initial.eventConfig.connectorId;
    const initialFingerprint = initial.official.appliedFingerprint;
    expect(initial).toMatchObject({
      enabled: true,
      eventConfig: {
        connectorId,
        parentPage: {
          id: NOTION_FIRST_PAGE_ID,
          rawUrl: NOTION_FIRST_PAGE_URL,
          title: "First page",
          url: NOTION_FIRST_PAGE_URL,
        },
      },
      official: { reconciliationStatus: "current" },
    });

    const reconfigured = await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "notion-child-page-trigger",
              bindings: [
                { key: "parent-page-url", value: NOTION_SECOND_PAGE_URL },
              ],
            },
          ],
        },
      }),
      [200],
    );
    const current = reconfigured.body.workflow.automations.find(
      (automation) => {
        return automation.id === initial.id;
      },
    );
    expect(current).toMatchObject({
      id: initial.id,
      kind: "event",
      eventType: "notion-child-page-created",
      enabled: true,
      eventConfig: {
        connectorId,
        parentPage: {
          id: NOTION_SECOND_PAGE_ID,
          rawUrl: NOTION_SECOND_PAGE_URL,
          title: "Second page",
          url: NOTION_SECOND_PAGE_URL,
        },
      },
      official: {
        parameterBindings: [
          { key: "parent-page-url", value: NOTION_SECOND_PAGE_URL },
        ],
        reconciliationStatus: "current",
      },
    });
    expect(current?.official?.appliedFingerprint).toBe(initialFingerprint);
  });

  it("projects the Google Meet account during installation and reconfiguration", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-google-meet-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [googleMeetBlueprint(4)])]),
    );

    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);

    const meet = configureOfficialGoogleMeetMock();
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      {
        [FeatureSwitchKey.OfficialWorkflows]: true,
      },
    );
    await connectGoogleMeetForOfficialWorkflow(actor);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "google-meet-trigger", bindings: [] }],
        },
      }),
      [201],
    );
    const initial = installed.body.workflow.automations.find((automation) => {
      return automation.official?.blueprintKey === "google-meet-trigger";
    });
    if (!initial?.official) {
      throw new Error("Expected an Official Google Meet automation");
    }
    const initialFingerprint = initial.official.appliedFingerprint;
    expect(initial).toMatchObject({
      kind: "event",
      eventType: "google-meet-transcript-generated",
      enabled: true,
      official: { reconciliationStatus: "current" },
    });
    expect(meet.createCalls).toBe(1);

    await syncCatalog(
      catalog([activeDefinition(definitionName, [googleMeetBlueprint(7)])]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toMatchObject({ completed: 1, installations: 1, retried: 0 });

    const reconciled = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    const current = reconciled.body.workflow.automations.find((automation) => {
      return automation.id === initial.id;
    });
    expect(current).toMatchObject({
      enabled: true,
      official: { reconciliationStatus: "current" },
    });
    expect(current?.official?.appliedFingerprint).not.toBe(initialFingerprint);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, initial.id),
    ).resolves.toMatchObject({ autonomyBudget: 7, enabled: true });
    expect(meet.createCalls).toBe(1);
  });

  describe("selective non-blocking Blueprint reconciliation", () => {
    async function prepareInstalledBlueprints() {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-reconcile-${suffix}`;
      const unrelatedDefinitionName = `api-test-reconcile-other-${suffix}`;
      const initialBlueprints = [scheduledBlueprint(), loopBlueprint()];
      const unrelatedInitial = loopBlueprint();
      await syncCatalog(
        catalog([
          activeDefinition(definitionName, initialBlueprints),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );

      const setup = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      const { actor } = setup;
      const { agentId } = await workflowBdd.createAgent(actor);

      await setOfficialWorkflowsEnabled(actor, true);
      const headers = authHeaders(actor);
      const installed = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: {
            agentId,
            blueprints: [
              {
                blueprintKey: "daily",
                bindings: [
                  { key: "cron-expression", value: "0 6 * * *" },
                  { key: "include-weekends", value: true },
                ],
              },
              {
                blueprintKey: "pulse",
                bindings: [{ key: "interval-seconds", value: 300 }],
              },
            ],
          },
        }),
        [201],
      );
      const workflowId = installed.body.workflow.id;
      const initialDaily = installed.body.workflow.automations.find(
        (automation) => {
          return automation.official?.blueprintKey === "daily";
        },
      );
      const initialPulse = installed.body.workflow.automations.find(
        (automation) => {
          return automation.official?.blueprintKey === "pulse";
        },
      );
      if (!initialDaily?.official || !initialPulse?.official) {
        throw new Error("Expected initial Official Automations");
      }
      await accept(
        automationClient().disable({
          headers,
          params: { id: initialDaily.id },
        }),
        [200],
      );
      return {
        definitionName,
        unrelatedDefinitionName,
        initialBlueprints,
        unrelatedInitial,
        actor,
        agentId,
        headers,
        workflowId,
        initialDaily: { ...initialDaily, official: initialDaily.official },
        initialPulse: { ...initialPulse, official: initialPulse.official },
      };
    }

    let prepared: Awaited<ReturnType<typeof prepareInstalledBlueprints>>;
    beforeEach(async () => {
      prepared = await prepareInstalledBlueprints();
    });

    it("reconciles one changed Blueprint without enabling its sibling", async () => {
      const {
        definitionName,
        unrelatedDefinitionName,
        unrelatedInitial,
        headers,
        workflowId,
        initialDaily,
        initialPulse,
      } = prepared;
      const onceAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
      const changedPulse = pulseOnceBlueprint(onceAt);
      const activation = await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            scheduledBlueprint(),
            changedPulse,
          ]),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );
      expect(activation.body.outcome).toBe("accepted");
      const beforeDrain = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(
        beforeDrain.body.workflow.automations.find((automation) => {
          return automation.id === initialPulse.id;
        }),
      ).toMatchObject({
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 300 },
        official: {
          appliedFingerprint: initialPulse.official.appliedFingerprint,
        },
      });
      await expect(
        runOfficialWorkflowReconciliationWorker(),
      ).resolves.toStrictEqual({
        claimed: 1,
        completed: 1,
        advanced: 0,
        retried: 0,
        installations: 1,
      });
      const afterPulse = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(
        afterPulse.body.workflow.automations.find((automation) => {
          return automation.id === initialPulse.id;
        }),
      ).toMatchObject({
        id: initialPulse.id,
        chatThreadId: initialPulse.chatThreadId,
        enabled: true,
        kind: "schedule",
        schedule: { type: "once", atTime: onceAt, timezone: "Asia/Shanghai" },
        official: { reconciliationStatus: "current", intendedEnabled: true },
      });
      expect(
        afterPulse.body.workflow.automations.find((automation) => {
          return automation.id === initialDaily.id;
        }),
      ).toMatchObject({
        id: initialDaily.id,
        chatThreadId: initialDaily.chatThreadId,
        enabled: false,
        official: {
          appliedFingerprint: initialDaily.official.appliedFingerprint,
          intendedEnabled: false,
        },
      });
    });

    it("converges a scheduled Blueprint schema change", async () => {
      const {
        definitionName,
        unrelatedDefinitionName,
        unrelatedInitial,
        headers,
        workflowId,
        initialDaily,
      } = prepared;
      const onceAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
      const changedPulse = pulseOnceBlueprint(onceAt);
      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            scheduledBlueprint(),
            changedPulse,
          ]),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );
      await runOfficialWorkflowReconciliationWorker();
      const activation = await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            evolvedScheduledBlueprint(),
            changedPulse,
          ]),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );
      if (activation.body.outcome !== "accepted") {
        throw new Error(
          `Evolution catalog rejected: ${JSON.stringify(activation.body.diagnostics)}`,
        );
      }
      expect(activation.body).toMatchObject({ outcome: "accepted" });
      const work = await readOfficialWorkflowReconciliationState({});
      expect(work.body.reconciliationWork).toMatchObject([
        { definitionName, state: "pending" },
      ]);
      await runOfficialWorkflowReconciliationWorker();
      const evolved = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      const evolvedDaily = evolved.body.workflow.automations.find(
        (automation) => {
          return automation.id === initialDaily.id;
        },
      );
      expect(evolvedDaily).toMatchObject({
        id: initialDaily.id,
        enabled: false,
        schedule: {
          type: "cron",
          cronExpression: "0 6 * * *",
          timezone: "Asia/Shanghai",
        },
        official: {
          intendedEnabled: false,
          reconciliationStatus: "current",
          parameterBindings: expect.arrayContaining([
            { key: "cron-expression", value: "0 6 * * *" },
            { key: "autonomy-budget", value: 7 },
          ]),
        },
      });
      expect(
        evolvedDaily?.official?.parameterBindings.some((binding) => {
          return binding.key === "include-weekends";
        }),
      ).toBeFalsy();
      await expect(
        readWorkflowAutomationAutonomyFixture(context, initialDaily.id),
      ).resolves.toMatchObject({ autonomyBudget: 7, enabled: false });
    });

    it("recovers unresolved required Blueprint bindings", async () => {
      const {
        definitionName,
        unrelatedDefinitionName,
        unrelatedInitial,
        actor,
        headers,
        workflowId,
        initialDaily,
        initialPulse,
      } = prepared;
      const onceAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
      const changedPulse = pulseOnceBlueprint(onceAt);
      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            evolvedScheduledBlueprint(),
            changedPulse,
          ]),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );
      await runOfficialWorkflowReconciliationWorker();
      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            unresolvedScheduledBlueprint(),
            withUnresolvedRequiredBudget(changedPulse),
          ]),
          activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
        ]),
      );
      await setOfficialWorkflowsEnabled(actor, false);
      await runOfficialWorkflowReconciliationWorker();
      const unresolved = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(
        unresolved.body.workflow.automations.find((automation) => {
          return automation.id === initialDaily.id;
        }),
      ).toMatchObject({
        enabled: false,
        official: {
          intendedEnabled: false,
          reconciliationStatus: "needs_reconfiguration",
        },
      });
      expect(
        unresolved.body.workflow.automations.find((automation) => {
          return automation.id === initialPulse.id;
        }),
      ).toMatchObject({
        enabled: false,
        official: {
          intendedEnabled: true,
          reconciliationStatus: "needs_reconfiguration",
        },
      });
      const recovered = await accept(
        installationClient().reconfigure({
          headers,
          params: { workflowId },
          body: {
            blueprints: [
              {
                blueprintKey: "daily",
                bindings: [{ key: "required-budget", value: 9 }],
              },
              {
                blueprintKey: "pulse",
                bindings: [{ key: "required-budget", value: 6 }],
              },
            ],
          },
        }),
        [200],
      );
      expect(
        recovered.body.workflow.automations.find((automation) => {
          return automation.id === initialDaily.id;
        }),
      ).toMatchObject({
        enabled: false,
        official: { intendedEnabled: false, reconciliationStatus: "current" },
      });
      expect(
        recovered.body.workflow.automations.find((automation) => {
          return automation.id === initialPulse.id;
        }),
      ).toMatchObject({
        enabled: true,
        official: { intendedEnabled: true, reconciliationStatus: "current" },
      });
    });
  });

  it("restores a removed Blueprint with its permanent identity, thread, and Run history", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-materialize-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [gmailBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cancelAgentRunsThroughLogs(actor, agentId);
      await flushWaitUntilForTest();
    });
    mockGmailConnectorOAuth({
      email: `materialize-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return HttpResponse.json({
          historyId: String(100 + watchCalls),
          expiration: "4102444800000",
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "gmail-trigger", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Official Gmail Automation");
    }
    expect(automation).toMatchObject({
      enabled: true,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "current",
      },
    });

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const historical = await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [201],
    );
    const historicalRunId = await launchedAutomationRunId(
      actor,
      historical.body.chatThreadId,
    );
    if (!historicalRunId) {
      throw new Error("Expected historical Official Automation Run");
    }
    await runs.requestCancelRun(actor, historicalRunId, [200, 400]);
    const history = await listAgentRunLogIds(actor, agentId);
    expect(history).toContain(historicalRunId);

    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    await runOfficialWorkflowReconciliationWorker();
    const removed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(removed.body.workflow.automations).toStrictEqual([]);

    await syncCatalog(
      catalog([activeDefinition(definitionName, [gmailBlueprint()])]),
    );
    await runOfficialWorkflowReconciliationWorker();
    const restored = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(restored.body.workflow.automations).toHaveLength(1);
    expect(restored.body.workflow.automations[0]).toMatchObject({
      id: automation.id,
      chatThreadId: automation.chatThreadId,
      enabled: true,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "current",
      },
    });
    await expect(listAgentRunLogIds(actor, agentId)).resolves.toStrictEqual(
      history,
    );
  });

  it("promotes a staged schedule-to-Calendar transition and compensates registration failure", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-calendar-transition-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionScheduleBlueprint(),
        ]),
      ]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected Calendar transition actor to belong to an org");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cancelAgentRunsThroughLogs(actor, agentId);
      await flushWaitUntilForTest();
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {},
    );
    const firstAccessToken = `calendar-transition-first-${suffix}`;
    const secondAccessToken = `calendar-transition-second-${suffix}`;
    mockGoogleCalendarConnectorOAuth({
      accessToken: firstAccessToken,
      email: `calendar-transition-first-${suffix}@example.test`,
      subject: `calendar-transition-first-${suffix}`,
    });
    await workflowBdd.connectConnector(actor, "google-calendar");
    mockGoogleCalendarConnectorOAuth({
      accessToken: secondAccessToken,
      email: `calendar-transition-second-${suffix}@example.test`,
      subject: `calendar-transition-second-${suffix}`,
    });
    const secondOauth = await connectors.startOauth(
      actor,
      "google-calendar",
      "oauth",
      agentId,
      { intent: "add", displayName: "Official Calendar Second" },
    );
    const secondOauthState = new URL(
      secondOauth.authorizationUrl,
    ).searchParams.get("state");
    if (!secondOauthState) {
      throw new Error("Expected second Calendar OAuth state");
    }
    await connectors.completeOauthCallback("google-calendar", {
      code: `calendar-transition-second-${suffix}`,
      state: secondOauthState,
    });
    const calendarAccounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-calendar",
    );
    const secondAccount = calendarAccounts.find((account) => {
      return (
        account.externalEmail ===
        `calendar-transition-second-${suffix}@example.test`
      );
    });
    if (!secondAccount) {
      throw new Error("Expected second Calendar account");
    }
    await connectors.setDefaultBuiltinConnectorAccount(
      actor,
      "google-calendar",
      secondAccount.id,
    );
    const watch = configureOfficialCalendarWatchMock();
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "lifecycle-transition", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const original = installed.body.workflow.automations[0];
    if (!original) {
      throw new Error("Expected Calendar transition Automation");
    }
    const beforeRuns = await listAgentRunLogIds(actor, agentId);

    watch.watchShouldFail = true;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionCalendarBlueprint(),
        ]),
      ]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 0,
      advanced: 0,
      retried: 1,
      installations: 0,
    });
    const compensated = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(compensated.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "schedule",
        enabled: true,
        official: expect.objectContaining({ reconciliationStatus: "failed" }),
      }),
    ]);
    expect(watch.watchCalls).toBe(1);
    expect(watch.stopCalls).toBe(0);
    await expect(listAgentRunLogIds(actor, agentId)).resolves.toStrictEqual(
      beforeRuns,
    );

    watch.watchShouldFail = false;
    await expect(
      runDueOfficialWorkflowReconciliationRetry(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const promoted = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(promoted.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "event",
        eventType: "google-calendar-event-created",
        enabled: true,
        official: expect.objectContaining({
          blueprintKey: "lifecycle-transition",
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watch.watchCalls).toBe(2);
    expect(watch.watchAccessTokens).toStrictEqual([
      `Bearer ${secondAccessToken}`,
      `Bearer ${secondAccessToken}`,
    ]);
    expect(watch.stopCalls).toBe(0);
    await expect(listAgentRunLogIds(actor, agentId)).resolves.toStrictEqual(
      beforeRuns,
    );

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          {
            ...structureTransitionCalendarBlueprint(),
            desiredState: {
              kind: "event",
              eventType: "google-calendar-event-updated",
              eventConfig: {
                provider: "google-calendar",
                event: "event_updated",
                calendarId: "primary",
              },
            },
          },
        ]),
      ]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const reconfigured = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(reconfigured.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "event",
        eventType: "google-calendar-event-updated",
        enabled: true,
        official: expect.objectContaining({ reconciliationStatus: "current" }),
      }),
    ]);
    expect(watch.watchCalls).toBe(3);
    expect(watch.watchAccessTokens).toStrictEqual([
      `Bearer ${secondAccessToken}`,
      `Bearer ${secondAccessToken}`,
      `Bearer ${secondAccessToken}`,
    ]);
    expect(watch.stopCalls).toBe(1);
    expect(watch.stopAccessTokens).toStrictEqual([
      `Bearer ${secondAccessToken}`,
    ]);
  });

  it("prepares Official webhook credentials without blocking an effective downgrade", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-webhook-kms-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionScheduleBlueprint(),
        ]),
      ]),
    );
    const { actor, customerId, subscriptionId } =
      await workflowBdd.setupWorkflowOrg({ tier: "team" });
    const { agentId } = await workflowBdd.createAgent(actor);
    const pendingPreparation: {
      current?: {
        readonly release: () => void;
        readonly settled: Promise<unknown>;
      };
    } = {};
    onTestFinished(async () => {
      pendingPreparation.current?.release();
      await pendingPreparation.current?.settled;
    });
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "lifecycle-transition", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const original = installed.body.workflow.automations[0];
    if (!original) {
      throw new Error("Expected an Official schedule Automation");
    }
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          { ...webhookBlueprint(), key: "lifecycle-transition" },
        ]),
      ]),
    );
    const kms = holdSecretKms(1, context.signal);
    const reconciling = runOfficialWorkflowReconciliationWorker();
    const settled = settleIncludingAbort(reconciling);
    pendingPreparation.current = { release: kms.release, settled };
    await kms.entered;
    await webhooks.postStripeEvent(
      {
        id: `evt_official_kms_downgrade_${suffix}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );
    kms.release();
    await reconciling;
    const rejected = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(rejected.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "schedule",
        official: expect.objectContaining({ reconciliationStatus: "failed" }),
      }),
    ]);

    await runs.grantProEntitlement(actor, {
      customerId,
      subscriptionId,
      tier: "team",
    });
    await runDueOfficialWorkflowReconciliationRetry();
    const transitioned = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(transitioned.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "event",
        eventType: "webhook-received",
        official: expect.objectContaining({ reconciliationStatus: "current" }),
      }),
    ]);
    const revealed = await accept(
      automationClient().revealWebhookSecret({
        headers,
        params: { id: original.id },
        body: undefined,
      }),
      [200],
    );
    expect(revealed.body.webhookUrl).toContain("/whk_");
    expect(revealed.body.webhookSecret).toBeTruthy();
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          { ...webhookBlueprint(true), key: "lifecycle-transition" },
        ]),
      ]),
    );
    await runOfficialWorkflowReconciliationWorker();
    const preserved = await accept(
      automationClient().revealWebhookSecret({
        headers,
        params: { id: original.id },
        body: undefined,
      }),
      [200],
    );
    expect(preserved.body).toStrictEqual(revealed.body);
  }, 30_000);

  it("preserves identity and history across schedule/event transitions and retries failed compensation", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-structure-transition-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionScheduleBlueprint(),
        ]),
      ]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cancelAgentRunsThroughLogs(actor, agentId);
      await flushWaitUntilForTest();
    });
    mockGmailConnectorOAuth({
      email: `structure-transition-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchShouldFail = false;
    let watchCalls = 0;
    let stopCalls = 0;
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
        return HttpResponse.json({
          labels: [{ id: "Label_follow_up", name: "Follow Up" }],
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return watchShouldFail
          ? HttpResponse.json({ error: "watch failed" }, { status: 500 })
          : HttpResponse.json({
              historyId: String(500 + watchCalls),
              expiration: "4102444800000",
            });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        stopCalls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "lifecycle-transition", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const original = installed.body.workflow.automations[0];
    if (!original?.official) {
      throw new Error("Expected structure-transition Official Automation");
    }
    const automationId = original.id;

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const historical = await accept(
      automationClient().run({ headers, params: { id: automationId } }),
      [201],
    );
    const historicalRunId = await launchedAutomationRunId(
      actor,
      historical.body.chatThreadId,
    );
    if (!historicalRunId) {
      throw new Error("Expected historical Official Automation Run");
    }
    await runs.requestCancelRun(actor, historicalRunId, [200, 400]);
    const history = await listAgentRunLogIds(actor, agentId);
    expect(history).toContain(historicalRunId);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-new-message"),
        ]),
      ]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const scheduledToEvent = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(scheduledToEvent.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automationId,
        kind: "event",
        eventType: "gmail-new-message",
        enabled: true,
        official: expect.objectContaining({
          blueprintKey: "lifecycle-transition",
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(0);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionScheduleBlueprint(),
        ]),
      ]),
    );
    await runOfficialWorkflowReconciliationWorker();
    const eventToScheduled = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(eventToScheduled.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automationId,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 3600 },
        enabled: true,
        official: expect.objectContaining({ reconciliationStatus: "current" }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(0);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-new-message"),
        ]),
      ]),
    );
    await runOfficialWorkflowReconciliationWorker();
    watchShouldFail = true;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-label-applied"),
        ]),
      ]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 0,
      advanced: 0,
      retried: 1,
      installations: 0,
    });
    const compensated = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(compensated.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automationId,
        kind: "event",
        eventType: "gmail-new-message",
        enabled: true,
        official: expect.objectContaining({ reconciliationStatus: "failed" }),
      }),
    ]);
    expect(watchCalls).toBe(4);
    expect(stopCalls).toBe(0);
    await expect(listAgentRunLogIds(actor, agentId)).resolves.toStrictEqual(
      history,
    );

    watchShouldFail = false;
    await expect(
      runDueOfficialWorkflowReconciliationRetry(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const eventTypeTransition = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(eventTypeTransition.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automationId,
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: expect.objectContaining({
          labelName: "Follow Up",
          resolvedLabelId: "Label_follow_up",
        }),
        enabled: true,
        official: expect.objectContaining({
          blueprintKey: "lifecycle-transition",
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watchCalls).toBe(5);
    expect(stopCalls).toBe(0);
    await expect(listAgentRunLogIds(actor, agentId)).resolves.toStrictEqual(
      history,
    );
  });

  it("compensates failed Gmail watch updates and removes local consumption without remote stop", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-reconcile-watch-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [gmailLabelBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cancelAgentRunsThroughLogs(actor, agentId);
      await flushWaitUntilForTest();
    });
    mockGmailConnectorOAuth({ email: `reconcile-${suffix}@example.test` });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchShouldFail = false;
    let watchCalls = 0;
    let stopCalls = 0;
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
        return HttpResponse.json({
          labels: [
            { id: "Label_important", name: "Important" },
            { id: "Label_follow_up", name: "Follow Up" },
          ],
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return watchShouldFail
          ? HttpResponse.json({ error: "watch failed" }, { status: 500 })
          : HttpResponse.json({
              historyId: String(100 + watchCalls),
              expiration: String(now() + 60_000),
            });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        stopCalls++;
        return HttpResponse.json(
          { error: "stop must not be called" },
          { status: 500 },
        );
      }),
    );
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            {
              blueprintKey: "gmail-label-trigger",
              bindings: [{ key: "label-name", value: "Important" }],
            },
          ],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Official Gmail label Automation");
    }

    watchShouldFail = true;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [evolvedGmailLabelBlueprint()]),
      ]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 0,
      advanced: 0,
      retried: 1,
      installations: 0,
    });
    const compensatedUpdate = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(compensatedUpdate.body.workflow.automations[0]).toMatchObject({
      id: automation.id,
      enabled: true,
      eventConfig: expect.objectContaining({ labelName: "Important" }),
      official: {
        intendedEnabled: true,
        reconciliationStatus: "failed",
        parameterBindings: [{ key: "label-name", value: "Important" }],
      },
    });

    watchShouldFail = false;
    await expect(
      runDueOfficialWorkflowReconciliationRetry(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 1,
      advanced: 0,
      retried: 0,
      installations: 1,
    });
    const reconciledUpdate = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(reconciledUpdate.body.workflow.automations[0]).toMatchObject({
      id: automation.id,
      enabled: true,
      eventConfig: expect.objectContaining({ labelName: "Follow Up" }),
      official: {
        intendedEnabled: true,
        reconciliationStatus: "current",
        parameterBindings: [{ key: "next-label-name", value: "Follow Up" }],
      },
    });

    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 1,
      advanced: 0,
      retried: 0,
      installations: 1,
    });
    const removed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(removed.body.workflow.automations).toStrictEqual([]);
    expect(stopCalls).toBe(0);
  });
});

describe("Official Workflow Run admission", () => {
  it("pins ordinary Workflow publications across a normal revision", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(() => {
      return fixture.api.updateUserModelPreference(
        owned.actor,
        "claude-fable-5-1",
      );
    });
    const published: {
      workflowId: string;
      archive: ReturnType<typeof readPublishedArchive>;
    }[] = [];
    for (const name of ["first", "retained"]) {
      const start = context.mocks.s3.send.mock.calls.length;
      const workflowId = await owned.run(() => {
        return workflowBdd.createWorkflow(owned.actor, {
          agentId: owned.agentId,
          name: `published-${name}-${randomUUID().slice(0, 8)}`,
          instruction: `Read the ${name} publication.`,
        });
      });
      published.push({
        workflowId,
        archive: readPublishedArchive(context, start),
      });
    }
    const firstWorkflow = published[0];
    const retainedWorkflow = published[1];
    if (!firstWorkflow || !retainedWorkflow) {
      throw new Error("Expected two published Workflows");
    }
    const first = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use both original Workflow publications",
    });
    const updateStart = context.mocks.s3.send.mock.calls.length;
    await owned.run(() => {
      return accept(
        workflowClient().update({
          headers: authHeaders(owned.actor),
          params: { workflowId: firstWorkflow.workflowId },
          body: {
            instruction: "Read the revised first publication.",
            files: [],
          },
        }),
        [200],
      );
    });
    const updated = readPublishedArchive(context, updateStart);
    expect(updated.versionId).not.toBe(firstWorkflow.archive.versionId);
    const check = async (runId: string, expected: typeof published) => {
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        runId,
      );
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return expected.some((workflow) => {
            return (
              mount.name === getCustomSkillStorageName(workflow.workflowId)
            );
          });
        }) ?? [];
      expect(mounts).toHaveLength(2);
      for (const workflow of expected) {
        expect(mounts).toContainEqual(
          expect.objectContaining({
            name: getCustomSkillStorageName(workflow.workflowId),
            versionId: workflow.archive.versionId,
            archiveSize: workflow.archive.archiveSize,
            archiveUrl: expect.any(String),
          }),
        );
      }
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Workflow publications inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    };
    await check(first.runId, published);
    const later = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use the updated and retained Workflow publications",
    });
    await check(later.runId, [
      { ...firstWorkflow, archive: updated },
      retainedWorkflow,
    ]);
  });

  it("launches an idle ordinary workflow input with source annotations", async () => {
    const { owned, actor, workflow, source } =
      await ordinaryDelegationScenario();
    const sourceRunId = source.runId;
    const sourceThreadId = source.threadId;
    await owned.run(async () => {
      const launched = await accept(
        workflowClient().run({
          headers: { authorization: `Bearer ${source.token}` },
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: workflow.id },
        }),
        [200],
      );
      expect(launched.body.runId).toBeNull();
      const launchedRunId = await launchedAutomationRunId(
        actor,
        launched.body.chatThreadId,
      );
      if (!launchedRunId) {
        throw new Error(
          "Expected the idle ordinary workflow input to dispatch itself",
        );
      }
      expect(launchedRunId).not.toBe(sourceRunId);
      expect(launched.body.chatThreadId).not.toBe(sourceThreadId);
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        launchedRunId,
      );
      expect(claim.prompt).toBe(`/${workflow.name}`);
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_RUN_ID: ${sourceRunId}`,
      );
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_THREAD_ID: ${sourceThreadId}`,
      );
    });
  });

  it("spends the last inherited hop of an idle Official input and rejects the next hop", async () => {
    // Configure the source's last hop through a public Blueprint binding instead
    // of spending 31 prerequisite hops. The target must inherit, not refill it.
    const { actor, installation, sourceRunId } =
      await installIdleOfficialWorkflowScenario();
    const sourceClaim = await runs.claimRunnerJob(sourceRunId);
    await webhooks.requestAgentComplete(
      { runId: sourceRunId, exitCode: 1 },
      { authorization: `Bearer ${sourceClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const launched = await accept(
      workflowClient().run({
        headers: officialQueueHeaders(actor, sourceRunId, {
          origin: "agent_run",
        }),
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    expect(launched.body.runId).toBeNull();
    const launchedRunId = await launchedAutomationRunId(
      actor,
      launched.body.chatThreadId,
    );
    if (!launchedRunId) {
      throw new Error("Expected the final inherited hop to launch");
    }
    expect(launchedRunId).not.toBe(sourceRunId);
    const claim = await runs.claimRunnerJob(launchedRunId);

    const denied = await accept(
      workflowClient().run({
        headers: officialQueueHeaders(actor, launchedRunId, {
          origin: "agent_run",
        }),
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    expect(denied.body.runId).toBeNull();
    expect(denied.body.chatThreadId).toBe(launched.body.chatThreadId);
    // The exhausted hop is rejected by the pick once the thread is idle.
    await webhooks.requestAgentComplete(
      { runId: launchedRunId, exitCode: 1 },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const events = await allThreadEventRows(actor, denied.body.chatThreadId);
    const rejections = events.filter((event) => {
      return event.eventType === "input.rejected";
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      runId: null,
      payload: { error: "autonomy_budget_exhausted" },
    });
    await expect(
      launchedAutomationRunId(actor, denied.body.chatThreadId),
    ).resolves.toBe(launchedRunId);
  });
});

function officialQueueHeaders(
  actor: ApiTestUser,
  sourceRunId: string,
  queueCase: {
    readonly origin: "web" | "agent_run";
  },
) {
  return queueCase.origin === "web"
    ? authHeaders(actor)
    : {
        authorization: `Bearer ${runs.okouTokenForRunWithCapabilities(
          actor,
          sourceRunId,
          ["agent:write"],
        )}`,
      };
}

async function installIdleOfficialWorkflowScenario() {
  const definitionName = `api-test-idle-official-${randomUUID()}`;
  const sourceDefinitionName = `api-test-idle-source-${randomUUID()}`;
  installCatalogStorageFixture();
  await syncCatalog(
    catalog([
      activeDefinition(definitionName, []),
      activeDefinition(sourceDefinitionName, [loopBlueprint()]),
    ]),
  );
  const { actor } = await workflowBdd.setupWorkflowOrg({
    model: "claude-fable-5-1",
  });
  const { agentId } = await workflowBdd.createAgent(actor);
  await setOfficialWorkflowsEnabled(actor, true);
  const installation = await accept(
    officialClient().install({
      headers: authHeaders(actor),
      params: { definitionName },
      body: { agentId, blueprints: [] },
    }),
    [201],
  );
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await cancelAgentRunsThroughLogs(actor, agentId);
    await flushWaitUntilForTest();
  });
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();

  // The source's public Blueprint grants one delegation hop to the target.
  const sourceInstallation = await accept(
    officialClient().install({
      headers: authHeaders(actor),
      params: { definitionName: sourceDefinitionName },
      body: {
        agentId,
        blueprints: [
          {
            blueprintKey: "pulse",
            bindings: [
              { key: "interval-seconds", value: 3600 },
              { key: "autonomy-budget", value: 1 },
            ],
          },
        ],
      },
    }),
    [201],
  );
  const sourceAutomation = sourceInstallation.body.workflow.automations[0];
  if (!sourceAutomation) {
    throw new Error("Expected a one-hop Official source Automation");
  }
  const source = await accept(
    automationClient().run({
      headers: authHeaders(actor),
      params: { id: sourceAutomation.id },
    }),
    [201],
  );
  expect(source.body.runId).toBeNull();
  const sourceThreadId = source.body.chatThreadId;
  const sourceRunId = await launchedAutomationRunId(actor, sourceThreadId);
  if (!sourceRunId) {
    throw new Error("Expected the Official source Automation Run");
  }
  return { actor, installation, sourceRunId, sourceThreadId };
}
