import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
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
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateContract } from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import AdmZip from "adm-zip";
import { http, HttpResponse } from "msw";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { readNativeSchedule } from "../../../test-fixtures/morning-brief-native-schedule";
import {
  appendOfficialWorkflowQueueInputFixture,
  readOfficialWorkflowQueueInputFixture,
} from "../../../test-fixtures/official-workflow-queue";
import { setOrgDefaultAgentFixture } from "../../../test-fixtures/org-metadata";
import { verifyOkouToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  onRejection,
  settle,
  settleIncludingAbort,
} from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { officialWorkflowRoutes } from "../official-workflows";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { userPreferencesRoutes } from "../user-preferences";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { mockClerkUsers } from "./helpers/clerk-users";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import { createRouteMocks } from "./helpers/route-test";
import {
  readAgentRunFamilyCountsFixture,
  readLatestWorkflowAutomationRunFixture,
  readOfficialWorkflowRunStateFixture,
  readWorkflowAutomationAutonomyFixture,
  seedBuiltInModelKey,
} from "./helpers/runtime-state";
import { readExportText } from "./helpers/user-export-storage";

const context = testContext({ connectorCatalog: true });
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const outbox = createEmailOutboxStateApi(context);
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
// so fixtures use Fable, which model policy keeps off Pi.
async function selectBuiltInDefaultModel(actor: ApiTestUser): Promise<void> {
  await seedBuiltInModelKey(context, "claude-fable-5-1");
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      preferred: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
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

function structureTransitionGoogleMeetBlueprint(): OfficialWorkflowBlueprint {
  return {
    ...googleMeetBlueprint(1),
    key: "lifecycle-transition",
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

function configureOfficialGoogleMeetMultiAccountMock(
  accounts: readonly {
    readonly code: string;
    readonly accessToken: string;
    readonly externalId: string;
    readonly email: string;
  }[],
) {
  const testId = randomUUID();
  const topicName = `projects/vm0-ai-488909/topics/official-google-meet-race-${testId}`;
  const accountByCode = new Map(
    accounts.map((account) => {
      return [account.code, account] as const;
    }),
  );
  const accountByAccessToken = new Map(
    accounts.map((account) => {
      return [account.accessToken, account] as const;
    }),
  );
  const recorder = {
    createAccessTokens: [] as string[],
    deleteAccessTokens: [] as string[],
  };
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME", topicName);

  const accountFromRequest = (request: Request) => {
    const authorization = request.headers.get("authorization");
    const accessToken = authorization?.replace(/^Bearer /, "") ?? "";
    const account = accountByAccessToken.get(accessToken);
    if (!account) {
      throw new Error(`Unexpected Google Meet token: ${authorization}`);
    }
    return { account, authorization: `Bearer ${account.accessToken}` };
  };

  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const account = accountByCode.get(form.get("code") ?? "");
      if (!account) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Unknown test code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: account.accessToken,
        refresh_token: `refresh-${account.externalId}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", ({ request }) => {
      const { account } = accountFromRequest(request);
      return HttpResponse.json({
        id: account.externalId,
        email: account.email,
        name: `Official Meet ${account.externalId}`,
      });
    }),
    http.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      async ({ request }) => {
        const { account, authorization } = accountFromRequest(request);
        await expect(request.json()).resolves.toStrictEqual({
          targetResource: `//cloudidentity.googleapis.com/users/${account.externalId}`,
          eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
          notificationEndpoint: { pubsubTopic: topicName },
          ttl: "604800s",
        });
        recorder.createAccessTokens.push(authorization);
        return HttpResponse.json({
          response: {
            name: `subscriptions/official-google-meet-race-${account.externalId}-${recorder.createAccessTokens.length}`,
            targetResource: `//cloudidentity.googleapis.com/users/${account.externalId}`,
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
        const { account, authorization } = accountFromRequest(request);
        expect(new URL(request.url).searchParams.get("allowMissing")).toBe(
          "true",
        );
        recorder.deleteAccessTokens.push(authorization);
        return HttpResponse.json({
          name: `operations/delete-official-google-meet-race-${account.externalId}`,
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

function structureTransitionStripeBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "lifecycle-transition",
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig: { provider: "stripe", event: "invoice_paid" },
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

function unresolvedLoopBlueprint(): OfficialWorkflowBlueprint {
  return {
    key: "pulse",
    parameters: [
      {
        key: "interval-seconds",
        type: "integer",
        required: true,
      },
      {
        key: "required-budget",
        type: "integer",
        required: true,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "loop",
        intervalSeconds: { parameter: "interval-seconds" },
      },
      autonomyBudget: { parameter: "required-budget" },
    },
    runtime: { resultEmail: false },
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

function retiredDefinition(
  name: string,
): Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "retired" }
> {
  return {
    name,
    lifecycle: "retired",
    presentation: {
      category: "retired",
      order: 99,
      marketingCopy: "Retired Official Workflow.",
    },
  };
}

function syncClient(candidate: unknown) {
  return setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
  })(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await (async () => {
    return await accept(
      syncClient(candidate).sync({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
  })();
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
  return await (async () => {
    return await accept(
      setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
        cronOfficialWorkflowCatalogContract,
      ).sync({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
      [200],
    );
  })();
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

async function simulateOfficialWorkflowReconciliationWorkerCrash(
  definitionName: string,
): Promise<void> {
  await accept(
    stateClient().action({
      body: {
        action: "simulate-reconciliation-worker-crash",
        definitionName,
      },
    }),
    [200],
  );
}

async function simulateDormantMaterializationCrash(args: {
  readonly definitionName: string;
  readonly automationId: string;
}): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "simulate-dormant-materialization-crash", ...args },
    }),
    [200],
  );
}

async function simulateCurrentLifecycleGap(args: {
  readonly definitionName: string;
  readonly automationId: string;
}): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "simulate-current-lifecycle-gap", ...args },
    }),
    [200],
  );
}

async function simulateDormantMaterializationDiscardCrash(args: {
  readonly definitionName: string;
  readonly automationId: string;
}): Promise<void> {
  await accept(
    stateClient().action({
      body: {
        action: "simulate-dormant-materialization-discard-crash",
        ...args,
      },
    }),
    [200],
  );
}

async function pauseNextStructureTransitionPromotion(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "pause-next-structure-transition-promotion" },
    }),
    [200],
  );
}

async function waitForStructureTransitionPromotionPause(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "wait-for-structure-transition-promotion-pause" },
    }),
    [200],
  );
}

async function resumeStructureTransitionPromotion(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "resume-structure-transition-promotion" },
    }),
    [200],
  );
}

async function makeOfficialWorkflowReconciliationWorkDue(
  definitionName: string,
): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "make-reconciliation-work-due", definitionName },
    }),
    [200],
  );
}

async function cleanupCatalog() {
  await accept(stateClient().action({ body: { action: "cleanup" } }), [200]);
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

function automationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
}

function storageClient() {
  return setupApp({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

function staleQueueCleanupClient() {
  return setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
    testCronCleanupSandboxesStateContract,
  );
}

async function reconcileStaleQueuedMessages(threadId: string): Promise<void> {
  await accept(
    staleQueueCleanupClient().cleanup({
      body: {
        chatThreadIds: [threadId],
        runIds: [],
        exportJobIds: [],
      },
    }),
    [200],
  );
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
  const { events } = await chat.listThreadEvents(actor, chatThreadId);
  return [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  })?.runId;
}

async function requireActiveOfficialRunId(
  actor: ApiTestUser,
  agentId: string,
): Promise<string> {
  const listed = await runs.listAgentRuns(actor, {
    agent: agentId,
    status: "queued,pending,running",
    limit: 100,
  });
  expect(listed.runs).toHaveLength(1);
  const run = listed.runs[0];
  if (!run) {
    throw new Error("Expected a public active Official Run");
  }
  return run.id;
}

async function readAcceptedDefinitionFixture(definitionName: string) {
  const response = await accept(
    stateClient().action({ body: { action: "read", definitionName } }),
    [200],
  );
  if (!response.body.definition || !response.body.storage) {
    throw new Error(`Accepted Definition is unavailable: ${definitionName}`);
  }
  return {
    definition: response.body.definition,
    storage: response.body.storage,
  };
}

async function postOfficialWorkflowWebhook(args: {
  readonly webhookUrl: string;
  readonly secret: string;
  readonly body: string;
}) {
  const url = new URL(args.webhookUrl);
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: [
      ...webhooksWorkflowAutomationsRoutes,
      ...workflowAutomationsRoutes,
    ],
  }).request(url.pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature": computeHmacSignature(
        args.body,
        args.secret,
        timestamp,
      ),
    },
    body: args.body,
  });
  return { status: response.status, body: await response.json() };
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

// The queued-success test covers legacy and canonical encodings; the
// terminalization path keeps the current canonical agent-run source.
type OfficialQueueEncoding = {
  readonly encoding: "legacy" | "canonical";
  readonly origin: "web" | "agent_run";
  readonly storedBrand: "vm0" | "okou";
};

const officialQueueEncodings: readonly OfficialQueueEncoding[] = [
  { encoding: "canonical", origin: "agent_run", storedBrand: "okou" },
];

// Pin the persisted protocol independently of the production encoder.
const officialQueueContextIds = {
  legacy: {
    vm0: "d4f079af-190a-4a32-bf49-73175aa2d727",
    okou: "3f713f81-d611-47ec-a427-5a4844078890",
  },
  canonical: {
    vm0: "e1884e98-ab77-4eca-a420-90e591078804",
    okou: "0bdfae9e-63be-43dd-8193-a96e07787c20",
  },
} as const;

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

async function prepareOfficialQueueEncoding(
  args: OfficialQueueEncoding & {
    readonly eventId: string;
    readonly workflowId: string;
    readonly sourceRunId: string;
    readonly sourceThreadId: string;
    readonly agentId: string;
  },
): Promise<string> {
  const source = await readOfficialWorkflowQueueInputFixture(args.eventId);
  expect(source).toMatchObject({
    contextType: args.origin,
    contextId: officialQueueContextIds.legacy.okou,
    requiredOfficialWorkflowIds: [args.workflowId],
  });
  const userMessage = source.payload?.userMessage;
  if (!userMessage) {
    throw new Error("Expected queued Official document");
  }
  if (args.origin === "agent_run") {
    expect(userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "source",
        kind: "agent",
        runId: args.sourceRunId,
        threadId: args.sourceThreadId,
        agentId: args.agentId,
      }),
    );
  }
  if (args.encoding === "legacy" && args.storedBrand === "okou") {
    return source.id;
  }
  // New API requests always write Okou. Historical brand markers and the
  // canonical encoding require a persisted fixture to exercise older rows.
  const encoded = await appendOfficialWorkflowQueueInputFixture({
    eventId: source.id,
    contextId: officialQueueContextIds[args.encoding][args.storedBrand],
    contextType: args.origin,
    claim: source.requiredOfficialWorkflowIds,
    userMessage,
  });
  await expect(
    readOfficialWorkflowQueueInputFixture(source.id),
  ).resolves.toStrictEqual(source);
  return encoded.id;
}

async function assertOfficialQueueRawHistory(
  actor: ApiTestUser,
  threadId: string,
  eventId: string,
): Promise<readonly ChatEventRow[]> {
  const rows = await chat.listThreadEventRows(actor, threadId);
  expect(rows).toContainEqual(
    expect.objectContaining({ id: eventId, runId: null }),
  );
  const inputs = rows.filter((row) => {
    return row.eventType === "input.prompt" && row.runId === null;
  });
  for (const row of rows) {
    expect(row).not.toHaveProperty("requiredOfficialWorkflowIds");
    expect(row).not.toHaveProperty("required_official_workflow_ids");
    if (row.payload !== null) {
      expect(row.payload).not.toHaveProperty("requiredOfficialWorkflowIds");
    }
  }
  return inputs;
}

async function setOfficialWorkflowsEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.OfficialWorkflows]: enabled },
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

async function connectStripeOAuthForOfficialWorkflow(
  actor: ApiTestUser,
  args: { readonly accountId: string; readonly code: string },
): Promise<string> {
  mockStripeConnectorOAuth({ accountId: args.accountId, livemode: true });
  const started = await connectors.startOauth(actor, "stripe", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  await connectors.completeOauthCallback("stripe", {
    code: args.code,
    state,
  });
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "stripe",
  );
  const connected = accounts.find((account) => {
    return account.externalId === args.accountId;
  });
  if (!connected) {
    throw new Error(`Expected Stripe account ${args.accountId}`);
  }
  return connected.id;
}

function configureResultEmailRecipient(actor: ApiTestUser): void {
  const emailId = `email_${actor.userId}`;
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "Official",
      lastName: "Automation",
      imageUrl: null,
    },
  ]);
}

async function completeSuccessfulRun(
  runnerGroup: string,
  runId: string,
  output: string,
): Promise<void> {
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(runId);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooks.requestAgentEvents(
    {
      runId,
      events: [{ type: "result", sequenceNumber: 0, result: output }],
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      lastEventSequence: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `official-result-email-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`official result email history ${runId}`)
          .digest("hex"),
      },
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
}

async function installResultEmailLoopScenario(
  prefix: string,
  resultEmail: boolean,
) {
  installCatalogStorageFixture();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const definitionName = `${prefix}-${suffix}`;
  await syncCatalog(
    catalog([activeDefinition(definitionName, [loopBlueprint(resultEmail)])]),
  );
  const { actor } = await workflowBdd.setupWorkflowOrg({
    tier: "team",
    model: "claude-fable-5-1",
  });
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const { agentId } = await workflowBdd.createAgent(actor);
  const headers = authHeaders(actor);
  await setOfficialWorkflowsEnabled(actor, true);
  const installed = await accept(
    officialClient().install({
      headers,
      params: { definitionName },
      body: {
        agentId,
        blueprints: [
          {
            blueprintKey: "pulse",
            bindings: [{ key: "interval-seconds", value: 60 }],
          },
        ],
      },
    }),
    [201],
  );
  const automation = installed.body.workflow.automations.find((candidate) => {
    return candidate.official?.blueprintKey === "pulse";
  });
  if (!automation) {
    throw new Error("Expected Official result email loop Automation");
  }
  configureResultEmailRecipient(actor);
  const runnerGroup = runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await bdd.deleteAgent(actor, agentId);
    await cleanupCatalog();
  });
  return {
    actor,
    agentId,
    automation,
    definitionName,
    headers,
    installed,
    runnerGroup,
  };
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
    installCatalogStorageFixture();
    await bdd.deleteAgent(actor, agentId);
    await cleanupCatalog();
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

async function installStaleAdmissionScenario() {
  installCatalogStorageFixture();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const definitionName = `api-test-stale-${suffix}`;
  await syncCatalog(
    catalog([activeDefinition(definitionName, [loopBlueprint()])]),
  );
  const { actor } = await workflowBdd.setupWorkflowOrg({
    model: "claude-fable-5-1",
  });
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const { agentId } = await workflowBdd.createAgent(actor);
  const headers = authHeaders(actor);
  await setOfficialWorkflowsEnabled(actor, true);
  const installed = await accept(
    officialClient().install({
      headers,
      params: { definitionName },
      body: {
        agentId,
        blueprints: [
          {
            blueprintKey: "pulse",
            bindings: [{ key: "interval-seconds", value: 60 }],
          },
        ],
      },
    }),
    [201],
  );
  onTestFinished(async () => {
    installCatalogStorageFixture();
    const createdRuns = await runs.listAgentRuns(actor, {
      agent: agentId,
      limit: 100,
    });
    for (const run of createdRuns.runs) {
      await runs.requestCancelRun(actor, run.id, [200, 400]);
    }
    await flushWaitUntilForTest();
    await bdd.deleteAgent(actor, agentId);
    await cleanupCatalog();
  });
  const automation = installed.body.workflow.automations[0];
  if (!automation?.official) {
    throw new Error("Expected Official Automation state");
  }
  return {
    actor,
    agentId,
    automation,
    definitionName,
    headers,
    installed,
    originalFingerprint: automation.official.appliedFingerprint,
    suffix,
  };
}

beforeEach(async () => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  // testContext seeds the default source; this hook also seeds the source
  // derived from the unique bucket used by this test.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `official-workflow-installation-test-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog();
  await cleanupCatalog();
});

describe("Morning Brief preference", () => {
  async function setupEnabledMorningBrief() {
    installCatalogStorageFixture();
    const synced = await syncDeployedCatalog();
    expect(synced.body).toMatchObject({ outcome: "accepted", diagnostics: [] });

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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cleanupCatalog();
    });
    await connectBriefSource(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, false);

    const initial = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(initial.body).toStrictEqual({
      status: "paused",
      enabled: false,
      unavailableReason: null,
    });

    const enabledResponses = await Promise.all([
      accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: true },
        }),
        [200],
      ),
      accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: true },
        }),
        [200],
      ),
    ]);
    for (const response of enabledResponses) {
      expect(response.body).toMatchObject({
        enabled: true,
        unavailableReason: null,
      });
    }

    const installed = await accept(
      workflowCollectionClient().list({ headers, query: {} }),
      [200],
    );
    const morningBriefs = installed.body.filter((workflow) => {
      return workflow.official?.definitionName === "morning-brief";
    });
    expect(morningBriefs).toHaveLength(1);
    const morningBrief = morningBriefs[0];
    if (!morningBrief) {
      throw new Error("Expected one Morning Brief installation");
    }
    expect(morningBrief.agentId).toBe(onboarding.defaultAgentId);
    const detail = await accept(
      installationClient().get({
        headers,
        params: { workflowId: morningBrief.id },
      }),
      [200],
    );
    expect(detail.body.workflow.automations).toHaveLength(1);
    const automation = detail.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Morning Brief automation identity");
    }
    expect(automation).toMatchObject({
      kind: "schedule",
      enabled: true,
      chatThreadId: null,
      nextRunAt: expect.any(String),
      schedule: {
        type: "cron",
        cronExpression: "0 7 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        blueprintKey: "daily-delivery",
        reconciliationStatus: "current",
      },
    });
    const identities = {
      workflowId: morningBrief.id,
      automationId: automation.id,
      chatThreadId: automation.chatThreadId,
    };
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.id),
    ).resolves.toMatchObject({
      officialBlueprintKey: "daily-delivery",
      officialResultEmailEnabled: true,
    });
    return { actor, headers, identities, morningBrief };
  }

  it("installs idempotently without the Official Workflows feature", async () => {
    const { identities } = await setupEnabledMorningBrief();
    expect(identities).toStrictEqual({
      workflowId: expect.any(String),
      automationId: expect.any(String),
      chatThreadId: null,
    });
  });

  it("preserves Morning Brief identities across disable and re-enable", async () => {
    const { headers, identities, morningBrief } =
      await setupEnabledMorningBrief();
    const disabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect(disabled.body).toStrictEqual({
      status: "paused",
      enabled: false,
      unavailableReason: null,
    });

    const reenabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      unavailableReason: null,
    });
    const after = await accept(
      installationClient().get({
        headers,
        params: { workflowId: morningBrief.id },
      }),
      [200],
    );
    expect(after.body.workflow.automations).toMatchObject([
      {
        id: identities.automationId,
        chatThreadId: identities.chatThreadId,
        enabled: true,
        nextRunAt: expect.any(String),
      },
    ]);
    expect(after.body.workflow.id).toBe(identities.workflowId);
  });

  it("preserves enable intent while timezone or default Agent is unavailable", async () => {
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

    const missingAgent = bdd.user();
    mockBriefMemberships([
      { actor: missingAgent, createdAt: new Date("2020-01-01T00:00:00.000Z") },
    ]);
    await bdd.updateUserTimezone(missingAgent, "Asia/Shanghai");
    await tickBriefEnrollment(missingAgent);
    const agentHeaders = authHeaders(missingAgent);
    const unavailableAgent = await accept(
      morningBriefPreferenceClient().get({ headers: agentHeaders }),
      [200],
    );
    expect(unavailableAgent.body).toMatchObject({
      enabled: false,
      unavailableReason: "missing-default-agent",
    });
    const rejectedAgent = await accept(
      morningBriefPreferenceClient().update({
        headers: agentHeaders,
        body: { enabled: true },
      }),
      [200],
    );
    expect(rejectedAgent.body).toMatchObject({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-default-agent",
    });

    for (const fixture of [missingTimezone.actor, missingAgent]) {
      const listed = await accept(
        workflowCollectionClient().list({
          headers: authHeaders(fixture),
          query: {},
        }),
        [200],
      );
      expect(
        listed.body.filter((workflow) => {
          return workflow.official?.definitionName === "morning-brief";
        }),
      ).toHaveLength(0);
    }
  });

  it("does not treat outstanding membership qualification as enable intent", async () => {
    const actor = bdd.user();
    mockBriefMemberships([
      { actor, createdAt: new Date("2020-01-01T00:00:00.000Z") },
    ]);
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    const respond = membershipReads.getMockImplementation();
    if (!respond) {
      throw new Error("Expected the historical membership response");
    }
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    membershipReads.mockImplementation(async (...args) => {
      if (!started.settled()) {
        started.resolve(undefined);
      }
      await release.promise;
      return await respond(...args);
    });
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
    });

    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    await started.promise;
    // The worker revisit can finish while the timezone request still owns
    // the qualification attempt. Unknown eligibility is not an enable choice.
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "preparing",
      unavailableReason: "missing-default-agent",
    });

    // A user's explicit enable is real intent even before qualification or
    // prerequisites complete, and the older eligibility read cannot erase it.
    const enabled = await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      enabled: true,
      status: "preparing",
      unavailableReason: "missing-default-agent",
    });
    release.resolve(undefined);
    await flushWaitUntilForTest();
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "preparing",
      unavailableReason: "missing-default-agent",
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, alternate.agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, alternate.agentId);
      await cleanupCatalog();
    });
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

  async function setupBriefWithChangedOrgDefaultAgent() {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const onboarding = await bdd.readOnboardingStatus(actor);
    const originalAgentId = onboarding.defaultAgentId;
    if (!originalAgentId) {
      throw new Error("Expected a default Agent");
    }
    const replacement = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await setOrgDefaultAgentFixture({ orgId, agentId: originalAgentId });
      await bdd.deleteAgent(actor, replacement.agentId);
      await cleanupCatalog();
    });
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
    const [installed] = await listMorningBriefInstallations(actor);
    if (!installed) {
      throw new Error("Expected a Preferences-managed installation");
    }
    expect(installed.agentId).toBe(originalAgentId);

    // Only the Clerk org-creation bootstrap writes `default_agent_id`, so this
    // fixture is the narrow way to exercise an existing org changing defaults.
    await setOrgDefaultAgentFixture({ orgId, agentId: replacement.agentId });
    return { actor, headers, installed, originalAgentId, replacement };
  }

  it("toggles only the installed brief after the default Agent changes", async () => {
    const { actor, headers, installed, replacement } =
      await setupBriefWithChangedOrgDefaultAgent();
    await setOfficialWorkflowsEnabled(actor, true);
    const onNewDefaultAgent = await installMorningBriefFromCatalog(
      actor,
      replacement.agentId,
    );
    const paused = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, status: "paused" });
    await expect(
      readMorningBriefAutomations(actor, installed.id),
    ).resolves.toMatchObject([{ enabled: false }]);
    await expect(
      readMorningBriefAutomations(actor, onNewDefaultAgent),
    ).resolves.toMatchObject([{ enabled: true }]);

    const reenabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({ enabled: true, status: "enabled" });
    await expect(
      readMorningBriefAutomations(actor, installed.id),
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, alternate.agentId);
      await cleanupCatalog();
    });
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

async function readUserTimezone(actor: ApiTestUser): Promise<string | null> {
  const response = await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).get({ headers: authHeaders(actor) }),
    [200],
  );
  return response.body.timezone;
}

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

async function tickBriefEnrollment(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped member");
  }
  return await accept(
    setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
      testWorkflowAutomationExecutionContract,
    ).enrollMorningBrief({
      body: { orgId: actor.orgId, userId: actor.userId },
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

/**
 * The member's single Morning Brief schedule. A legacy-phase member is read
 * through the workflow detail endpoint. No endpoint exposes the native
 * schedule row, so once a member leaves the legacy phase that row is read
 * directly.
 */
async function readBriefSchedule(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const native = await readNativeSchedule({
    orgId: actor.orgId,
    userId: actor.userId,
  });
  if (native !== undefined && native.phase !== "legacy") {
    return {
      nextRunAt: native.nextRunAt?.toISOString() ?? null,
      timezone: native.timezone,
    };
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
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await cleanupCatalog();
  });
  return { actor, createdAt };
}

describe("Morning Brief default onboarding", () => {
  it("enrolls a member whose timezone was saved before enrollment was recorded", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await connectBriefSource(actor);
    const device = createAuthDeviceApiActions(context);
    const started = await device.startCliDevice();
    await device.requestCliApproval(
      actor,
      { device_code: started.device_code, timezone: "Asia/Shanghai" },
      [200],
    );
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });

    mockBriefMemberships([{ actor, createdAt }]);
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    await expect(readBriefSchedule(actor)).resolves.toMatchObject({
      timezone: "Asia/Shanghai",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("keeps a brief disabled after enrollment once the member turns it off", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await connectBriefSource(actor);
    const device = createAuthDeviceApiActions(context);
    const started = await device.startCliDevice();
    await device.requestCliApproval(
      actor,
      { device_code: started.device_code, timezone: "Asia/Shanghai" },
      [200],
    );
    mockBriefMemberships([{ actor, createdAt }]);
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
    });

    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    // Later enrollment and preference passes re-run completion; a disabled
    // enrollment must not be completed (and re-enabled) again.
    mockBriefMemberships([{ actor, createdAt }]);
    await tickBriefEnrollment(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    expect((await readBriefPreference(actor)).body).toStrictEqual({
      status: "paused",
      enabled: false,
      unavailableReason: null,
    });
    await expect(readBriefSchedule(actor)).resolves.toMatchObject({
      nextRunAt: null,
    });
  });

  it("waits locally for a known member's timezone and installs as soon as initialization supplies it", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    const startedAt = now();
    await withMockNowForTest(startedAt, async () => {
      await tickBriefEnrollment(actor);
      await Promise.all([
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
      ]);
    });
    await withMockNowForTest(startedAt + 60_000, async () => {
      await tickBriefEnrollment(actor);
      expect(membershipReads).not.toHaveBeenCalled();
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "preparing",
        unavailableReason: "missing-timezone",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );

      await initializeBriefMember(actor, "Asia/Shanghai");
      expect(membershipReads).toHaveBeenCalledTimes(1);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
      await expect(readBriefSchedule(actor)).resolves.toMatchObject({
        timezone: "Asia/Shanghai",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    });
  });

  it("waits locally for the default Agent and recovers after the organization bootstrap arrives", async () => {
    const { actor, createdAt } = await prepareBriefMember({ bootstrap: false });
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    const startedAt = now();
    await withMockNowForTest(startedAt, async () => {
      await initializeBriefMember(actor, "Asia/Shanghai");
      expect(membershipReads).toHaveBeenCalledTimes(1);
      await tickBriefEnrollment(actor);
      await tickBriefEnrollment(actor);
    });
    await withMockNowForTest(startedAt + 60_000, async () => {
      await tickBriefEnrollment(actor);
      expect(membershipReads).toHaveBeenCalledTimes(1);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "preparing",
        unavailableReason: "missing-default-agent",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );

      await deliverClerkOrganizationCreated(actor, createdAt);
    });
    await withMockNowForTest(startedAt + 120_000, async () => {
      await tickBriefEnrollment(actor);
      expect(membershipReads).toHaveBeenCalledTimes(2);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    });
  });

  it("installs without any connected source and stays single across concurrent cron ticks", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
    await Promise.all([tickBriefEnrollment(actor), tickBriefEnrollment(actor)]);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("installs from the preference toggle without any connected source", async () => {
    const { actor } = await prepareBriefMember();
    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [200],
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
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

  it("preserves a cancellation before installation across late and duplicate membership events", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
    await connectBriefSource(actor);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await tickBriefEnrollment(actor);
    await initializeBriefMember(actor, "America/Los_Angeles");
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(readUserTimezone(actor)).resolves.toBe("Asia/Shanghai");
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("ignores historical membership events even when replayed after activation", async () => {
    const { actor } = await prepareBriefMember();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    mockBriefMemberships([{ actor, createdAt }]);
    await connectBriefSource(actor);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("installs once with either event order and concurrent initialization", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await connectBriefSource(actor);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "preparing",
      unavailableReason: "missing-timezone",
    });
    await Promise.all([
      initializeBriefMember(actor, "Asia/Shanghai"),
      initializeBriefMember(actor, "Asia/Shanghai"),
    ]);
    const [before] = await listMorningBriefInstallations(actor);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await tickBriefEnrollment(actor);
    const [after] = await listMorningBriefInstallations(actor);
    expect(after?.id).toBe(before?.id);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("waits locally for a known member's catalog and recovers on the next worker revisit", async () => {
    const { actor, createdAt } = await prepareBriefMember({
      catalogAvailable: false,
    });
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    const startedAt = now();
    await withMockNowForTest(startedAt, async () => {
      await initializeBriefMember(actor, "Asia/Shanghai");
      await Promise.all([
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
      ]);
      expect(membershipReads).not.toHaveBeenCalled();
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );
    });
    await flushWaitUntilForTest();
    for (const elapsed of [60_000, 120_000, 180_000]) {
      await withMockNowForTest(startedAt + elapsed, async () => {
        await tickBriefEnrollment(actor);
        await flushWaitUntilForTest();
        expect(membershipReads).not.toHaveBeenCalled();
        expect((await readBriefPreference(actor)).body).toMatchObject({
          enabled: true,
          status: "error",
        });
      });
    }
    await syncDeployedCatalog();
    await withMockNowForTest(startedAt + 240_000, async () => {
      await tickBriefEnrollment(actor);
      await flushWaitUntilForTest();
      expect(membershipReads).toHaveBeenCalledTimes(1);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        status: "enabled",
        enabled: true,
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    });
  });

  it("shares an inline Clerk failure cooldown with repeated initialization and worker ticks", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    membershipReads.mockRejectedValue(new Error("Temporary Clerk outage"));
    const startedAt = now();
    await withMockNowForTest(startedAt, async () => {
      const initialized = await initializeBriefMember(actor, "Asia/Shanghai");
      expect(initialized.body).toMatchObject({ timezone: "Asia/Shanghai" });
      await Promise.all([
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
      ]);
      expect(membershipReads).toHaveBeenCalledTimes(1);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: false,
        status: "error",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );
    });
    mockBriefMemberships([{ actor, createdAt }]);
    await withMockNowForTest(startedAt + 59_999, async () => {
      await Promise.all([
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
      ]);
      expect(membershipReads).toHaveBeenCalledTimes(1);
    });
    await withMockNowForTest(startedAt + 60_000, async () => {
      await Promise.all([
        tickBriefEnrollment(actor),
        tickBriefEnrollment(actor),
      ]);
      expect(membershipReads).toHaveBeenCalledTimes(2);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    });
  });

  it("recovers an interrupted membership check after its five-minute claim expires", async () => {
    const timezone = "Asia/Shanghai";
    const { actor, createdAt } = await prepareBriefMember();
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    const interrupted = new DOMException(
      "Clerk request interrupted",
      "AbortError",
    );
    membershipReads.mockRejectedValueOnce(interrupted);
    const startedAt = now();
    await withMockNowForTest(startedAt, async () => {
      await expect(
        setupApp({
          context,
          routes: userPreferencesRoutes,
          rethrowErrors: true,
        })(userPreferencesContract).initialize({
          headers: authHeaders(actor),
          body: { timezone, locale: "en-US" },
        }),
      ).rejects.toBe(interrupted);
      expect(membershipReads).toHaveBeenCalledTimes(1);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: false,
        status: "preparing",
      });
      await expect(readUserTimezone(actor)).resolves.toBe(timezone);
    });
    mockBriefMemberships([{ actor, createdAt }]);
    await withMockNowForTest(startedAt + 299_999, async () => {
      await tickBriefEnrollment(actor);
      await tickBriefEnrollment(actor);
      expect(membershipReads).toHaveBeenCalledTimes(1);
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );
    });
    await withMockNowForTest(startedAt + 300_000, async () => {
      await flushWaitUntilForTest();
      await tickBriefEnrollment(actor);
      await flushWaitUntilForTest();
      expect(membershipReads).toHaveBeenCalledTimes(2);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    });
    await withMockNowForTest(startedAt + 360_000, async () => {
      await tickBriefEnrollment(actor);
      await flushWaitUntilForTest();
      expect(membershipReads).toHaveBeenCalledTimes(2);
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
    });
  });

  it("reschedules an existing brief after a timezone change and keeps a paused brief paused", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
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

  it("enrolls an invited member of an existing organization without enrolling its existing owner", async () => {
    const owner = await prepareBriefMember({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const actor = bdd.user({ orgId: owner.actor.orgId, orgRole: "org:member" });
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    mockBriefMemberships([owner, { actor, createdAt }]);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await initializeBriefMember(owner.actor, "Asia/Tokyo");
    expect((await readBriefPreference(owner.actor)).body).toMatchObject({
      status: "paused",
      enabled: false,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
    await expect(
      listMorningBriefInstallations(owner.actor),
    ).resolves.toHaveLength(0);
  });

  it("isolates enrollment, sources, and cancellation for the same account in two organizations", async () => {
    const first = await prepareBriefMember();
    const second = await prepareBriefMember({
      actor: bdd.user({ userId: first.actor.userId, email: first.actor.email }),
    });
    mockBriefMemberships([first, second]);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(second.actor),
        body: { enabled: false },
      }),
      [200],
    );
    await initializeBriefMember(first.actor, "Asia/Shanghai");
    await initializeBriefMember(second.actor, "America/Los_Angeles");
    await connectBriefSource(first.actor);
    await tickBriefEnrollment(first.actor);
    expect((await readBriefPreference(first.actor)).body).toMatchObject({
      status: "enabled",
    });
    await expect(readBriefSchedule(first.actor)).resolves.toMatchObject({
      timezone: "Asia/Shanghai",
    });
    expect((await readBriefPreference(second.actor)).body).toMatchObject({
      status: "paused",
      enabled: false,
    });
    await expect(readUserTimezone(second.actor)).resolves.toBe(
      "America/Los_Angeles",
    );
    await connectBriefSource(second.actor);
    await tickBriefEnrollment(second.actor);
    expect((await readBriefPreference(second.actor)).body).toMatchObject({
      status: "paused",
      enabled: false,
    });
    expect((await readBriefPreference(first.actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await expect(
      listMorningBriefInstallations(second.actor),
    ).resolves.toHaveLength(0);
  });

  it.each(["unstarted", "unavailable", "interrupted"] as const)(
    "keeps a removed membership paused after a late created event when qualification was %s",
    async (qualification) => {
      const { actor, createdAt } = await prepareBriefMember();
      const membershipReads =
        context.mocks.clerk.organizations.getOrganizationMembershipList;
      membershipReads.mockClear();
      if (qualification === "interrupted") {
        membershipReads.mockRejectedValueOnce(
          new Error("Temporary Clerk outage"),
        );
      } else {
        mockBriefMemberships([]);
      }
      if (qualification !== "unstarted") {
        await initializeBriefMember(actor, "America/Los_Angeles");
        expect(membershipReads).toHaveBeenCalledTimes(1);
      }
      await deliverClerkOrganizationMembershipDeleted(actor);
      mockBriefMemberships([]);
      membershipReads.mockClear();
      await deliverClerkOrganizationMembershipCreated(actor, createdAt);
      await tickBriefEnrollment(actor);
      expect(membershipReads).not.toHaveBeenCalled();
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: false,
        status: "paused",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        0,
      );
    },
  );

  it("enrolls a new membership generation after removal", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await deliverClerkOrganizationMembershipDeleted(actor);
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    const newMembershipId = `rejoined-${actor.userId}-${actor.orgId}`;
    const rejoinedAt = new Date(createdAt.getTime() + 1000);
    mockBriefMemberships([
      { actor, createdAt: rejoinedAt, membershipId: newMembershipId },
    ]);
    await deliverClerkOrganizationMembershipCreated(
      actor,
      rejoinedAt,
      newMembershipId,
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
    expect(membershipReads).toHaveBeenCalledTimes(1);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("refuses to install pending work for a different live membership generation", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    mockBriefMemberships([
      {
        actor,
        createdAt: new Date(createdAt.getTime() + 1000),
        membershipId: `replacement-${actor.userId}-${actor.orgId}`,
      },
    ]);
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membershipReads.mockClear();
    await initializeBriefMember(actor, "Asia/Shanghai");
    expect(membershipReads).toHaveBeenCalledTimes(1);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
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

  it("never reinstalls a deleted completed enrollment", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    const [installed] = await listMorningBriefInstallations(actor);
    if (!installed) {
      throw new Error("Expected installed brief");
    }
    await accept(
      installationClient().uninstall({
        headers: authHeaders(actor),
        params: { workflowId: installed.id },
      }),
      [204],
    );
    await tickBriefEnrollment(actor);
    await tickBriefEnrollment(actor);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });
});

describe("Official Workflow installations", () => {
  it("materializes active deployed Official Workflows and rejects retired installations", async () => {
    installCatalogStorageFixture();
    const synced = await syncDeployedCatalog();
    expect(synced.body).toMatchObject({ outcome: "accepted", diagnostics: [] });

    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);

    const discovered = await accept(officialClient().list({ headers }), [200]);
    expect(
      discovered.body.map(({ name, displayName }) => {
        return { name, displayName };
      }),
    ).toStrictEqual([
      {
        name: "morning-brief",
        displayName: "Morning Brief",
      },
    ]);

    const installedMorningBrief = await accept(
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
    expect(installedMorningBrief.body.definition).toMatchObject({
      name: "morning-brief",
      lifecycle: "active",
      blueprints: [{ key: "daily-delivery" }],
    });
    expect(installedMorningBrief.body.workflow).toMatchObject({
      name: "morning-brief",
      displayName: "Morning Brief",
      agentId,
      official: {
        definitionName: "morning-brief",
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    });
    expect(installedMorningBrief.body.workflow.automations).toHaveLength(1);
    const morningBriefAutomation =
      installedMorningBrief.body.workflow.automations[0];
    expect(morningBriefAutomation).toMatchObject({
      kind: "schedule",
      enabled: true,
      chatThreadId: null,
      schedule: {
        type: "cron",
        cronExpression: "0 7 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        blueprintKey: "daily-delivery",
        reconciliationStatus: "current",
        intendedEnabled: true,
        parameterBindings: [],
      },
    });
    if (!morningBriefAutomation) {
      throw new Error("Expected the Morning Brief Automation");
    }
    await expect(
      readWorkflowAutomationAutonomyFixture(context, morningBriefAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 10,
      enabled: true,
      officialBlueprintKey: "daily-delivery",
      officialResultEmailEnabled: true,
    });

    const retiredConnectorDoctor = await accept(
      officialClient().install({
        headers,
        params: { definitionName: "connector-doctor" },
        body: { agentId, blueprints: [] },
      }),
      [409],
    );
    expect(retiredConnectorDoctor.body.error.message).toBe(
      "Official Workflow is retired: connector-doctor",
    );
  });

  it("names a new Morning Brief thread in the default locale", async () => {
    installCatalogStorageFixture();
    await syncDeployedCatalog();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    await selectBuiltInDefaultModel(actor);
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(sharedAgentOwner, publicAgentId);
      await bdd.deleteAgent(sharedAgentOwner, privateAgentId);
    });
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
    const { dailyAutomation, definitionName, headers, installed, orgId } =
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

    const customStorage = await accept(
      storageClient().action({
        body: {
          action: "read-storage-state",
          org_id: orgId,
          user_id: VOLUME_ORG_USER_ID,
          storage_name: getCustomSkillStorageName(firstWorkflowId),
        },
      }),
      [200],
    );
    expect(customStorage.body.storage_state).toBeNull();
  });

  it("exports the accepted Official Workflow instruction after a catalog revision", async () => {
    const { actor, definitionName, headers, installed, zeroBlueprintName } =
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

    const exports = createOpsLogsApi(context);
    const storage = installDurableUserExportStorage(context);
    const started = await exports.requestPostUserExport(actor, [202]);
    await flushWaitUntilForTest();
    await accept(
      setupApp({ context, routes: testUserExportWorkRoutes })(
        testUserExportWorkContract,
      ).action({
        body: {
          action: "run",
          userId: actor.userId,
          jobId: started.body.jobId,
          maxSteps: 200,
        },
      }),
      [200],
    );
    const status = await exports.requestGetUserExport(actor, [200]);
    expect(status.body.job).toMatchObject({
      id: started.body.jobId,
      status: "completed",
    });
    const downloadUrl = status.body.job?.downloadUrl;
    if (!downloadUrl) {
      throw new Error("Expected a downloadable Official Workflow export");
    }
    const zip = new AdmZip(storage.download(downloadUrl));
    expect(
      JSON.parse(
        readExportText(zip, `workflows/${current.body.workflow.id}.json`),
      ),
    ).toMatchObject({
      id: current.body.workflow.id,
      officialDefinitionName: definitionName,
      displayName: current.body.workflow.displayName,
      description: current.body.workflow.description,
      instruction,
    });
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
    let secondAgentDeleted = false;
    onTestFinished(async () => {
      if (!secondAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, secondAgentId);
      }
    });
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
    secondAgentDeleted = true;
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
    let ordinaryAgentDeleted = false;
    onTestFinished(async () => {
      if (!ordinaryAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, ordinaryAgentId);
      }
    });
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
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
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: ordinaryWorkflowId },
      }),
      [204],
    );
    await bdd.deleteAgent(actor, ordinaryAgentId);
    ordinaryAgentDeleted = true;

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

  it("preserves automation identity and pause state when reconfiguring an Official installation", async () => {
    const { dailyAutomation, headers, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;
    const automationIds = installed.body.workflow.automations.map(
      (automation) => {
        return automation.id;
      },
    );
    const automationThreadById = new Map(
      installed.body.workflow.automations.map((automation) => {
        return [automation.id, automation.chatThreadId] as const;
      }),
    );
    const pulseAutomation = installed.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "pulse";
      },
    );
    if (!pulseAutomation) {
      throw new Error("Expected Official Workflow loop automation");
    }
    const paused = await accept(
      automationClient().disable({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({
      enabled: false,
      nextRunAt: null,
      official: { intendedEnabled: false },
    });
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: false,
      officialResultEmailEnabled: true,
    });

    const reconfigured = await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [{ key: "cron-expression", value: "0 9 * * *" }],
            },
          ],
        },
      }),
      [200],
    );
    const reconfiguredDaily = reconfigured.body.workflow.automations.find(
      (automation) => {
        return automation.official?.blueprintKey === "daily";
      },
    );
    expect(reconfiguredDaily).toMatchObject({
      id: dailyAutomation.id,
      enabled: false,
      schedule: {
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
      },
      official: {
        intendedEnabled: false,
        reconciliationStatus: "current",
      },
    });
    expect(
      reconfigured.body.workflow.automations
        .map((automation) => {
          return automation.id;
        })
        .sort(),
    ).toStrictEqual([...automationIds].sort());
    expect(
      reconfigured.body.workflow.automations.every((automation) => {
        return (
          automation.chatThreadId === automationThreadById.get(automation.id)
        );
      }),
    ).toBeTruthy();
    expect(
      reconfigured.body.workflow.automations.every((automation) => {
        return automation.id === dailyAutomation.id || automation.enabled;
      }),
    ).toBeTruthy();

    await accept(
      automationClient().enable({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, dailyAutomation.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      enabled: true,
      officialResultEmailEnabled: true,
    });
  });

  it("copies active installations and compensates rejected storage writes", async () => {
    const { actor, dailyAutomation, definitionName, headers, installed } =
      await installOfficialWorkflowLifecycleScenario();
    const firstWorkflowId = installed.body.workflow.id;
    await accept(
      automationClient().disable({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [200],
    );
    await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [{ key: "cron-expression", value: "0 9 * * *" }],
            },
          ],
        },
      }),
      [200],
    );

    const { agentId: activeCopyAgentId } = await workflowBdd.createAgent(actor);
    let activeCopyAgentDeleted = false;
    onTestFinished(async () => {
      if (!activeCopyAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, activeCopyAgentId);
      }
    });
    installCatalogStorageFixture();
    const activeCopy = await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: activeCopyAgentId },
      }),
      [201],
    );
    expect(activeCopy.body).toMatchObject({
      agentId: activeCopyAgentId,
      name: definitionName,
      visibility: "private",
      official: null,
    });
    const activeCopyDetail = await accept(
      workflowClient().get({
        headers,
        params: { workflowId: activeCopy.body.id },
      }),
      [200],
    );
    expect(activeCopyDetail.body).toMatchObject({
      instruction: "Execute only the accepted Definition content.",
      fileContents: [{ path: "references/context.md", content: "accepted\n" }],
      canManage: true,
      canPublish: true,
      official: null,
    });
    expect(activeCopyDetail.body.automations).toHaveLength(3);
    expect(
      activeCopyDetail.body.automations.every((automation) => {
        return automation.official === null;
      }),
    ).toBeTruthy();
    const activeCopiedDaily = activeCopyDetail.body.automations.find(
      (automation) => {
        return (
          automation.kind === "schedule" && automation.schedule.type === "cron"
        );
      },
    );
    expect(activeCopiedDaily).toMatchObject({
      enabled: false,
      schedule: { cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" },
      official: null,
    });
    if (!activeCopiedDaily) {
      throw new Error("Expected an ordinary copied daily automation");
    }
    await expect(
      readWorkflowAutomationAutonomyFixture(context, activeCopiedDaily.id),
    ).resolves.toMatchObject({
      autonomyBudget: 4,
      officialBlueprintKey: null,
      officialResultEmailEnabled: null,
    });
    await bdd.deleteAgent(actor, activeCopyAgentId);
    activeCopyAgentDeleted = true;

    const { agentId: failedCopyAgentId } = await workflowBdd.createAgent(actor);
    let failedCopyAgentDeleted = false;
    onTestFinished(async () => {
      if (!failedCopyAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, failedCopyAgentId);
      }
    });
    const failingCopyStorage = installCatalogStorageFixture();
    failingCopyStorage.failNextWrite(new Error("copy archive upload failed"));
    await expect(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: failedCopyAgentId },
      }),
    ).rejects.toThrow("Unknown response status 500");
    expect(failingCopyStorage.objectCount()).toBe(0);
    const failedCopyTargetWorkflows = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId: failedCopyAgentId },
      }),
      [200],
    );
    expect(failedCopyTargetWorkflows.body).toStrictEqual([]);
    await bdd.deleteAgent(actor, failedCopyAgentId);
    failedCopyAgentDeleted = true;
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

  it("publishes an Official copy only after its volume is durable and compensates a rejected upload", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-copy-publication-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [loopBlueprint()])]),
    );

    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
    });
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped copy actor");
    }
    await selectBuiltInDefaultModel(actor);
    const { agentId: sourceAgentId } = await workflowBdd.createAgent(actor);
    const { agentId: targetAgentId } = await workflowBdd.createAgent(actor);
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
              bindings: [{ key: "interval-seconds", value: 60 }],
            },
          ],
        },
      }),
      [201],
    );
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    onTestFinished(async () => {
      installCatalogStorageFixture();
      for (const agentId of [sourceAgentId, targetAgentId]) {
        const createdRuns = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        for (const run of createdRuns.runs) {
          await runs.requestCancelRun(actor, run.id, [200, 400]);
        }
      }
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, targetAgentId);
      await bdd.deleteAgent(actor, sourceAgentId);
      await cleanupCatalog();
    });

    const beforeRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      targetAgentId,
    );
    expect(beforeRunFamily).toStrictEqual({
      run_count: 0,
      callback_count: 0,
      runner_job_count: 0,
    });
    const storage = installCatalogStorageFixture();
    const objectsBeforeCopy = storage.objectCount();
    const heldUpload = storage.holdNextWrite();
    const copying = settle(
      workflowClient().copy({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: { toAgentId: targetAgentId },
      }),
      context.signal,
    );
    await heldUpload.started;
    expect(storage.objectCount()).toBe(objectsBeforeCopy + 1);

    // Both reads use independent route/database work while the copy
    // transaction is held in S3 publication. Neither the Workflow nor its
    // final enabled Automation may be observable from that transaction.
    const duringCopyWorkflows = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId: targetAgentId },
      }),
      [200],
    );
    expect(duringCopyWorkflows.body).toStrictEqual([]);
    const duringCopyAutomations = await accept(
      automationClient().listWorkspace({ headers }),
      [200],
    );
    expect(
      duringCopyAutomations.body.some((automation) => {
        return automation.workflow.agentId === targetAgentId;
      }),
    ).toBeFalsy();
    await expect(
      readAgentRunFamilyCountsFixture(context, targetAgentId),
    ).resolves.toStrictEqual(beforeRunFamily);

    // Poll only the otherwise-empty target Agent. A buggy committed copy would
    // expose and dispatch its due schedule here; the uncommitted target must
    // remain absent without touching the source Automation locks.
    const drained = await withMockNowForTest(now() + 120_000, async () => {
      return await accept(
        automationExecutionClient().executeForAgent({
          body: { agent_id: targetAgentId },
        }),
        [200],
      );
    });
    expect(drained.body).toStrictEqual({
      success: true,
      executed: 0,
      skipped: 0,
    });
    await expect(
      readAgentRunFamilyCountsFixture(context, targetAgentId),
    ).resolves.toStrictEqual(beforeRunFamily);

    heldUpload.reject(new Error("copy archive upload rejected"));
    const rejectedCopy = await copying;
    expect(rejectedCopy.ok).toBeFalsy();
    expect(storage.objectCount()).toBe(objectsBeforeCopy);
    const afterRejectedWorkflows = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId: targetAgentId },
      }),
      [200],
    );
    expect(afterRejectedWorkflows.body).toStrictEqual([]);
    await expect(
      readAgentRunFamilyCountsFixture(context, targetAgentId),
    ).resolves.toStrictEqual(beforeRunFamily);

    // If one concurrent PUT fails before its sibling completes, publication
    // must await the sibling before compensating. Otherwise a late successful
    // sibling could recreate an object after cleanup has already finished.
    const lateSiblingUpload = storage.holdNextWrite();
    storage.failNextWrite(new Error("copy manifest upload failed"));
    let lateSiblingCopySettled = false;
    const lateSiblingCopy = settle(
      workflowClient().copy({
        headers,
        params: { workflowId: installed.body.workflow.id },
        body: { toAgentId: targetAgentId },
      }),
      context.signal,
    ).then((result) => {
      lateSiblingCopySettled = true;
      return result;
    });
    await lateSiblingUpload.started;
    const duringLateSiblingWorkflows = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId: targetAgentId },
      }),
      [200],
    );
    expect(duringLateSiblingWorkflows.body).toStrictEqual([]);
    expect(lateSiblingCopySettled).toBeFalsy();
    lateSiblingUpload.resolve();
    const rejectedLateSiblingCopy = await lateSiblingCopy;
    expect(rejectedLateSiblingCopy.ok).toBeFalsy();
    expect(storage.objectCount()).toBe(objectsBeforeCopy);
    await expect(
      readAgentRunFamilyCountsFixture(context, targetAgentId),
    ).resolves.toStrictEqual(beforeRunFamily);
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
      await selectBuiltInDefaultModel(actor);
      const { agentId: sourceAgentId } = await workflowBdd.createAgent(actor);
      const { agentId: targetAgentId } = await workflowBdd.createAgent(actor);
      const pending: {
        copying?: Promise<unknown>;
        releaseCopy?: () => void;
        independentThreadId?: string;
      } = {};
      onTestFinished(async () => {
        pending.releaseCopy?.();
        await pending.copying;
        if (pending.independentThreadId) {
          await chat.deleteThread(actor, pending.independentThreadId);
        }
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, targetAgentId);
        await bdd.deleteAgent(actor, sourceAgentId);
        await cleanupCatalog();
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
      pending.independentThreadId = independentThread.id;
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
      onTestFinished(async () => {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });
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
      let agentDeleted = false;
      onTestFinished(async () => {
        if (!agentDeleted) {
          installCatalogStorageFixture();
          await bdd.deleteAgent(actor, agentId);
        }
        await cleanupCatalog();
      });
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
      agentDeleted = true;
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
      onTestFinished(async () => {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
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
      onTestFinished(async () => {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });
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
      const pending = await readOfficialWorkflowReconciliationState({
        definitionName,
        workflowId,
      });
      expect(pending.body.reconciliationWork).toMatchObject([
        { definitionName, cursorWorkflowId: null, state: "pending" },
      ]);
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

  describe("permanent Blueprint identity through reconciliation recovery", () => {
    async function prepareEmptyInstallation() {
      installCatalogStorageFixture();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-identity-${suffix}`;
      await syncCatalog(catalog([activeDefinition(definitionName, [])]));
      const setup = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      const { actor } = setup;
      const { agentId } = await workflowBdd.createAgent(actor);
      onTestFinished(async () => {
        installCatalogStorageFixture();
        const createdRuns = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        for (const run of createdRuns.runs) {
          await runs.requestCancelRun(actor, run.id, [200, 400]);
        }
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });
      await setOfficialWorkflowsEnabled(actor, true);
      const headers = authHeaders(actor);
      const installed = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: { agentId, blueprints: [] },
        }),
        [201],
      );
      const workflowId = installed.body.workflow.id;

      return { definitionName, actor, agentId, headers, workflowId };
    }

    let prepared: Awaited<ReturnType<typeof prepareEmptyInstallation>>;
    beforeEach(async () => {
      prepared = await prepareEmptyInstallation();
    });

    it("recovers superseded and crashed work while preserving permanent Blueprint identity", async () => {
      const { definitionName, actor, headers, workflowId } = prepared;
      const firstAddition = await syncCatalog(
        catalog([activeDefinition(definitionName, [scheduledBlueprint()])]),
      );
      const firstRequestedReleaseId = firstAddition.body.releaseId;
      const duplicate = await syncCatalog(
        catalog([activeDefinition(definitionName, [scheduledBlueprint()])]),
      );
      expect(duplicate.body).toMatchObject({
        outcome: "unchanged",
        releaseId: firstRequestedReleaseId,
      });

      const supersedingBlueprint: OfficialWorkflowBlueprint = {
        ...scheduledBlueprint(),
        desiredState: {
          ...scheduledBlueprint().desiredState,
          autonomyBudget: 5,
        },
      };
      const superseding = await syncCatalog(
        catalog([activeDefinition(definitionName, [supersedingBlueprint])]),
      );
      expect(superseding.body.releaseId).not.toBe(firstRequestedReleaseId);
      const supersededState = await readOfficialWorkflowReconciliationState({});
      expect(supersededState.body.reconciliationWork).toMatchObject([
        {
          definitionName,
          requestedReleaseId: superseding.body.releaseId,
          cursorWorkflowId: null,
          state: "pending",
          attemptCount: 0,
        },
      ]);

      await simulateOfficialWorkflowReconciliationWorkerCrash(definitionName);
      const crashedState = await readOfficialWorkflowReconciliationState({});
      expect(crashedState.body.reconciliationWork).toMatchObject([
        { definitionName, state: "running", leaseId: expect.any(String) },
      ]);
      const concurrent = await Promise.all([
        runOfficialWorkflowReconciliationWorker(),
        runOfficialWorkflowReconciliationWorker(),
      ]);
      expect(
        concurrent.reduce((sum, result) => {
          return sum + result.claimed;
        }, 0),
      ).toBe(1);
      expect(
        concurrent.reduce((sum, result) => {
          return sum + result.completed;
        }, 0),
      ).toBe(1);
      expect(
        concurrent.reduce((sum, result) => {
          return sum + result.installations;
        }, 0),
      ).toBe(1);
      await expect(
        runOfficialWorkflowReconciliationWorker(),
      ).resolves.toStrictEqual({
        claimed: 0,
        completed: 0,
        advanced: 0,
        retried: 0,
        installations: 0,
      });

      const added = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(added.body.workflow.automations).toHaveLength(1);
      const addedAutomation = added.body.workflow.automations[0];
      if (!addedAutomation?.official) {
        throw new Error("Expected reconciled added Official Automation");
      }
      expect(addedAutomation).toMatchObject({
        enabled: false,
        official: {
          intendedEnabled: false,
          reconciliationStatus: "current",
        },
      });
      const addedIdentity = await readOfficialWorkflowReconciliationState({
        workflowId,
      });
      expect(addedIdentity.body.identities).toStrictEqual([
        expect.objectContaining({
          id: addedAutomation.id,
          automationId: addedAutomation.id,
          blueprintKey: "daily",
          state: "active",
        }),
      ]);

      await setOfficialWorkflowsEnabled(actor, false);
      await accept(
        automationClient().enable({
          headers,
          params: { id: addedAutomation.id },
        }),
        [200],
      );
      runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      const historical = await accept(
        automationClient().run({
          headers,
          params: { id: addedAutomation.id },
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

      await syncCatalog(catalog([activeDefinition(definitionName, [])]));
      await runOfficialWorkflowReconciliationWorker();
      const removed = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(removed.body.workflow.automations).toStrictEqual([]);
      const removedIdentity = await readOfficialWorkflowReconciliationState({
        workflowId,
      });
      expect(removedIdentity.body.identities).toStrictEqual([
        expect.objectContaining({
          id: addedAutomation.id,
          automationId: null,
          blueprintKey: "daily",
          state: "removed",
          retainedIntendedEnabled: true,
        }),
      ]);
      await expect(
        readOfficialWorkflowRunStateFixture(context, historicalRunId),
      ).resolves.toMatchObject({
        provenance: {
          definitions: [expect.objectContaining({ name: definitionName })],
        },
      });

      await syncCatalog(
        catalog([activeDefinition(definitionName, [supersedingBlueprint])]),
      );
      await Promise.all([
        runOfficialWorkflowReconciliationWorker(),
        runOfficialWorkflowReconciliationWorker(),
      ]);
      const restored = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(restored.body.workflow.automations).toHaveLength(1);
      expect(restored.body.workflow.automations[0]).toMatchObject({
        id: addedAutomation.id,
        chatThreadId: historical.body.chatThreadId,
        enabled: true,
        official: {
          intendedEnabled: true,
          reconciliationStatus: "current",
        },
      });
      await expect(
        readOfficialWorkflowRunStateFixture(context, historicalRunId),
      ).resolves.toMatchObject({
        provenance: {
          definitions: [expect.objectContaining({ name: definitionName })],
        },
      });

      await syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            {
              ...supersedingBlueprint,
              desiredState: {
                ...supersedingBlueprint.desiredState,
                autonomyBudget: 9,
              },
            },
          ]),
        ]),
      );
      const pendingAtRetirement = await readOfficialWorkflowReconciliationState(
        {},
      );
      expect(pendingAtRetirement.body.reconciliationWork).toMatchObject([
        { definitionName, state: "pending" },
      ]);
      await syncCatalog(catalog([retiredDefinition(definitionName)]));
      const retired = await readOfficialWorkflowReconciliationState({});
      expect(retired.body.reconciliationWork).toStrictEqual([]);
      const whileRetired = await accept(
        installationClient().get({ headers, params: { workflowId } }),
        [200],
      );
      expect(whileRetired.body.workflow.automations[0]).toMatchObject({
        id: addedAutomation.id,
        enabled: true,
        official: { reconciliationStatus: "current" },
      });

      const reactivatedBlueprint: OfficialWorkflowBlueprint = {
        ...supersedingBlueprint,
        desiredState: {
          ...supersedingBlueprint.desiredState,
          autonomyBudget: 8,
        },
      };
      await syncCatalog(
        catalog([activeDefinition(definitionName, [reactivatedBlueprint])]),
      );
      const reactivation = await readOfficialWorkflowReconciliationState({});
      expect(reactivation.body.reconciliationWork).toMatchObject([
        { definitionName, state: "pending" },
      ]);
      await runOfficialWorkflowReconciliationWorker();
      await expect(
        readWorkflowAutomationAutonomyFixture(context, addedAutomation.id),
      ).resolves.toMatchObject({ autonomyBudget: 8, enabled: true });
    });
  });

  describe.each([
    "dormant materialization",
    "current lifecycle gap",
    "discarded materialization",
  ] as const)(
    "repairs %s without duplicating identity, watch, or history",
    (phase) => {
      async function prepareScenario() {
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
          const createdRuns = await runs.listAgentRuns(actor, {
            agent: agentId,
            limit: 100,
          });
          for (const run of createdRuns.runs) {
            await runs.requestCancelRun(actor, run.id, [200, 400]);
          }
          await flushWaitUntilForTest();
          await bdd.deleteAgent(actor, agentId);
          await cleanupCatalog();
        });
        mockGmailConnectorOAuth({
          email: `materialize-${suffix}@example.test`,
        });
        await workflowBdd.connectConnector(actor, "gmail");
        mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
        let watchCalls = 0;
        let stopCalls = 0;
        server.use(
          http.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/watch",
            () => {
              watchCalls++;
              return HttpResponse.json({
                historyId: String(100 + watchCalls),
                expiration: "4102444800000",
              });
            },
          ),
          http.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/stop",
            () => {
              stopCalls++;
              return new HttpResponse(null, { status: 204 });
            },
          ),
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
        return {
          automation,
          headers,
          actor,
          definitionName,
          workflowId,
          agentId,
          get watchCalls() {
            return watchCalls;
          },
          set watchCalls(next: typeof watchCalls) {
            watchCalls = next;
          },
          get stopCalls() {
            return stopCalls;
          },
          set stopCalls(next: typeof stopCalls) {
            stopCalls = next;
          },
        };
      }
      let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
      beforeEach(async () => {
        preparedScenario = await prepareScenario();
      });
      it("preserves the complete scenario", async () => {
        const {
          automation,
          headers,
          actor,
          definitionName,
          workflowId,
          agentId,
        } = preparedScenario;
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

        await syncCatalog(catalog([activeDefinition(definitionName, [])]));
        await runOfficialWorkflowReconciliationWorker();
        const removedIdentity = await readOfficialWorkflowReconciliationState({
          workflowId,
        });
        expect(removedIdentity.body.identities).toStrictEqual([
          expect.objectContaining({
            id: automation.id,
            automationId: null,
            blueprintKey: "gmail-trigger",
            state: "removed",
            retainedIntendedEnabled: true,
          }),
        ]);

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
        const historyCounts = await readAgentRunFamilyCountsFixture(
          context,
          agentId,
        );

        if (phase === "dormant materialization") {
          await simulateDormantMaterializationCrash({
            definitionName,
            automationId: automation.id,
          });
          preparedScenario.watchCalls = 0;
          const crashed = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(crashed.body.workflow.automations).toHaveLength(1);
          expect(crashed.body.workflow.automations[0]).toMatchObject({
            id: automation.id,
            enabled: false,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "reconciling",
            },
          });
          const crashedWork = await readOfficialWorkflowReconciliationState({
            workflowId,
          });
          expect(crashedWork.body.reconciliationWork).toMatchObject([
            {
              definitionName,
              state: "running",
              leaseId: expect.any(String),
              attemptCount: 0,
            },
          ]);
          expect(crashedWork.body.identities).toStrictEqual([
            expect.objectContaining({
              id: automation.id,
              automationId: null,
              blueprintKey: "gmail-trigger",
              state: "reconciling",
              retainedIntendedEnabled: true,
              retainedAppliedFingerprint: expect.any(String),
            }),
          ]);

          const retried = await Promise.all([
            runOfficialWorkflowReconciliationWorker(),
            runOfficialWorkflowReconciliationWorker(),
          ]);
          expect(
            retried.reduce((sum, result) => {
              return sum + result.claimed;
            }, 0),
          ).toBe(1);
          expect(
            retried.reduce((sum, result) => {
              return sum + result.completed;
            }, 0),
          ).toBe(1);
          expect(
            retried.reduce((sum, result) => {
              return sum + result.installations;
            }, 0),
          ).toBe(1);

          const recovered = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(recovered.body.workflow.automations).toHaveLength(1);
          expect(recovered.body.workflow.automations[0]).toMatchObject({
            id: automation.id,
            chatThreadId: automation.chatThreadId,
            enabled: true,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "current",
            },
          });
          const recoveredIdentity =
            await readOfficialWorkflowReconciliationState({
              workflowId,
            });
          expect(recoveredIdentity.body.identities).toStrictEqual([
            expect.objectContaining({
              id: automation.id,
              automationId: automation.id,
              blueprintKey: "gmail-trigger",
              state: "active",
            }),
          ]);
          expect(preparedScenario.watchCalls).toBe(1);
          await expect(
            readAgentRunFamilyCountsFixture(context, agentId),
          ).resolves.toStrictEqual(historyCounts);
          await expect(
            readOfficialWorkflowRunStateFixture(context, historicalRunId),
          ).resolves.toMatchObject({
            provenance: {
              definitions: [expect.objectContaining({ name: definitionName })],
            },
          });
        } else if (phase === "current lifecycle gap") {
          await simulateCurrentLifecycleGap({
            definitionName,
            automationId: automation.id,
          });
          preparedScenario.watchCalls = 0;
          const currentGap = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(currentGap.body.workflow.automations).toHaveLength(1);
          expect(currentGap.body.workflow.automations[0]).toMatchObject({
            id: automation.id,
            enabled: false,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "current",
            },
          });
          await expect(
            runOfficialWorkflowReconciliationWorker(),
          ).resolves.toStrictEqual(
            expect.objectContaining({
              claimed: 1,
              completed: 1,
              installations: 1,
            }),
          );
          const currentGapRecovered = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(currentGapRecovered.body.workflow.automations).toHaveLength(1);
          expect(
            currentGapRecovered.body.workflow.automations[0],
          ).toMatchObject({
            id: automation.id,
            enabled: true,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "current",
            },
          });
          expect(preparedScenario.watchCalls).toBe(1);
          await expect(
            readAgentRunFamilyCountsFixture(context, agentId),
          ).resolves.toStrictEqual(historyCounts);
        } else {
          preparedScenario.watchCalls = 0;
          preparedScenario.stopCalls = 0;
          await simulateDormantMaterializationDiscardCrash({
            definitionName,
            automationId: automation.id,
          });
          const discardGap = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(discardGap.body.workflow.automations).toHaveLength(1);
          expect(discardGap.body.workflow.automations[0]).toMatchObject({
            id: automation.id,
            enabled: false,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "failed",
            },
          });
          await runOfficialWorkflowReconciliationWorker();
          const compensated = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(compensated.body.workflow.automations).toHaveLength(0);
          expect(preparedScenario.stopCalls).toBe(0);
          expect(preparedScenario.watchCalls).toBe(0);
          const compensatedState =
            await readOfficialWorkflowReconciliationState({
              workflowId,
            });
          expect(compensatedState.body.identities).toStrictEqual([
            expect.objectContaining({
              id: automation.id,
              automationId: null,
              blueprintKey: "gmail-trigger",
              state: "failed",
              retainedIntendedEnabled: true,
            }),
          ]);
          await makeOfficialWorkflowReconciliationWorkDue(definitionName);
          await expect(
            runOfficialWorkflowReconciliationWorker(),
          ).resolves.toStrictEqual(
            expect.objectContaining({
              claimed: 1,
              completed: 1,
              installations: 1,
            }),
          );
          const discardRecovered = await accept(
            installationClient().get({ headers, params: { workflowId } }),
            [200],
          );
          expect(discardRecovered.body.workflow.automations).toHaveLength(1);
          expect(discardRecovered.body.workflow.automations[0]).toMatchObject({
            id: automation.id,
            enabled: true,
            official: {
              intendedEnabled: true,
              reconciliationStatus: "current",
            },
          });
          expect(preparedScenario.watchCalls).toBe(1);
          await expect(
            readAgentRunFamilyCountsFixture(context, agentId),
          ).resolves.toStrictEqual(historyCounts);
          await expect(
            runOfficialWorkflowReconciliationWorker(),
          ).resolves.toStrictEqual({
            claimed: 0,
            completed: 0,
            advanced: 0,
            retried: 0,
            installations: 0,
          });
          expect(preparedScenario.watchCalls).toBe(1);
        }
      });
    },
  );

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
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
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
    const beforeRuns = await readAgentRunFamilyCountsFixture(context, agentId);

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
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);

    watch.watchShouldFail = false;
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
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
        official: expect.objectContaining({ reconciliationStatus: "current" }),
      }),
    ]);
    expect(watch.watchCalls).toBe(2);
    expect(watch.watchAccessTokens).toStrictEqual([
      `Bearer ${secondAccessToken}`,
      `Bearer ${secondAccessToken}`,
    ]);
    expect(watch.stopCalls).toBe(0);
    const identity = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(identity.body.identities).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        automationId: original.id,
        blueprintKey: "lifecycle-transition",
        state: "active",
      }),
    ]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);

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
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
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
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await runOfficialWorkflowReconciliationWorker();
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
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
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
    const historyCounts = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

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
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automationId),
    ).resolves.toMatchObject({ runId: historicalRunId });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(historyCounts);

    watchShouldFail = false;
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
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
        official: expect.objectContaining({ reconciliationStatus: "current" }),
      }),
    ]);
    expect(watchCalls).toBe(5);
    expect(stopCalls).toBe(0);
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automationId),
    ).resolves.toMatchObject({ runId: historicalRunId });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(historyCounts);
    const identity = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(identity.body.identities).toStrictEqual([
      expect.objectContaining({
        id: automationId,
        automationId,
        blueprintKey: "lifecycle-transition",
        state: "active",
      }),
    ]);
  });

  it("revalidates a prepared Stripe transition after the default account changes", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-stripe-binding-race-${suffix}`;
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
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      await resumeStructureTransitionPromotion();
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    await setOfficialWorkflowsEnabled(actor, true);
    await updateFeatureSwitchesForUser(
      context,
      { orgId: actor.orgId, userId: actor.userId },
      { [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true },
    );
    const connectorId = await connectStripeOAuthForOfficialWorkflow(actor, {
      accountId: "acct_official_before",
      code: `stripe-before-${suffix}`,
    });
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
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Stripe structure-transition Automation");
    }

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionStripeBlueprint(),
        ]),
      ]),
    );
    await pauseNextStructureTransitionPromotion();
    const olderWorker = runOfficialWorkflowReconciliationWorker();
    await waitForStructureTransitionPromotionPause();
    const reconnectedId = await connectStripeOAuthForOfficialWorkflow(actor, {
      accountId: "acct_official_after",
      code: `stripe-after-${suffix}`,
    });
    expect(reconnectedId).not.toBe(connectorId);
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      "stripe",
      connectorId,
    );
    await resumeStructureTransitionPromotion();
    await olderWorker;

    const rejected = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(rejected.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 3600 },
        enabled: false,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "reconciling",
        }),
      }),
    ]);

    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const converged = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(converged.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "event",
        eventType: "stripe-invoice-paid",
        eventConfig: expect.objectContaining({
          connectorId: reconnectedId,
          stripeAccountId: "acct_official_after",
          mode: "live",
        }),
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
  });

  it("revalidates a prepared Google Meet transition after the default account changes", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-meet-binding-race-${suffix}`;
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
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      await resumeStructureTransitionPromotion();
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    await setOfficialWorkflowsEnabled(actor, true);

    const firstAccountSpec = {
      code: `meet-race-first-${suffix}`,
      accessToken: `meet-race-first-token-${suffix}`,
      externalId: `meet-race-first-user-${suffix}`,
      email: `meet-race-first-${suffix}@example.test`,
    } as const;
    const secondAccountSpec = {
      code: `meet-race-second-${suffix}`,
      accessToken: `meet-race-second-token-${suffix}`,
      externalId: `meet-race-second-user-${suffix}`,
      email: `meet-race-second-${suffix}@example.test`,
    } as const;
    const meet = configureOfficialGoogleMeetMultiAccountMock([
      firstAccountSpec,
      secondAccountSpec,
    ]);

    const firstOauth = await connectors.startOauth(
      actor,
      "google-meet",
      "oauth",
      agentId,
    );
    const firstState = new URL(firstOauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected first Google Meet OAuth state");
    }
    await connectors.completeOauthCallback("google-meet", {
      code: firstAccountSpec.code,
      state: firstState,
    });
    const secondOauth = await connectors.startOauth(
      actor,
      "google-meet",
      "oauth",
      agentId,
      { intent: "add", displayName: "Official Meet Second" },
    );
    const secondState = new URL(secondOauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected second Google Meet OAuth state");
    }
    await connectors.completeOauthCallback("google-meet", {
      code: secondAccountSpec.code,
      state: secondState,
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-meet",
    );
    const firstAccount = accounts.find((account) => {
      return account.externalId === firstAccountSpec.externalId;
    });
    const secondAccount = accounts.find((account) => {
      return account.externalId === secondAccountSpec.externalId;
    });
    if (!firstAccount || !secondAccount) {
      throw new Error("Expected both Google Meet accounts");
    }
    expect(firstAccount.isDefault).toBeTruthy();
    expect(secondAccount.isDefault).toBeFalsy();

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
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Google Meet structure-transition Automation");
    }

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGoogleMeetBlueprint(),
        ]),
      ]),
    );
    await pauseNextStructureTransitionPromotion();
    const olderWorker = runOfficialWorkflowReconciliationWorker();
    await waitForStructureTransitionPromotionPause();
    await onRejection(
      connectors.setDefaultBuiltinConnectorAccount(
        actor,
        "google-meet",
        secondAccount.id,
      ),
      resumeStructureTransitionPromotion,
    );
    await resumeStructureTransitionPromotion();
    await olderWorker;

    const rejected = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(rejected.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 3600 },
        enabled: false,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "reconciling",
        }),
      }),
    ]);

    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const converged = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(converged.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "event",
        eventType: "google-meet-transcript-generated",
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.id),
    ).resolves.toMatchObject({
      enabled: true,
      eventConnectorId: secondAccount.id,
    });
    expect(meet.createAccessTokens).toStrictEqual([
      `Bearer ${firstAccountSpec.accessToken}`,
      `Bearer ${secondAccountSpec.accessToken}`,
    ]);
    expect(meet.deleteAccessTokens).toStrictEqual([
      `Bearer ${firstAccountSpec.accessToken}`,
    ]);
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
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
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
    const retryState = await readOfficialWorkflowReconciliationState({});
    expect(retryState.body.reconciliationWork).toMatchObject([
      {
        definitionName,
        state: "pending",
        attemptCount: 1,
        lastError: expect.stringContaining("watch"),
      },
    ]);

    watchShouldFail = false;
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
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
  it("pins exact active and retained-retired artifacts without org shadowing", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const firstName = `api-test-run-a-${suffix}`;
    const secondName = `api-test-run-b-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(firstName, [], "accepted first revision"),
        activeDefinition(secondName, [], "accepted retained revision"),
      ]),
    );

    const setup = await workflowBdd.setupWorkflowOrg({
      model: "claude-fable-5-1",
    });
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId,
      name: firstName,
      visibility: "public",
    });
    const firstInstallation = await accept(
      officialClient().install({
        headers,
        params: { definitionName: firstName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    await accept(
      officialClient().install({
        headers,
        params: { definitionName: secondName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });

    const firstAccepted = await readAcceptedDefinitionFixture(firstName);
    const secondAccepted = await readAcceptedDefinitionFixture(secondName);
    const shadowStorageId = randomUUID();
    const shadowVersion = "e".repeat(64);
    await accept(
      storageClient().action({
        body: {
          action: "claim-owned-storages",
          storages: [
            {
              storage_id: shadowStorageId,
              org_id: actor.orgId,
              user_id: VOLUME_ORG_USER_ID,
              storage_name: firstAccepted.definition.artifact.storageName,
              s3_prefix: `official-shadow/${shadowStorageId}`,
            },
          ],
        },
      }),
      [200],
    );
    await accept(
      storageClient().action({
        body: {
          action: "seed-owned-storage-version",
          storage_id: shadowStorageId,
          version_id: shadowVersion,
          s3_key: `official-shadow/${shadowStorageId}/${shadowVersion}`,
          archive_size: 1,
        },
      }),
      [200],
    );
    onTestFinished(async () => {
      await accept(
        storageClient().action({
          body: {
            action: "cleanup-owned-storages",
            storage_ids: [shadowStorageId],
          },
        }),
        [200],
      );
    });

    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.heartbeatRunner(runnerGroup);
    await setOfficialWorkflowsEnabled(actor, false);
    const direct = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: firstInstallation.body.workflow.id },
      }),
      [200],
    );
    expect(direct.body.runId).toBeNull();
    const firstRunId = await launchedAutomationRunId(
      actor,
      direct.body.chatThreadId,
    );
    if (!firstRunId) {
      throw new Error("Expected direct Official Workflow Run");
    }

    await syncCatalog(
      catalog([
        activeDefinition(firstName, [], "accepted second revision"),
        retiredDefinition(secondName),
      ]),
    );
    const nextFirstAccepted = await readAcceptedDefinitionFixture(firstName);
    expect(nextFirstAccepted.definition.revision).not.toBe(
      firstAccepted.definition.revision,
    );

    const firstClaim = await runs.claimRunnerJob(firstRunId);
    if (
      !firstClaim.storageManifest ||
      !("storageMounts" in firstClaim.storageManifest)
    ) {
      throw new Error("Expected canonical Run storage manifest");
    }
    expect(firstClaim.storageManifest.storageMounts).toStrictEqual(
      expect.arrayContaining(
        [firstAccepted.definition, secondAccepted.definition].map(
          (definition) => {
            return expect.objectContaining({
              storageId: definition.artifact.storageId,
              versionId: definition.artifact.storageVersion,
            });
          },
        ),
      ),
    );
    expect(firstClaim.storageManifest.storageMounts).not.toContainEqual(
      expect.objectContaining({ storageId: shadowStorageId }),
    );

    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );

    const later = await runs.createThreadRun(actor, {
      agentId,
      prompt: "resolve the newly accepted Official Definition revision",
    });
    const laterClaim = await runs.claimRunnerJob(later.runId);
    const laterManifest = laterClaim.storageManifest;
    if (!laterManifest || !("storageMounts" in laterManifest)) {
      throw new Error("Expected current Official storage mounts");
    }
    expect(laterManifest.storageMounts).toStrictEqual(
      expect.arrayContaining(
        [nextFirstAccepted.definition, secondAccepted.definition].map(
          (definition) => {
            return expect.objectContaining({
              storageId: definition.artifact.storageId,
              versionId: definition.artifact.storageVersion,
            });
          },
        ),
      ),
    );
    await runs.requestCancelRun(actor, later.runId, [200, 400]);
    expect(ordinaryWorkflowId).not.toBe(firstInstallation.body.workflow.id);
  });

  describe.each(["explicit and scheduled", "once", "webhook"])(
    "routes enabled result email through %s Official admission",
    (producerKind) => {
      async function prepareProducerInstallation() {
        installCatalogStorageFixture();
        mockEnv("OKOU_WEB_URL", "https://api.okou.ai");
        const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
        const definitionName = `api-test-producers-${suffix}`;
        await syncCatalog(
          catalog([
            activeDefinition(definitionName, [
              loopBlueprint(true),
              onceBlueprint(true),
              webhookBlueprint(true),
            ]),
          ]),
        );
        const setup = await workflowBdd.setupWorkflowOrg({
          timezone: "Asia/Shanghai",
          tier: "team",
          model: "claude-fable-5-1",
        });
        const { actor } = setup;
        if (!actor.orgId) {
          throw new Error("Expected organization-scoped actor");
        }
        await selectBuiltInDefaultModel(actor);
        const { agentId } = await workflowBdd.createAgent(actor);
        const headers = authHeaders(actor);
        configureResultEmailRecipient(actor);
        await setOfficialWorkflowsEnabled(actor, true);
        const atTime = new Date(now() + 60_000).toISOString();
        const installed = await accept(
          officialClient().install({
            headers,
            params: { definitionName },
            body: {
              agentId,
              blueprints: [
                {
                  blueprintKey: "pulse",
                  bindings: [{ key: "interval-seconds", value: 60 }],
                },
                {
                  blueprintKey: "one-shot",
                  bindings: [
                    { key: "at-time", value: atTime },
                    {
                      key: "callback-url",
                      value: "https://example.test/official-callback",
                    },
                    { key: "correlation-id", value: randomUUID() },
                  ],
                },
                { blueprintKey: "webhook-trigger", bindings: [] },
              ],
            },
          }),
          [201],
        );
        onTestFinished(async () => {
          installCatalogStorageFixture();
          await bdd.deleteAgent(actor, agentId);
          await cleanupCatalog();
        });
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();

        const automations = new Map(
          installed.body.workflow.automations.flatMap((automation) => {
            return automation.official
              ? [[automation.official.blueprintKey, automation] as const]
              : [];
          }),
        );
        const loopAutomation = automations.get("pulse");
        const onceAutomation = automations.get("one-shot");
        const webhookAutomation = automations.get("webhook-trigger");
        if (!loopAutomation || !onceAutomation || !webhookAutomation) {
          throw new Error(
            "Expected all Official Workflow producer automations",
          );
        }
        return {
          definitionName,
          actor,
          agentId,
          headers,
          atTime,
          installed,
          runnerGroup,
          loopAutomation,
          onceAutomation,
          webhookAutomation,
        };
      }

      let prepared: Awaited<ReturnType<typeof prepareProducerInstallation>>;
      beforeEach(async () => {
        prepared = await prepareProducerInstallation();
      });

      it("preserves result email and immutable admission provenance", async () => {
        const {
          definitionName,
          actor,
          agentId,
          headers,
          runnerGroup,
          loopAutomation,
          onceAutomation,
          webhookAutomation,
        } = prepared;
        const producerRuns: {
          readonly runId: string;
          readonly automationId: string;
        }[] = [];
        if (producerKind === "explicit and scheduled") {
          const explicit = await accept(
            automationClient().run({
              headers,
              extraHeaders: { origin: "https://app.okou.ai" },
              params: { id: loopAutomation.id },
            }),
            [201],
          );
          const explicitRunId = await launchedAutomationRunId(
            actor,
            explicit.body.chatThreadId,
          );
          if (!explicitRunId) {
            throw new Error("Expected explicit Official Automation Run");
          }
          producerRuns.push({
            runId: explicitRunId,
            automationId: loopAutomation.id,
          });
          await completeSuccessfulRun(
            runnerGroup,
            explicitRunId,
            "Explicit Official result",
          );

          const scheduled = await withMockNowForTest(
            now() + 120_000,
            async () => {
              const tick = await accept(
                automationExecutionClient().execute({
                  body: { automation_id: loopAutomation.id },
                }),
                [200],
              );
              // The tick only enqueues; its background pick launches the run.
              await flushWaitUntilForTest();
              return tick;
            },
          );
          expect(scheduled.body.executed).toBe(1);
          const scheduledRunId = await requireActiveOfficialRunId(
            actor,
            agentId,
          );
          expect(scheduledRunId).not.toBe(explicitRunId);
          producerRuns.push({
            runId: scheduledRunId,
            automationId: loopAutomation.id,
          });
          await completeSuccessfulRun(
            runnerGroup,
            scheduledRunId,
            "Scheduled Official result",
          );
        }

        if (producerKind === "once") {
          const once = await withMockNowForTest(now() + 120_000, async () => {
            const tick = await accept(
              automationExecutionClient().execute({
                body: { automation_id: onceAutomation.id },
              }),
              [200],
            );
            await flushWaitUntilForTest();
            return tick;
          });
          expect(once.body.executed).toBe(1);
          const onceRunId = await requireActiveOfficialRunId(actor, agentId);
          producerRuns.push({
            runId: onceRunId,
            automationId: onceAutomation.id,
          });
          await completeSuccessfulRun(
            runnerGroup,
            onceRunId,
            "Once Official result",
          );
        }

        if (producerKind === "webhook") {
          if (
            webhookAutomation.kind !== "event" ||
            webhookAutomation.eventType !== "webhook-received"
          ) {
            throw new Error("Expected Official webhook automation");
          }
          const webhookCredentials = await accept(
            automationClient().revealWebhookSecret({
              headers,
              params: { id: webhookAutomation.id },
              body: undefined,
            }),
            [200],
          );
          const webhook = await postOfficialWorkflowWebhook({
            webhookUrl: webhookCredentials.body.webhookUrl,
            secret: webhookCredentials.body.webhookSecret,
            body: JSON.stringify({ event: "official-p2-regression" }),
          });
          expect(webhook).toMatchObject({
            status: 200,
            body: { success: true, duplicate: false },
          });
          // Webhook acceptance schedules admission in waitUntil.
          await flushWaitUntilForTest();
          const webhookRunId = await requireActiveOfficialRunId(actor, agentId);
          producerRuns.push({
            runId: webhookRunId,
            automationId: webhookAutomation.id,
          });
          await completeSuccessfulRun(
            runnerGroup,
            webhookRunId,
            "Event Official result",
          );
        }

        for (const producer of producerRuns) {
          const source = await outbox.findSourceState({
            sourceRunId: producer.runId,
            sourceWorkflowAutomationId: producer.automationId,
          });
          expect(source.claim).not.toBeNull();
          expect(source.items).toStrictEqual([
            expect.objectContaining({
              subject: `Display ${definitionName}`,
              source_run_id: producer.runId,
              source_workflow_automation_id: producer.automationId,
              status: "pending",
              template: expect.objectContaining({
                template: "official-automation-result",
              }),
            }),
          ]);
        }
      });
    },
  );

  it("uses Okou email brand for session and agent-token launches across Official result callback retry", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-brand",
      true,
    );
    const sessionRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    const sessionRunId = await launchedAutomationRunId(
      scenario.actor,
      sessionRun.body.chatThreadId,
    );
    if (!sessionRunId) {
      throw new Error("Expected session Official Automation Run");
    }
    await completeSuccessfulRun(
      scenario.runnerGroup,
      sessionRunId,
      "Session-brand result",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: sessionRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toMatchObject({
      items: [{ source_run_id: sessionRunId }],
      claim: { source_run_id: sessionRunId },
    });

    const agentToken = runs.okouTokenForRunWithCapabilities(
      scenario.actor,
      sessionRunId,
      ["agent:write"],
    );
    const agentRun = await accept(
      automationClient().run({
        headers: { authorization: `Bearer ${agentToken}` },
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    const agentRunId = await launchedAutomationRunId(
      scenario.actor,
      agentRun.body.chatThreadId,
    );
    if (!agentRunId) {
      throw new Error("Expected agent-token Official Automation Run");
    }

    mockEnv("RESEND_FROM_DOMAIN", undefined);
    await completeSuccessfulRun(
      scenario.runnerGroup,
      agentRunId,
      "Agent-token retry result",
    );
    expect((await runs.readRun(scenario.actor, agentRunId)).status).toBe(
      "completed",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: agentRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });

    mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
    const redrive = await accept(
      automationExecutionClient().dispatchCallbacks({
        body: {
          run_id: agentRunId,
          status: "completed",
          dispatch_count: 8,
        },
      }),
      [200],
    );
    expect(redrive.body.successful_callbacks).toBeGreaterThan(0);
    const source = await outbox.findSourceState({
      sourceRunId: agentRunId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(source.claim).not.toBeNull();
    expect(source.items).toStrictEqual([
      expect.objectContaining({
        source_run_id: agentRunId,
        source_workflow_automation_id: scenario.automation.id,
      }),
    ]);
  });

  it("uses the immutable launch snapshot across Official result-email reconfiguration", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-reconfigure",
      true,
    );
    const enabledRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    const enabledRunId = await launchedAutomationRunId(
      scenario.actor,
      enabledRun.body.chatThreadId,
    );
    if (!enabledRunId) {
      throw new Error("Expected enabled-at-launch Official Automation Run");
    }

    await syncCatalog(
      catalog([
        activeDefinition(scenario.definitionName, [loopBlueprint(false)]),
      ]),
    );
    await accept(
      installationClient().reconfigure({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
        body: {
          blueprints: [{ blueprintKey: "pulse", bindings: [] }],
        },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, scenario.automation.id),
    ).resolves.toMatchObject({ officialResultEmailEnabled: false });
    await completeSuccessfulRun(
      scenario.runnerGroup,
      enabledRunId,
      "Enabled launch survives disablement",
    );
    const enabledSource = await outbox.findSourceState({
      sourceRunId: enabledRunId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(enabledSource.claim).not.toBeNull();
    expect(enabledSource.items).toStrictEqual([
      expect.objectContaining({
        source_workflow_automation_id: scenario.automation.id,
      }),
    ]);

    const disabledRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    const disabledRunId = await launchedAutomationRunId(
      scenario.actor,
      disabledRun.body.chatThreadId,
    );
    if (!disabledRunId) {
      throw new Error("Expected disabled-at-launch Official Automation Run");
    }
    await syncCatalog(
      catalog([
        activeDefinition(scenario.definitionName, [loopBlueprint(true)]),
      ]),
    );
    await accept(
      installationClient().reconfigure({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
        body: {
          blueprints: [{ blueprintKey: "pulse", bindings: [] }],
        },
      }),
      [200],
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, scenario.automation.id),
    ).resolves.toMatchObject({ officialResultEmailEnabled: true });
    await completeSuccessfulRun(
      scenario.runnerGroup,
      disabledRunId,
      "Disabled launch stays ineligible",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: disabledRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });
  });

  it("retains the Official result source through uninstall, TTL cleanup, and concurrent redrive", async () => {
    const scenario = await installResultEmailLoopScenario(
      "api-test-result-uninstall",
      true,
    );
    const launched = await accept(
      automationClient().run({
        headers: scenario.headers,
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    const launchedRunId = await launchedAutomationRunId(
      scenario.actor,
      launched.body.chatThreadId,
    );
    if (!launchedRunId) {
      throw new Error("Expected pre-uninstall Official Automation Run");
    }

    await accept(
      installationClient().uninstall({
        headers: scenario.headers,
        params: { workflowId: scenario.installed.body.workflow.id },
      }),
      [204],
    );
    await completeSuccessfulRun(
      scenario.runnerGroup,
      launchedRunId,
      "Post-uninstall result",
    );
    expect((await runs.readRun(scenario.actor, launchedRunId)).status).toBe(
      "completed",
    );
    const beforeCleanup = await outbox.findSourceState({
      sourceRunId: launchedRunId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    const originalItem = beforeCleanup.items[0];
    if (!beforeCleanup.claim || !originalItem) {
      throw new Error("Expected post-uninstall Official result source");
    }

    await withMockNowForTest(now() + 16 * 60 * 1000, async () => {
      await expect(outbox.cleanupExpiredItems([originalItem.id])).resolves.toBe(
        1,
      );
    });
    await expect(
      outbox.findSourceState({
        sourceRunId: launchedRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: beforeCleanup.claim });

    const redrives = await Promise.all(
      Array.from({ length: 8 }, async () => {
        return await accept(
          automationExecutionClient().interruptResultEmailCallback({
            body: { run_id: launchedRunId },
          }),
          [200],
        );
      }),
    );
    expect(
      redrives.every((response) => {
        return response.body.skipped;
      }),
    ).toBeTruthy();
    await expect(
      outbox.findSourceState({
        sourceRunId: launchedRunId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: beforeCleanup.claim });
  });

  it("reconciles a changed release at admission", async () => {
    const { actor, agentId, automation, definitionName, headers } =
      await installStaleAdmissionScenario();
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const beforeRunFamily = await runs
      .listAgentRuns(actor, {
        status: "queued,pending,running,completed,failed,timeout,cancelled",
        agent: agentId,
        limit: 100,
      })
      .then(({ runs }) => {
        return runs.length;
      });

    const changedBlueprint: OfficialWorkflowBlueprint = {
      ...loopBlueprint(),
      desiredState: {
        ...loopBlueprint().desiredState,
        autonomyBudget: 5,
      },
    };
    await syncCatalog(
      catalog([activeDefinition(definitionName, [changedBlueprint])]),
    );
    const reconciledRelease = await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [201],
    );
    const reconciledReleaseRunId = await launchedAutomationRunId(
      actor,
      reconciledRelease.body.chatThreadId,
    );
    if (!reconciledReleaseRunId) {
      throw new Error("Expected admission-time Blueprint reconciliation Run");
    }
    await expect(
      accept(
        automationClient().get({ headers, params: { id: automation.id } }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { enabled: true } });
    await completeSuccessfulRun(
      runnerGroup,
      reconciledReleaseRunId,
      "Reconciled release admission",
    );
    await expect(
      accept(
        automationClient().get({ headers, params: { id: automation.id } }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { enabled: true } });

    await expect(
      runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        }),
    ).resolves.toStrictEqual(beforeRunFamily + 1);
  });

  it("creates no Run-family rows for unresolved explicit, schedule, once, or webhook admission", async () => {
    installCatalogStorageFixture();
    mockEnv("OKOU_WEB_URL", "https://api.okou.ai");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-unresolved-producers-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          scheduledBlueprint(),
          loopBlueprint(),
          onceBlueprint(),
          webhookBlueprint(),
        ]),
      ]),
    );
    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
      model: "claude-fable-5-1",
    });
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const atTime = new Date(now() + 60_000).toISOString();
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [
            { blueprintKey: "daily", bindings: [] },
            {
              blueprintKey: "pulse",
              bindings: [{ key: "interval-seconds", value: 60 }],
            },
            {
              blueprintKey: "one-shot",
              bindings: [
                { key: "at-time", value: atTime },
                {
                  key: "callback-url",
                  value: "https://example.test/unresolved-callback",
                },
                { key: "correlation-id", value: randomUUID() },
              ],
            },
            { blueprintKey: "webhook-trigger", bindings: [] },
          ],
        },
      }),
      [201],
    );
    const automations = new Map(
      installed.body.workflow.automations.flatMap((automation) => {
        return automation.official
          ? [[automation.official.blueprintKey, automation] as const]
          : [];
      }),
    );
    const daily = automations.get("daily");
    const pulse = automations.get("pulse");
    const once = automations.get("one-shot");
    const webhookAutomation = automations.get("webhook-trigger");
    if (!daily || !pulse || !once || !webhookAutomation) {
      throw new Error("Expected every Official Automation producer fixture");
    }
    if (
      webhookAutomation.kind !== "event" ||
      webhookAutomation.eventType !== "webhook-received"
    ) {
      throw new Error("Expected Official webhook Automation");
    }
    const webhookCredentials = await accept(
      automationClient().revealWebhookSecret({
        headers,
        params: { id: webhookAutomation.id },
        body: undefined,
      }),
      [200],
    );
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          withUnresolvedRequiredBudget(scheduledBlueprint()),
          unresolvedLoopBlueprint(),
          withUnresolvedRequiredBudget(onceBlueprint()),
          withUnresolvedRequiredBudget(webhookBlueprint()),
        ]),
      ]),
    );
    await setOfficialWorkflowsEnabled(actor, false);
    const before = await runs
      .listAgentRuns(actor, {
        status: "queued,pending,running,completed,failed,timeout,cancelled",
        agent: agentId,
        limit: 100,
      })
      .then(({ runs }) => {
        return runs.length;
      });

    // Run now is accepted; the background pick rejects the unresolved
    // admission in the thread instead of launching a run.
    const explicit = await accept(
      automationClient().run({ headers, params: { id: pulse.id } }),
      [201],
    );
    expect(explicit.body.runId).toBeNull();
    await expect(
      launchedAutomationRunId(actor, explicit.body.chatThreadId),
    ).resolves.toBeUndefined();
    const { events: explicitEvents } = await chat.listThreadEvents(
      actor,
      explicit.body.chatThreadId,
    );
    expect(
      explicitEvents.filter((event) => {
        return event.eventType === "input.rejected";
      }),
    ).toStrictEqual([expect.objectContaining({ error: "conflict" })]);
    await expect(
      runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        }),
    ).resolves.toStrictEqual(before);

    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      await accept(
        automationExecutionClient().execute({
          body: { automation_id: daily.id },
        }),
        [200],
      );
      await flushWaitUntilForTest();
    });
    await expect(
      runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        }),
    ).resolves.toStrictEqual(before);

    await withMockNowForTest(now() + 120_000, async () => {
      await accept(
        automationExecutionClient().execute({
          body: { automation_id: once.id },
        }),
        [200],
      );
      await flushWaitUntilForTest();
    });
    await expect(
      runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        }),
    ).resolves.toStrictEqual(before);

    const webhook = await postOfficialWorkflowWebhook({
      webhookUrl: webhookCredentials.body.webhookUrl,
      secret: webhookCredentials.body.webhookSecret,
      body: JSON.stringify({ event: "unresolved-official-admission" }),
    });
    // The delivery is accepted; its launch rejection stays in the thread.
    expect(webhook).toMatchObject({
      status: 200,
      body: { success: true, duplicate: false },
    });
    await flushWaitUntilForTest();
    await expect(
      runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        }),
    ).resolves.toStrictEqual(before);
    const unresolved = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(
      unresolved.body.workflow.automations.every((automation) => {
        return (
          automation.enabled === false &&
          automation.official?.reconciliationStatus === "needs_reconfiguration"
        );
      }),
    ).toBeTruthy();
  });

  it("launches an idle Official agent-run input with the annotated source budget", async () => {
    const definitionName = `api-test-idle-official-${randomUUID()}`;
    const { actor } = await workflowBdd.setupWorkflowOrg({
      model: "claude-fable-5-1",
    });
    const { agentId } = await workflowBdd.createAgent(actor);
    installCatalogStorageFixture();
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
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
      const createdRuns = await runs.listAgentRuns(actor, {
        agent: agentId,
        limit: 100,
      });
      for (const run of createdRuns.runs) {
        await runs.requestCancelRun(actor, run.id, [200, 400]);
      }
      await flushWaitUntilForTest();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();

    const sourceThread = await chat.createThread(actor, { agentId });
    let { runId: sourceRunId } = await chat.sendAndLaunch(actor, {
      agentId,
      threadId: sourceThread.id,
      prompt: "source for idle Official launch",
    });
    let sourceThreadId = sourceThread.id;
    let sourceClaim = await runs.claimRunnerJob(sourceRunId);
    // Spend nine of the ten public delegation hops through real admission.
    // Each completed parent releases its slot before the next child is claimed.
    for (let hop = 0; hop < 9; hop += 1) {
      const child = await accept(
        workflowClient().run({
          headers: officialQueueHeaders(actor, sourceRunId, {
            origin: "agent_run",
          }),
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      await webhooks.requestAgentComplete(
        { runId: sourceRunId, exitCode: 1 },
        { authorization: `Bearer ${sourceClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const childRunId = await launchedAutomationRunId(
        actor,
        child.body.chatThreadId,
      );
      if (!childRunId || childRunId === sourceRunId) {
        throw new Error("Expected a distinct public delegation child");
      }
      sourceRunId = childRunId;
      sourceThreadId = child.body.chatThreadId;
      sourceClaim = await runs.claimRunnerJob(sourceRunId);
    }
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
      throw new Error("Expected the idle Official input to dispatch itself");
    }
    expect(launched.body.chatThreadId).not.toBe(sourceThread.id);
    const claim = await runs.claimRunnerJob(launchedRunId);
    expect(claim.prompt).toBe(`/${installation.body.workflow.name}`);
    expect(claim.appendSystemPrompt).toContain(`SOURCE_RUN_ID: ${sourceRunId}`);
    expect(claim.appendSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${sourceThreadId}`,
    );

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
    // The exhausted hop is rejected by the pick once the thread is idle.
    await webhooks.requestAgentComplete(
      { runId: launchedRunId, exitCode: 1 },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const rejections = (
      await chat.listThreadEventRows(actor, denied.body.chatThreadId)
    ).filter((event) => {
      return event.eventType === "input.rejected";
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      runId: null,
      payload: { error: "autonomy_budget_exhausted" },
    });
  });

  // Historical persisted-state exception (docs/testing.md rollout coexistence;
  // testing-external-behavior.md historical states): the canonical encoding is
  // only written by older APIs and is still read by
  // web-chat-queue-context.service.ts during the #29908 compatibility window.
  // Delete this case with that reader when the window closes.
  it.each([
    { encoding: "canonical", origin: "web", storedBrand: "okou" },
    { encoding: "legacy", origin: "agent_run", storedBrand: "okou" },
  ] as const)(
    "starts a queued Official source with its accepted revision and caller identity ($encoding $origin)",
    async (queueCase) => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-queued-success-${suffix}`;
      const { actor } = await workflowBdd.setupWorkflowOrg({
        model: "claude-fable-5-1",
      });
      const { agentId } = await workflowBdd.createAgent(actor);
      installCatalogStorageFixture();
      await syncCatalog(catalog([activeDefinition(definitionName, [])]));
      const accepted = await readAcceptedDefinitionFixture(definitionName);
      const headers = authHeaders(actor);
      await setOfficialWorkflowsEnabled(actor, true);
      const installation = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: { agentId, blueprints: [] },
        }),
        [201],
      );
      onTestFinished(async () => {
        installCatalogStorageFixture();
        const createdRuns = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        for (const run of createdRuns.runs) {
          await runs.requestCancelRun(actor, run.id, [200, 400]);
        }
        await flushWaitUntilForTest();
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });

      runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      const first = await accept(
        workflowClient().run({
          headers,
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      expect(first.body.runId).toBeNull();
      const firstRunId = await launchedAutomationRunId(
        actor,
        first.body.chatThreadId,
      );
      if (!firstRunId) {
        throw new Error("Expected first Official Workflow Run");
      }
      const firstClaim = await runs.claimRunnerJob(firstRunId);

      const beforeQueued = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      const beforeQueuedEventIds = new Set(
        beforeQueued.events.map((event) => {
          return event.id;
        }),
      );
      const queued = await accept(
        workflowClient().run({
          headers: officialQueueHeaders(actor, firstRunId, queueCase),
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      expect(queued.body).toMatchObject({
        chatThreadId: first.body.chatThreadId,
        runId: null,
      });
      const afterQueued = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      const queuedEvent = afterQueued.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          !beforeQueuedEventIds.has(event.id)
        );
      });
      if (!queuedEvent) {
        throw new Error("Expected persisted Official queued message");
      }
      const queuedEventId = await prepareOfficialQueueEncoding({
        eventId: queuedEvent.id,
        workflowId: installation.body.workflow.id,
        sourceRunId: firstRunId,
        sourceThreadId: first.body.chatThreadId,
        agentId,
        ...queueCase,
      });

      await webhooks.requestAgentComplete(
        { runId: firstRunId, exitCode: 1 },
        { authorization: `Bearer ${firstClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      let resumedRunId: string | null | undefined;
      await expect(
        (async () => {
          const events = await chat.listThreadEvents(
            actor,
            first.body.chatThreadId,
          );
          const consumed = events.events.filter((event) => {
            return (
              event.eventType === "input.prompt" &&
              event.revokesEventId === queuedEventId
            );
          });
          resumedRunId = consumed[0]?.runId;
          return consumed;
        })(),
      ).resolves.toMatchObject([{ runId: expect.any(String) }]);
      if (!resumedRunId) {
        throw new Error("Expected queued Official Workflow Run");
      }
      expect(resumedRunId).not.toBe(firstRunId);

      const resumedClaim = await runs.claimRunnerJob(resumedRunId);
      expect(resumedClaim.prompt).toBe(`/${installation.body.workflow.name}`);
      if (
        !resumedClaim.storageManifest ||
        !("storageMounts" in resumedClaim.storageManifest)
      ) {
        throw new Error("Expected canonical Run storage manifest");
      }
      expect(resumedClaim.storageManifest.storageMounts).toContainEqual(
        expect.objectContaining({
          storageId: accepted.definition.artifact.storageId,
          versionId: accepted.definition.artifact.storageVersion,
        }),
      );
      if (queueCase.origin === "agent_run") {
        expect(resumedClaim.appendSystemPrompt).toContain(
          `SOURCE_RUN_ID: ${firstRunId}`,
        );
        expect(resumedClaim.appendSystemPrompt).toContain(
          `SOURCE_THREAD_ID: ${first.body.chatThreadId}`,
        );
        expect(resumedClaim.appendSystemPrompt).toContain(
          `SOURCE_AGENT_ID: ${agentId}`,
        );
      } else {
        expect(resumedClaim.appendSystemPrompt).not.toContain("SOURCE_RUN_ID:");
      }
      const token = resumedClaim.platformEnvironment.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected queued Run Okou token");
      }
      expect(verifyOkouToken(token)).toMatchObject({
        userId: actor.userId,
        orgId: actor.orgId,
        runId: resumedRunId,
        capabilities: expect.arrayContaining(["agent:read"]),
      });
    },
  );

  it.each(officialQueueEncodings)(
    "terminalizes a queued Official source before draining the ordinary message behind it ($origin)",
    async (queueCase) => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-queued-source-${suffix}`;
      const setup = await workflowBdd.setupWorkflowOrg({
        model: "claude-fable-5-1",
      });
      const { actor } = setup;
      const { agentId } = await workflowBdd.createAgent(actor);
      installCatalogStorageFixture();
      await syncCatalog(catalog([activeDefinition(definitionName, [])]));
      const headers = authHeaders(actor);
      await setOfficialWorkflowsEnabled(actor, true);
      const installation = await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: { agentId, blueprints: [] },
        }),
        [201],
      );
      onTestFinished(async () => {
        installCatalogStorageFixture();
        const createdRuns = await runs.listAgentRuns(actor, {
          agent: agentId,
          limit: 100,
        });
        for (const run of createdRuns.runs) {
          await runs.requestCancelRun(actor, run.id, [200, 400]);
        }
        await flushWaitUntilForTest();
        await bdd.deleteAgent(actor, agentId);
        await cleanupCatalog();
      });

      runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      const first = await accept(
        workflowClient().run({
          headers,
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      expect(first.body.runId).toBeNull();
      const firstRunId = await launchedAutomationRunId(
        actor,
        first.body.chatThreadId,
      );
      if (!firstRunId) {
        throw new Error("Expected first Official Workflow Run");
      }
      await expect(runs.readRun(actor, firstRunId)).resolves.toMatchObject({
        status: "pending",
      });

      const firstClaim = await runs.claimRunnerJob(firstRunId);

      const queueHeaders = officialQueueHeaders(actor, firstRunId, queueCase);
      const beforeQueuedEvents = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      const beforeQueuedEventIds = new Set(
        beforeQueuedEvents.events.map((event) => {
          return event.id;
        }),
      );
      const beforeQueuedRunFamily = await runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        });

      const queuedOfficial = await accept(
        workflowClient().run({
          headers: queueHeaders,
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      expect(queuedOfficial.body).toMatchObject({
        chatThreadId: first.body.chatThreadId,
        runId: null,
      });
      const afterOfficialQueued = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      const officialQueuedEvent = afterOfficialQueued.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          !beforeQueuedEventIds.has(event.id)
        );
      });
      if (!officialQueuedEvent) {
        throw new Error("Expected persisted Official queued message");
      }

      const officialQueuedEventId = officialQueuedEvent.id;
      await assertOfficialQueueRawHistory(
        actor,
        first.body.chatThreadId,
        officialQueuedEventId,
      );

      const ordinaryPrompt = `ordinary queued control ${suffix}`;
      const ordinaryQueuedEventId = randomUUID();
      const queuedOrdinary = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: first.body.chatThreadId,
          prompt: ordinaryPrompt,
          clientEventId: ordinaryQueuedEventId,
        },
        [201],
      );
      if ("error" in queuedOrdinary.body) {
        throw new Error(queuedOrdinary.body.error.message);
      }
      expect(queuedOrdinary.body.runId).toBeNull();

      await accept(
        installationClient().uninstall({
          headers,
          params: { workflowId: installation.body.workflow.id },
        }),
        [204],
      );
      await webhooks.requestAgentComplete(
        { runId: firstRunId, exitCode: 1 },
        { authorization: `Bearer ${firstClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      await flushWaitUntilForTest();
      await expect(
        (async () => {
          const events = await chat.listThreadEvents(
            actor,
            first.body.chatThreadId,
          );
          return events.events.filter((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === officialQueuedEventId &&
              event.error === "conflict"
            );
          }).length;
        })(),
      ).resolves.toBe(1);
      const afterOfficialFailure = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      expect(
        afterOfficialFailure.events.filter((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === officialQueuedEventId &&
            event.error === "conflict"
          );
        }),
      ).toHaveLength(1);
      expect(
        afterOfficialFailure.events.filter((event) => {
          return (
            event.eventType === "output.error" &&
            event.error === "conflict" &&
            typeof event.content === "string" &&
            event.content.length > 0
          );
        }),
      ).toHaveLength(1);

      // One pick terminalizes only the Official source. The ordinary input
      // remains queued until the next explicit organization pass below.
      await expect(
        runs
          .listAgentRuns(actor, {
            status: "queued,pending,running,completed,failed,timeout,cancelled",
            agent: agentId,
            limit: 100,
          })
          .then(({ runs }) => {
            return runs.length;
          }),
      ).resolves.toStrictEqual(beforeQueuedRunFamily);

      const staleAt = now() + 10 * 60 * 1000;
      await withMockNowForTest(staleAt, async () => {
        await reconcileStaleQueuedMessages(first.body.chatThreadId);
      });
      await flushWaitUntilForTest();
      let ordinaryRunId: string | undefined;
      await flushWaitUntilForTest();
      await expect(
        (async () => {
          const listed = await runs.listAgentRuns(actor, {
            agent: agentId,
            limit: 100,
          });
          ordinaryRunId = listed.runs.find((run) => {
            return run.prompt === ordinaryPrompt;
          })?.id;
          return ordinaryRunId;
        })(),
      ).resolves.toStrictEqual(expect.any(String));
      if (!ordinaryRunId) {
        throw new Error("Expected ordinary queued control Run");
      }

      const expectedRunFamilyAfterOrdinary = beforeQueuedRunFamily + 1;
      await expect(
        runs
          .listAgentRuns(actor, {
            status: "queued,pending,running,completed,failed,timeout,cancelled",
            agent: agentId,
            limit: 100,
          })
          .then(({ runs }) => {
            return runs.length;
          }),
      ).resolves.toStrictEqual(expectedRunFamilyAfterOrdinary);

      const ordinaryClaim = await runs.claimRunnerJob(ordinaryRunId);
      await webhooks.requestAgentComplete(
        { runId: ordinaryRunId, exitCode: 1 },
        { authorization: `Bearer ${ordinaryClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const beforeLaterDrain = await runs
        .listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          agent: agentId,
          limit: 100,
        })
        .then(({ runs }) => {
          return runs.length;
        });
      await withMockNowForTest(staleAt + 10 * 60 * 1000, async () => {
        await reconcileStaleQueuedMessages(first.body.chatThreadId);
      });
      await flushWaitUntilForTest();

      const afterLaterDrain = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      expect(
        afterLaterDrain.events.filter((event) => {
          return (
            event.eventType === "input.rejected" &&
            event.revokesEventId === officialQueuedEventId &&
            event.error === "conflict"
          );
        }),
      ).toHaveLength(1);
      expect(
        afterLaterDrain.events.filter((event) => {
          return (
            event.eventType === "output.error" &&
            event.error === "conflict" &&
            typeof event.content === "string" &&
            event.content.length > 0
          );
        }),
      ).toHaveLength(1);
      expect(
        afterLaterDrain.events.filter((event) => {
          return (
            event.revokesEventId === ordinaryQueuedEventId &&
            event.runId === ordinaryRunId
          );
        }),
      ).toHaveLength(1);
      await expect(
        runs
          .listAgentRuns(actor, {
            status: "queued,pending,running,completed,failed,timeout,cancelled",
            agent: agentId,
            limit: 100,
          })
          .then(({ runs }) => {
            return runs.length;
          }),
      ).resolves.toStrictEqual(beforeLaterDrain);
    },
  );
});
