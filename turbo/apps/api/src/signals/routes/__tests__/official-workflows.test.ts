import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  userPreferencesContract,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferencesRoutes } from "../user-preferences";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
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
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { testOfficialWorkflowCatalogStateContract } from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateContract } from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  appendOfficialWorkflowQueueInputFixture,
  readOfficialWorkflowQueueInputFixture,
  readOfficialWorkflowQueueRunFixture,
} from "../../../test-fixtures/official-workflow-queue";
import { verifyOkouToken } from "../../auth/tokens";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { setOrgDefaultAgentFixture } from "../../../test-fixtures/org-metadata";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture,
  corruptOfficialWorkflowRevisionPayloadFixture,
  installOfficialWorkflowRunGateFixture,
  readAgentRunFamilyCountsFixture,
  readChatEventRowsAsPreviousApiFixture,
  readChatEventSnapshotHead,
  setRunAutonomyBudgetFixture,
  readLatestWorkflowAutomationRunFixture,
  readOfficialWorkflowRunStateFixture,
  readWorkflowAutomationAutonomyFixture,
  retargetWorkflowAutomationFixture,
  seedBuiltInModelKey,
  setOfficialWorkflowAutomationAdmissionStateFixture,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { officialWorkflowRoutes } from "../official-workflows";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowsRoutes } from "../workflows";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  onRejection,
  settle,
} from "../../utils";

const context = testContext();
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

async function selectBuiltInDefaultModel(actor: ApiTestUser): Promise<void> {
  await seedBuiltInModelKey(context, "claude-sonnet-5");
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
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
        formUrl: GOOGLE_FORM_URL,
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

function configureOfficialGoogleFormsMock() {
  const recorder = { watchCalls: 0 };
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
      expect(params.formId).toBe(GOOGLE_FORM_ID);
      return HttpResponse.json({
        formId: GOOGLE_FORM_ID,
        info: { title: "Official workflow survey" },
        publishSettings: {
          publishState: {
            isPublished: true,
            isAcceptingResponses: true,
          },
        },
      });
    }),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/responses",
      ({ request, params }) => {
        expect(params.formId).toBe(GOOGLE_FORM_ID);
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
    http.post(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      ({ params }) => {
        expect(params.formId).toBe(GOOGLE_FORM_ID);
        recorder.watchCalls += 1;
        return HttpResponse.json({
          id: `official-google-forms-watch-${randomUUID()}`,
          target: { topic: { topicName: GOOGLE_FORMS_TOPIC_NAME } },
          eventType: "RESPONSES",
          createTime: "2026-09-01T08:00:00Z",
          expireTime: "2026-09-08T08:00:00Z",
          state: "ACTIVE",
        });
      },
    ),
    http.delete(
      "https://forms.googleapis.com/v1/forms/:formId/watches/:watchId",
      () => {
        return HttpResponse.json({});
      },
    ),
  );
  return recorder;
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
  return await accept(
    syncClient(candidate).sync({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

async function syncDeployedCatalog() {
  await syncCatalog(
    catalog([
      activeDefinition("connector-doctor", [
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
      ]),
    ]),
  );
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

async function simulateStructureTransitionCrash(args: {
  readonly definitionName: string;
  readonly automationId: string;
}): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "simulate-structure-transition-crash", ...args },
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

async function pauseNextDormantMaterialization(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "pause-next-dormant-materialization" },
    }),
    [200],
  );
}

async function waitForDormantMaterializationPause(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "wait-for-dormant-materialization-pause" },
    }),
    [200],
  );
}

async function resumeDormantMaterialization(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "resume-dormant-materialization" },
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

async function crashNextStructureTransitionPromotion(): Promise<void> {
  await accept(
    stateClient().action({
      body: { action: "crash-next-structure-transition-promotion" },
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
        orgIds: [],
        exportJobIds: [],
      },
    }),
    [200],
  );
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

const officialQueueEncodings = [
  { encoding: "legacy", origin: "web", storedBrand: "vm0" },
  { encoding: "canonical", origin: "web", storedBrand: "okou" },
  { encoding: "legacy", origin: "agent_run", storedBrand: "okou" },
  { encoding: "canonical", origin: "agent_run", storedBrand: "vm0" },
] as const;

type OfficialQueueEncoding = (typeof officialQueueEncodings)[number];

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

async function readOfficialQueueSnapshot(
  threadId: string,
  storage: ReturnType<typeof installCatalogStorageFixture>,
) {
  const head = await readChatEventSnapshotHead(context, threadId);
  if (!head.object_key) {
    throw new Error("Expected Official queue snapshot");
  }
  const rows = gunzipSync(storage.readObject(head.object_key))
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => {
      return chatEventRowSchema.parse(JSON.parse(line));
    });
  return { head, rows };
}

async function listOfficialQueueEvents(
  actor: ApiTestUser,
  threadId: string,
  storage: ReturnType<typeof installCatalogStorageFixture>,
) {
  const snapshot = await readOfficialQueueSnapshot(threadId, storage);
  if (
    snapshot.head.terminal_event_id === null ||
    snapshot.head.terminal_seq_id === null
  ) {
    throw new Error("Expected Official snapshot terminal cursor");
  }
  const tail = await chat.listThreadEventRows(actor, threadId, {
    lastEventId: snapshot.head.terminal_event_id,
    lastSeqId: snapshot.head.terminal_seq_id,
  });
  const rows = new Map(
    [...snapshot.rows, ...tail].map((row) => {
      return [row.id, row];
    }),
  );
  return { events: projectChatEventRows([...rows.values()]) };
}

async function assertOfficialQueueSnapshot(
  actor: ApiTestUser,
  threadId: string,
  sources: readonly ChatEventRow[],
  storage: ReturnType<typeof installCatalogStorageFixture>,
): Promise<void> {
  for (const source of sources) {
    await expect(
      readOfficialWorkflowQueueInputFixture(source.id),
    ).resolves.toMatchObject({
      eventType: source.eventType,
      contextType: source.contextType,
      contextId: source.contextId,
      seqId: source.seqId,
      payload: source.payload,
    });
  }
  await accept(
    setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
      testChatEventSearchProjectionContract,
    ).project({
      body: { chat_thread_ids: [threadId] },
    }),
    [200],
  );
  await accept(
    setupApp({ context, routes: testChatEventSnapshotRoutes })(
      testChatEventSnapshotContract,
    ).snapshot({
      body: { chat_thread_ids: [threadId], r2_object_keys: [] },
    }),
    [200],
  );
  const { rows } = await readOfficialQueueSnapshot(threadId, storage);
  for (const source of sources) {
    expect(rows).toContainEqual(source);
  }
  await listOfficialQueueEvents(actor, threadId, storage);
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

async function setMorningBriefEnabled(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.MorningBrief]: enabled },
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
): Promise<void> {
  if (!actor.orgId || !actor.orgRole) {
    throw new Error("Expected organization-scoped Clerk member");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole,
      created_at: createdAt.getTime(),
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
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "Official",
        lastName: "Automation",
        imageUrl: null,
      },
    ],
  });
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
  const { actor } = await workflowBdd.setupWorkflowOrg({ tier: "team" });
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
  const { actor } = await workflowBdd.setupWorkflowOrg();
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
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `official-workflow-installation-test-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog();
  await cleanupCatalog();
});

describe("Morning Brief preference", () => {
  it("installs idempotently without the Official Workflows feature and preserves identities across disable and re-enable", async () => {
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
    await setMorningBriefEnabled(actor, true);

    const initial = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(initial.body).toStrictEqual({
      status: "paused",
      enabled: false,
      nextRunAt: null,
      timezone: "Asia/Shanghai",
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
        nextRunAt: expect.any(String),
        timezone: "Asia/Shanghai",
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
      nextRunAt: null,
      timezone: "Asia/Shanghai",
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
      nextRunAt: expect.any(String),
      timezone: "Asia/Shanghai",
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
      },
    ]);
    expect(after.body.workflow.id).toBe(identities.workflowId);

    await setMorningBriefEnabled(actor, false);
    const deniedRead = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [403],
    );
    expect(deniedRead.body.error.code).toBe("FORBIDDEN");
    const deniedUpdate = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: false },
      }),
      [403],
    );
    expect(deniedUpdate.body.error.code).toBe("FORBIDDEN");

    const afterRolloutOff = await accept(
      installationClient().get({
        headers,
        params: { workflowId: morningBrief.id },
      }),
      [200],
    );
    expect(afterRolloutOff.body.workflow).toMatchObject({
      id: identities.workflowId,
      automations: [
        {
          id: identities.automationId,
          chatThreadId: identities.chatThreadId,
          enabled: true,
        },
      ],
    });
  });

  it("preserves enable intent while timezone or default Agent is unavailable", async () => {
    const missingTimezone = await workflowBdd.setupWorkflowOrg();
    await setMorningBriefEnabled(missingTimezone.actor, true);
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
    await initializeBriefMember(missingAgent);
    await setMorningBriefEnabled(missingAgent, true);
    const agentHeaders = authHeaders(missingAgent);
    const unavailableAgent = await accept(
      morningBriefPreferenceClient().get({ headers: agentHeaders }),
      [200],
    );
    expect(unavailableAgent.body).toMatchObject({
      enabled: false,
      timezone: "Asia/Shanghai",
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
    await setMorningBriefEnabled(actor, false);
    const headers = authHeaders(actor);
    const onDefaultAgent = await installMorningBriefFromCatalog(
      actor,
      onboarding.defaultAgentId,
    );
    const onAlternateAgent = await installMorningBriefFromCatalog(
      actor,
      alternate.agentId,
    );

    const hiddenRead = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [403],
    );
    expect(hiddenRead.body.error.code).toBe("FORBIDDEN");

    await setMorningBriefEnabled(actor, true);

    const read = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(read.body).toMatchObject({
      enabled: true,
      status: "enabled",
      timezone: "Asia/Shanghai",
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
      nextRunAt: null,
    });

    // The adopted installation follows the preference; the other one is left
    // alone and keeps running.
    await expect(
      readMorningBriefAutomations(actor, onDefaultAgent),
    ).resolves.toMatchObject([{ enabled: false }]);
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
    await setMorningBriefEnabled(actor, true);
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
      timezone: "Asia/Shanghai",
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

  it("leaves an installed brief in place when the org default Agent changes", async () => {
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
    await setMorningBriefEnabled(actor, true);
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

    // Only the Clerk org-creation bootstrap writes `default_agent_id`, so no
    // production endpoint can repoint an existing org at another Agent. This
    // fixture is the narrow exception that makes the case reachable at all.
    await setOrgDefaultAgentFixture({ orgId, agentId: replacement.agentId });

    const read = await accept(
      morningBriefPreferenceClient().get({ headers }),
      [200],
    );
    expect(read.body).toMatchObject({
      enabled: true,
      status: "enabled",
      timezone: "Asia/Shanghai",
      unavailableReason: null,
    });

    // Logging in must not provision a second brief on the new default Agent.
    await initializeBriefMember(actor);
    await expect(listMorningBriefInstallations(actor)).resolves.toMatchObject([
      { id: installed.id, agentId: originalAgentId },
    ]);

    // Ownership stays on the Agent the brief was installed on, even once the
    // new default Agent carries a brief of its own.
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
    await setMorningBriefEnabled(actor, true);
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
      timezone: "Asia/Shanghai",
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
  entries: readonly { readonly actor: ApiTestUser; readonly createdAt: Date }[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: entries.map(({ actor, createdAt }) => {
        return {
          id: `membership-${actor.userId}-${actor.orgId}`,
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

async function initializeBriefMember(actor: ApiTestUser, timezone?: string) {
  return await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: timezone === undefined ? {} : { timezone },
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

async function prepareBriefMember({
  actor = bdd.user(),
  createdAt = new Date("2030-01-01T00:00:00.000Z"),
  catalogAvailable = true,
}: {
  readonly actor?: ApiTestUser;
  readonly createdAt?: Date;
  readonly catalogAvailable?: boolean;
} = {}) {
  installCatalogStorageFixture();
  if (catalogAvailable) {
    await syncDeployedCatalog();
  }
  mockBriefMemberships([{ actor, createdAt }]);
  await setOfficialWorkflowsEnabled(actor, false);
  await setMorningBriefEnabled(actor, true);
  await deliverClerkOrganizationCreated(actor, createdAt);
  onTestFinished(async () => {
    installCatalogStorageFixture();
    await cleanupCatalog();
  });
  return { actor, createdAt };
}

describe("Morning Brief default onboarding", () => {
  it("installs without any connected source and stays single across concurrent cron ticks", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
      timezone: "Asia/Shanghai",
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
      timezone: "Asia/Shanghai",
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
      timezone: "Asia/Shanghai",
    });
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

  it("recovers a transient installation failure without repeating onboarding", async () => {
    const { actor } = await prepareBriefMember({ catalogAvailable: false });
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    await syncDeployedCatalog();
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("keeps membership verification retryable when Clerk is temporarily unavailable", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await connectBriefSource(actor);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
      new Error("Temporary Clerk outage"),
    );
    const failed = await setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone: "Asia/Shanghai" },
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ timezone: "Asia/Shanghai" });
    mockBriefMemberships([{ actor, createdAt }]);
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: true,
      status: "enabled",
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
      timezone: "America/Los_Angeles",
    });
    expect(changed.body.nextRunAt).not.toBeNull();
    if (!changed.body.nextRunAt) {
      throw new Error("Expected next run");
    }
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        hour12: false,
      }).format(new Date(changed.body.nextRunAt)),
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
    await setMorningBriefEnabled(actor, true);
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
    await initializeBriefMember(first.actor);
    expect((await readBriefPreference(first.actor)).body).toMatchObject({
      status: "enabled",
      timezone: "Asia/Shanghai",
    });
    expect((await readBriefPreference(second.actor)).body).toMatchObject({
      status: "paused",
      enabled: false,
      timezone: "America/Los_Angeles",
    });
    await connectBriefSource(second.actor);
    await initializeBriefMember(second.actor);
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

  it("cancels pending enrollment when membership is removed, including a late created event", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await initializeBriefMember(actor);
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
    mockBriefMemberships([]);
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await tickBriefEnrollment(actor);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("keeps an explicit timezone choice when browser initialization races it", async () => {
    const { actor } = await prepareBriefMember();
    await Promise.all([
      initializeBriefMember(actor, "Asia/Shanghai"),
      bdd.updateUserTimezone(actor, "Asia/Tokyo"),
    ]);
    const initialized = await initializeBriefMember(
      actor,
      "America/Los_Angeles",
    );
    expect(initialized.body.timezone).toBe("Asia/Tokyo");
    const invalid = await setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone: "Invalid/Timezone" },
    });
    expect(invalid.status).toBe(400);
    const saved = await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.timezone).toBe("Asia/Tokyo");
  });

  it("honors an explicit feature override and never reinstalls a deleted completed enrollment", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await setMorningBriefEnabled(actor, false);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    await setMorningBriefEnabled(actor, true);
    await initializeBriefMember(actor);
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
    await initializeBriefMember(actor);
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

  it.each([
    {
      locale: null,
      localeLabel: "the default locale",
      title: "Okou Morning Brief",
    },
    {
      locale: "pt-BR",
      localeLabel: "pt-BR",
      title: "Okou Resumo da manhã",
    },
  ] satisfies readonly {
    readonly locale: UserLocale | null;
    readonly localeLabel: string;
    readonly title: string;
  }[])(
    "names a new Morning Brief thread for $localeLabel",
    async ({ locale, title }) => {
      installCatalogStorageFixture();
      await syncDeployedCatalog();
      const { actor } = await workflowBdd.setupWorkflowOrg({
        timezone: "Asia/Shanghai",
      });
      if (!actor.orgId) {
        throw new Error("Expected organization-scoped actor");
      }
      if (locale) {
        await bdd.updateUserLocale(actor, locale);
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

      const started = await accept(
        automationClient().run({
          headers,
          params: { id: automation.id },
        }),
        [201],
      );
      await expect(
        chat.readThreadMetadata(actor, started.body.chatThreadId),
      ).resolves.toMatchObject({ title });
      if (started.body.runId) {
        await runs.requestCancelRun(actor, started.body.runId, [200, 400]);
      }
    },
  );

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

  async function retireInstalledLifecycleScenario() {
    const {
      actor,
      definitionName,
      headers,
      installBody,
      installed: reinstalled,
      zeroBlueprintName,
    } = await installOfficialWorkflowLifecycleScenario();
    const reinstalledDailyAutomation =
      reinstalled.body.workflow.automations.find((automation) => {
        return automation.official?.blueprintKey === "daily";
      });
    if (!reinstalledDailyAutomation) {
      throw new Error("Expected installed daily automation");
    }
    await syncCatalog(
      catalog([
        retiredDefinition(definitionName),
        activeDefinition(zeroBlueprintName, []),
      ]),
    );
    const retiredInstallation = await accept(
      installationClient().get({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
      }),
      [200],
    );
    expect(
      retiredInstallation.body.workflow.official?.definitionLifecycle,
    ).toBe("retired");
    const retiredDiscovery = await accept(
      officialClient().list({ headers }),
      [200],
    );
    expect(
      retiredDiscovery.body.some((entry) => {
        return entry.name === definitionName;
      }),
    ).toBeFalsy();
    const retiredDefinitionDetail = await accept(
      officialClient().get({
        headers,
        params: { definitionName },
      }),
      [200],
    );
    expect(retiredDefinitionDetail.body).toMatchObject({
      name: definitionName,
      lifecycle: "retired",
      workflow: {
        instruction: "Execute only the accepted Definition content.",
      },
    });
    await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: installBody,
      }),
      [409],
    );

    await setOfficialWorkflowsEnabled(actor, false);
    await accept(officialClient().list({ headers }), [403]);
    const switchDisabledInstallation = await accept(
      installationClient().get({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
      }),
      [200],
    );
    expect(switchDisabledInstallation.body.definition).toMatchObject({
      name: definitionName,
      lifecycle: "retired",
      blueprints: expect.arrayContaining([
        expect.objectContaining({
          key: "daily",
          parameters: expect.arrayContaining([
            expect.objectContaining({
              key: "include-weekends",
              type: "boolean",
            }),
            expect.objectContaining({ key: "cron-expression", type: "string" }),
          ]),
        }),
        expect.objectContaining({
          key: "pulse",
          parameters: expect.arrayContaining([
            expect.objectContaining({
              key: "interval-seconds",
              type: "integer",
            }),
          ]),
        }),
      ]),
    });
    return { actor, headers, reinstalled, reinstalledDailyAutomation };
  }

  it("retains and copies a retired Official installation while discovery is disabled", async () => {
    const { actor, headers, reinstalled } =
      await retireInstalledLifecycleScenario();
    const { agentId: retiredCopyAgentId } =
      await workflowBdd.createAgent(actor);
    let retiredCopyAgentDeleted = false;
    onTestFinished(async () => {
      if (!retiredCopyAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, retiredCopyAgentId);
      }
    });
    installCatalogStorageFixture();
    const retiredCopy = await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
        body: { toAgentId: retiredCopyAgentId },
      }),
      [201],
    );
    const retiredCopyDetail = await accept(
      workflowClient().get({
        headers,
        params: { workflowId: retiredCopy.body.id },
      }),
      [200],
    );
    expect(retiredCopyDetail.body).toMatchObject({
      instruction: "Execute only the accepted Definition content.",
      fileContents: [{ path: "references/context.md", content: "accepted\n" }],
      official: null,
    });
    expect(
      retiredCopyDetail.body.automations.every((automation) => {
        return automation.official === null;
      }),
    ).toBeTruthy();
    await bdd.deleteAgent(actor, retiredCopyAgentId);
    retiredCopyAgentDeleted = true;
  });

  it("rejects copying a stale retired installation and allows reconfiguration and uninstall", async () => {
    const { actor, headers, reinstalled, reinstalledDailyAutomation } =
      await retireInstalledLifecycleScenario();
    const { agentId: staleCopyAgentId } = await workflowBdd.createAgent(actor);
    let staleCopyAgentDeleted = false;
    onTestFinished(async () => {
      if (!staleCopyAgentDeleted) {
        installCatalogStorageFixture();
        await bdd.deleteAgent(actor, staleCopyAgentId);
      }
    });
    await setOfficialWorkflowAutomationAdmissionStateFixture(
      context,
      reinstalledDailyAutomation.id,
      "needs_reconfiguration",
    );
    const staleCopy = await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
        body: { toAgentId: staleCopyAgentId },
      }),
      [409],
    );
    expect(staleCopy.body.error.message).toContain("Reconfigure");
    const staleTargetWorkflows = await accept(
      workflowCollectionClient().list({
        headers,
        query: { agentId: staleCopyAgentId },
      }),
      [200],
    );
    expect(staleTargetWorkflows.body).toStrictEqual([]);
    await bdd.deleteAgent(actor, staleCopyAgentId);
    staleCopyAgentDeleted = true;

    await accept(
      automationClient().disable({
        headers,
        params: { id: reinstalledDailyAutomation.id },
      }),
      [200],
    );
    await accept(
      installationClient().reconfigure({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [{ key: "cron-expression", value: "0 10 * * *" }],
            },
          ],
        },
      }),
      [200],
    );
    await accept(
      automationClient().enable({
        headers,
        params: { id: reinstalledDailyAutomation.id },
      }),
      [200],
    );
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: reinstalled.body.workflow.id },
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
      launch_queue_count: 0,
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

  it.each([
    "installation release",
    "instruction release",
    "concurrent pause",
    "persisted reconciliation",
  ] as const)("preserves workflow identity during %s races", async (phase) => {
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
    mockGmailConnectorOAuth({ email: `official-race-${suffix}@example.test` });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);

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
    await setOfficialWorkflowsEnabled(actor, true);
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
      expect(stopCalls).toBeGreaterThan(0);
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
        expect(unchanged.body.workflow.automations[0]?.official).toMatchObject({
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

      const stopCallsBeforeAgentDeletion = stopCalls;
      await bdd.deleteAgent(actor, agentId);
      agentDeleted = true;
      await accept(
        installationClient().get({
          headers,
          params: { workflowId: retried.body.workflow.id },
        }),
        [404],
      );
      expect(stopCalls).toBeGreaterThan(stopCallsBeforeAgentDeletion);
    },
  );

  it("preserves the Google Forms account projection across same-target reconfiguration", async () => {
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
    const forms = configureOfficialGoogleFormsMock();
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
          blueprints: [{ blueprintKey: "google-forms-trigger", bindings: [] }],
        },
      }),
      [201],
    );
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
    expect(forms.watchCalls).toBe(1);

    await syncCatalog(
      catalog([activeDefinition(definitionName, [googleFormsBlueprint(7)])]),
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
      eventConfig: { connectorId },
      official: { reconciliationStatus: "current" },
    });
    expect(current?.official?.appliedFingerprint).not.toBe(initialFingerprint);
    expect(forms.watchCalls).toBe(1);
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

  it("records selective non-blocking work and converges schema changes per Blueprint", async () => {
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

    const presentationOnly = activeDefinition(
      definitionName,
      initialBlueprints,
    );
    await syncCatalog(
      catalog([
        {
          ...presentationOnly,
          presentation: { ...presentationOnly.presentation, order: 17 },
        },
        activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
      ]),
    );
    await expect(
      readOfficialWorkflowReconciliationState({}),
    ).resolves.toMatchObject({ body: { reconciliationWork: [] } });

    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          initialBlueprints,
          "Instruction-only release must not reconcile Automations.",
        ),
        activeDefinition(unrelatedDefinitionName, [unrelatedInitial]),
      ]),
    );
    await expect(
      readOfficialWorkflowReconciliationState({}),
    ).resolves.toMatchObject({ body: { reconciliationWork: [] } });

    const unrelatedChanged = unresolvedLoopBlueprint();
    const unrelatedActivation = await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          initialBlueprints,
          "Instruction-only release must not reconcile Automations.",
        ),
        activeDefinition(unrelatedDefinitionName, [unrelatedChanged]),
      ]),
    );
    expect(unrelatedActivation.body.outcome).toBe("accepted");
    const unrelatedWork = await readOfficialWorkflowReconciliationState({});
    expect(unrelatedWork.body.reconciliationWork).toMatchObject([
      { definitionName: unrelatedDefinitionName, state: "pending" },
    ]);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 1,
      advanced: 0,
      retried: 0,
      installations: 0,
    });

    const onceAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
    const changedPulse = pulseOnceBlueprint(onceAt);
    const activation = await syncCatalog(
      catalog([
        activeDefinition(definitionName, [scheduledBlueprint(), changedPulse]),
        activeDefinition(unrelatedDefinitionName, [unrelatedChanged]),
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

    const evolutionActivation = await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          evolvedScheduledBlueprint(),
          changedPulse,
        ]),
        activeDefinition(unrelatedDefinitionName, [unrelatedChanged]),
      ]),
    );
    if (evolutionActivation.body.outcome !== "accepted") {
      throw new Error(
        `Evolution catalog rejected: ${JSON.stringify(evolutionActivation.body.diagnostics)}`,
      );
    }
    expect(evolutionActivation.body).toMatchObject({ outcome: "accepted" });
    const evolutionWork = await readOfficialWorkflowReconciliationState({});
    expect(evolutionWork.body.reconciliationWork).toMatchObject([
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

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          unresolvedScheduledBlueprint(),
          withUnresolvedRequiredBudget(changedPulse),
        ]),
        activeDefinition(unrelatedDefinitionName, [unrelatedChanged]),
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

  it("recovers superseded and crashed work while preserving permanent Blueprint identity", async () => {
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
    if (!historical.body.runId) {
      throw new Error("Expected historical Official Automation Run");
    }
    await runs.requestCancelRun(actor, historical.body.runId, [200, 400]);

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
      readOfficialWorkflowRunStateFixture(context, historical.body.runId),
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
      readOfficialWorkflowRunStateFixture(context, historical.body.runId),
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
        if (!historical.body.runId) {
          throw new Error("Expected historical Official Automation Run");
        }
        await runs.requestCancelRun(actor, historical.body.runId, [200, 400]);

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
            readOfficialWorkflowRunStateFixture(context, historical.body.runId),
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
          expect(preparedScenario.stopCalls).toBe(1);
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

  it("discards paused stale dormant materialization before promotion and preserves newer catalog intent", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-materialize-race-${suffix}`;
    const originalBlueprint = gmailBlueprint();
    await syncCatalog(
      catalog([activeDefinition(definitionName, [originalBlueprint])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    onTestFinished(async () => {
      await resumeDormantMaterialization();
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
      email: `materialize-race-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return HttpResponse.json({
          historyId: String(200 + watchCalls),
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
    const originalAutomation = installed.body.workflow.automations[0];
    if (!originalAutomation?.official) {
      throw new Error("Expected original Official Gmail Automation");
    }
    const permanentAutomationId = originalAutomation.id;
    const originalFingerprint = originalAutomation.official.appliedFingerprint;
    const historyCounts = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    await runOfficialWorkflowReconciliationWorker();
    const removed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(removed.body.workflow.automations).toHaveLength(0);
    const removedState = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(removedState.body.identities).toStrictEqual([
      expect.objectContaining({
        id: permanentAutomationId,
        automationId: null,
        state: "removed",
        retainedIntendedEnabled: true,
      }),
    ]);

    await syncCatalog(
      catalog([activeDefinition(definitionName, [originalBlueprint])]),
    );
    watchCalls = 0;
    await pauseNextDormantMaterialization();
    const olderWorker = runOfficialWorkflowReconciliationWorker();
    await waitForDormantMaterializationPause();
    const supersedingBlueprint: OfficialWorkflowBlueprint = {
      ...gmailBlueprint(),
      desiredState: {
        ...gmailBlueprint().desiredState,
        autonomyBudget: 7,
      },
    };
    const superseding = await onRejection(
      syncCatalog(
        catalog([activeDefinition(definitionName, [supersedingBlueprint])]),
      ),
      resumeDormantMaterialization,
    );
    await resumeDormantMaterialization();
    if (!superseding.body.releaseId) {
      throw new Error("Expected superseding Official Workflow release");
    }
    const supersedingReleaseId = superseding.body.releaseId;
    await olderWorker;

    const afterOlderWorker = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(afterOlderWorker.body.workflow.automations).toHaveLength(0);
    expect(watchCalls).toBe(0);
    const supersededState = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(supersededState.body.reconciliationWork).toMatchObject([
      {
        definitionName,
        requestedReleaseId: supersedingReleaseId,
        state: "pending",
      },
    ]);
    expect(supersededState.body.identities).toStrictEqual([
      expect.objectContaining({
        id: permanentAutomationId,
        automationId: null,
        blueprintKey: "gmail-trigger",
        state: "failed",
        retainedIntendedEnabled: true,
        retainedAppliedFingerprint: originalFingerprint,
      }),
    ]);

    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const converged = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(converged.body.workflow.automations).toHaveLength(1);
    expect(converged.body.workflow.automations[0]).toMatchObject({
      id: permanentAutomationId,
      enabled: true,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "current",
      },
    });
    expect(
      converged.body.workflow.automations[0]?.official?.appliedFingerprint,
    ).not.toBe(originalFingerprint);
    await expect(
      readWorkflowAutomationAutonomyFixture(context, permanentAutomationId),
    ).resolves.toMatchObject({ autonomyBudget: 7, enabled: true });
    const convergedState = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(convergedState.body.reconciliationWork).toStrictEqual([]);
    expect(convergedState.body.identities).toStrictEqual([
      expect.objectContaining({
        id: permanentAutomationId,
        automationId: permanentAutomationId,
        blueprintKey: "gmail-trigger",
        state: "active",
      }),
    ]);
    expect(watchCalls).toBe(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(historyCounts);
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

  it("restores a dormant Calendar identity without another enabled consumer", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-calendar-materialize-${suffix}`;
    const calendarBlueprint =
      structureTransitionCalendarBlueprint("calendar-trigger");
    await syncCatalog(
      catalog([activeDefinition(definitionName, [calendarBlueprint])]),
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
    mockGoogleCalendarConnectorOAuth({
      email: `calendar-materialize-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "google-calendar");
    const watch = configureOfficialCalendarWatchMock();
    await setOfficialWorkflowsEnabled(actor, true);
    const headers = authHeaders(actor);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: {
          agentId,
          blueprints: [{ blueprintKey: "calendar-trigger", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const original = installed.body.workflow.automations[0];
    if (!original) {
      throw new Error("Expected Calendar materialization Automation");
    }
    expect(original).toMatchObject({
      kind: "event",
      eventType: "google-calendar-event-created",
      enabled: true,
      official: { intendedEnabled: true, reconciliationStatus: "current" },
    });
    expect(watch.watchCalls).toBe(1);
    const beforeRuns = await readAgentRunFamilyCountsFixture(context, agentId);

    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    await runOfficialWorkflowReconciliationWorker();
    const removed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(removed.body.workflow.automations).toStrictEqual([]);
    expect(watch.stopCalls).toBe(1);
    const dormant = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(dormant.body.identities).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        automationId: null,
        blueprintKey: "calendar-trigger",
        state: "removed",
        retainedIntendedEnabled: true,
      }),
    ]);

    await syncCatalog(
      catalog([activeDefinition(definitionName, [calendarBlueprint])]),
    );
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const restored = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(restored.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        kind: "event",
        eventType: "google-calendar-event-created",
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watch.watchCalls).toBe(2);
    const active = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(active.body.identities).toStrictEqual([
      expect.objectContaining({
        id: original.id,
        automationId: original.id,
        blueprintKey: "calendar-trigger",
        state: "active",
      }),
    ]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
  });

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
    if (!historical.body.runId) {
      throw new Error("Expected historical Official Automation Run");
    }
    const historicalRunId = historical.body.runId;
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
    expect(stopCalls).toBe(1);

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
    expect(stopCalls).toBe(2);
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
    expect(stopCalls).toBe(2);
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

  it("recovers a committed non-runnable structure-transition stage without admitting a Run", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-structure-crash-${suffix}`;
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
      email: `structure-crash-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchShouldFail = true;
    let watchCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return watchShouldFail
          ? HttpResponse.json({ error: "watch failed" }, { status: 500 })
          : HttpResponse.json({
              historyId: String(700 + watchCalls),
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
          blueprints: [{ blueprintKey: "lifecycle-transition", bindings: [] }],
        },
      }),
      [201],
    );
    const workflowId = installed.body.workflow.id;
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected structure-transition crash Automation");
    }
    const beforeRuns = await readAgentRunFamilyCountsFixture(context, agentId);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-new-message"),
        ]),
      ]),
    );
    await simulateStructureTransitionCrash({
      definitionName,
      automationId: automation.id,
    });
    const crashed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(crashed.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        enabled: false,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "reconciling",
        }),
      }),
    ]);
    const blocked = await accept(
      automationClient().run({ headers, params: { id: automation.id } }),
      [201, 409],
    );
    expect(
      blocked.status === 409 ||
        ("runId" in blocked.body && blocked.body.runId === null),
    ).toBeTruthy();
    await flushWaitUntilForTest();
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automation.id),
    ).resolves.toBeNull();
    expect(watchCalls).toBe(1);

    watchShouldFail = false;
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const recovered = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(recovered.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "event",
        eventType: "gmail-new-message",
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watchCalls).toBe(2);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
  });

  it("cleans a prepared watch after a hard crash and catalog reversion", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-structure-watch-crash-${suffix}`;
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
      email: `structure-watch-crash-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchCalls = 0;
    let stopCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return HttpResponse.json({
          historyId: String(900 + watchCalls),
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
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected prepared-watch crash Automation");
    }
    const beforeRuns = await readAgentRunFamilyCountsFixture(context, agentId);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-new-message"),
        ]),
      ]),
    );
    await crashNextStructureTransitionPromotion();
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 0,
      advanced: 0,
      retried: 1,
      installations: 0,
    });
    const crashed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(crashed.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        enabled: false,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "reconciling",
        }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(0);
    await assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture(
      context,
      automation.id,
      workflowId,
    );
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automation.id),
    ).resolves.toBeNull();

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionScheduleBlueprint(7200),
        ]),
      ]),
    );
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual(
      expect.objectContaining({ claimed: 1, completed: 1, installations: 1 }),
    );
    const recovered = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(recovered.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 7200 },
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automation.id),
    ).resolves.toBeNull();
    const identity = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(identity.body.identities).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        automationId: automation.id,
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

  it("rejects a superseded prepared event transition before final promotion", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-structure-race-${suffix}`;
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
      await resumeStructureTransitionPromotion();
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    mockGmailConnectorOAuth({
      email: `structure-race-${suffix}@example.test`,
    });
    await workflowBdd.connectConnector(actor, "gmail");
    mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
    let watchCalls = 0;
    let stopCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        watchCalls++;
        return HttpResponse.json({
          historyId: String(800 + watchCalls),
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
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected structure-transition race Automation");
    }
    const beforeRuns = await readAgentRunFamilyCountsFixture(context, agentId);

    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [
          structureTransitionGmailBlueprint("gmail-new-message"),
        ]),
      ]),
    );
    await pauseNextStructureTransitionPromotion();
    const olderWorker = runOfficialWorkflowReconciliationWorker();
    await waitForStructureTransitionPromotionPause();
    const superseding = await onRejection(
      syncCatalog(
        catalog([
          activeDefinition(definitionName, [
            structureTransitionScheduleBlueprint(7200),
          ]),
        ]),
      ),
      resumeStructureTransitionPromotion,
    );
    await resumeStructureTransitionPromotion();
    await olderWorker;
    if (!superseding.body.releaseId) {
      throw new Error("Expected superseding structure-transition release");
    }

    const superseded = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(superseded.body.workflow.automations).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        kind: "schedule",
        enabled: false,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "reconciling",
        }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
    const pending = await readOfficialWorkflowReconciliationState({});
    expect(pending.body.reconciliationWork).toMatchObject([
      {
        definitionName,
        requestedReleaseId: superseding.body.releaseId,
        state: "pending",
      },
    ]);

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
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 7200 },
        enabled: true,
        official: expect.objectContaining({
          intendedEnabled: true,
          reconciliationStatus: "current",
        }),
      }),
    ]);
    expect(watchCalls).toBe(1);
    expect(stopCalls).toBe(1);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRuns);
    const identity = await readOfficialWorkflowReconciliationState({
      workflowId,
    });
    expect(identity.body.identities).toStrictEqual([
      expect.objectContaining({
        id: automation.id,
        automationId: automation.id,
        blueprintKey: "lifecycle-transition",
        state: "active",
      }),
    ]);
  });

  it("compensates event-watch update and removal failures before committing current state", async () => {
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
    let stopShouldFail = false;
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
        return stopShouldFail
          ? HttpResponse.json({ error: "stop failed" }, { status: 500 })
          : new HttpResponse(null, { status: 204 });
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

    stopShouldFail = true;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    await expect(
      runOfficialWorkflowReconciliationWorker(),
    ).resolves.toStrictEqual({
      claimed: 1,
      completed: 0,
      advanced: 0,
      retried: 1,
      installations: 0,
    });
    const compensatedRemoval = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(compensatedRemoval.body.workflow.automations[0]).toMatchObject({
      id: automation.id,
      enabled: true,
      eventConfig: expect.objectContaining({ labelName: "Follow Up" }),
      official: {
        intendedEnabled: true,
        reconciliationStatus: "failed",
      },
    });

    stopShouldFail = false;
    await makeOfficialWorkflowReconciliationWorkDue(definitionName);
    await runOfficialWorkflowReconciliationWorker();
    const removed = await accept(
      installationClient().get({ headers, params: { workflowId } }),
      [200],
    );
    expect(removed.body.workflow.automations).toStrictEqual([]);
    expect(watchCalls).toBeGreaterThan(1);
    expect(stopCalls).toBeGreaterThan(1);
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

    const setup = await workflowBdd.setupWorkflowOrg();
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
    if (!direct.body.runId) {
      throw new Error("Expected direct Official Workflow Run");
    }
    const firstRunId = direct.body.runId;
    const firstState = await readOfficialWorkflowRunStateFixture(
      context,
      firstRunId,
    );
    expect(firstState.provenance?.definitions).toStrictEqual(
      [firstAccepted.definition, secondAccepted.definition]
        .map((definition) => {
          return {
            name: definition.name,
            revision: definition.revision,
            artifact: {
              orgId: SYSTEM_ORG_ID,
              userId: VOLUME_ORG_USER_ID,
              storageName: definition.artifact.storageName,
              storageId: definition.artifact.storageId,
              storageVersion: definition.artifact.storageVersion,
            },
          };
        })
        .sort((left, right) => {
          return left.name.localeCompare(right.name);
        }),
    );
    expect(firstState.storage_mounts).toStrictEqual(
      expect.arrayContaining(
        [firstAccepted.definition, secondAccepted.definition].map(
          (definition) => {
            return expect.objectContaining({
              org_id: SYSTEM_ORG_ID,
              user_id: VOLUME_ORG_USER_ID,
              name: definition.artifact.storageName,
              storage_id: definition.artifact.storageId,
              version: definition.artifact.storageVersion,
              mount_path: expect.stringMatching(`/${definition.name}$`),
            });
          },
        ),
      ),
    );
    expect(firstState.storage_mounts).not.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ storage_id: shadowStorageId }),
      ]),
    );

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
      expect.arrayContaining([
        expect.objectContaining({
          storageId: firstAccepted.definition.artifact.storageId,
          versionId: firstAccepted.definition.artifact.storageVersion,
        }),
      ]),
    );
    await expect(
      readOfficialWorkflowRunStateFixture(context, firstRunId),
    ).resolves.toMatchObject({ provenance: firstState.provenance });
    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );

    const later = await runs.createRun(actor, {
      agentId,
      prompt: "resolve the newly accepted Official Definition revision",
    });
    const laterState = await readOfficialWorkflowRunStateFixture(
      context,
      later.runId,
    );
    expect(laterState.provenance?.definitions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: firstName,
          revision: nextFirstAccepted.definition.revision,
        }),
        expect.objectContaining({
          name: secondName,
          revision: secondAccepted.definition.revision,
        }),
      ]),
    );
    expect(
      laterState.provenance?.definitions.find((definition) => {
        return definition.name === firstName;
      })?.revision,
    ).not.toBe(firstAccepted.definition.revision);
    await runs.requestCancelRun(actor, later.runId, [200, 400]);
    expect(ordinaryWorkflowId).not.toBe(firstInstallation.body.workflow.id);
  });

  it.each(["explicit and scheduled", "once", "webhook"])(
    "routes enabled result email through %s Official admission",
    async (producerKind) => {
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
        throw new Error("Expected all Official Workflow producer automations");
      }

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
        if (!explicit.body.runId) {
          throw new Error("Expected explicit Official Automation Run");
        }
        producerRuns.push({
          runId: explicit.body.runId,
          automationId: loopAutomation.id,
        });
        await completeSuccessfulRun(
          runnerGroup,
          explicit.body.runId,
          "Explicit Official result",
        );

        const scheduled = await withMockNowForTest(
          now() + 120_000,
          async () => {
            return await accept(
              automationExecutionClient().execute({
                body: { automation_id: loopAutomation.id },
              }),
              [200],
            );
          },
        );
        expect(scheduled.body.executed).toBe(1);
        const scheduledRun = await readLatestWorkflowAutomationRunFixture(
          context,
          loopAutomation.id,
        );
        if (!scheduledRun || scheduledRun.runId === explicit.body.runId) {
          throw new Error(
            "Expected a distinct scheduled Official Automation Run",
          );
        }
        producerRuns.push({
          runId: scheduledRun.runId,
          automationId: loopAutomation.id,
        });
        await completeSuccessfulRun(
          runnerGroup,
          scheduledRun.runId,
          "Scheduled Official result",
        );
      }

      if (producerKind === "once") {
        const once = await withMockNowForTest(now() + 120_000, async () => {
          return await accept(
            automationExecutionClient().execute({
              body: { automation_id: onceAutomation.id },
            }),
            [200],
          );
        });
        expect(once.body.executed).toBe(1);
        const onceRun = await readLatestWorkflowAutomationRunFixture(
          context,
          onceAutomation.id,
        );
        if (!onceRun) {
          throw new Error("Expected once Official Automation Run");
        }
        producerRuns.push({
          runId: onceRun.runId,
          automationId: onceAutomation.id,
        });
        await completeSuccessfulRun(
          runnerGroup,
          onceRun.runId,
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
        await expect
          .poll(async () => {
            return (
              await readLatestWorkflowAutomationRunFixture(
                context,
                webhookAutomation.id,
              )
            )?.runId;
          })
          .toEqual(expect.any(String));
        const webhookRun = await readLatestWorkflowAutomationRunFixture(
          context,
          webhookAutomation.id,
        );
        if (!webhookRun) {
          throw new Error("Expected Official webhook Automation Run");
        }
        producerRuns.push({
          runId: webhookRun.runId,
          automationId: webhookAutomation.id,
        });
        await completeSuccessfulRun(
          runnerGroup,
          webhookRun.runId,
          "Event Official result",
        );
      }

      const accepted = await readAcceptedDefinitionFixture(definitionName);
      for (const producer of producerRuns) {
        const state = await readOfficialWorkflowRunStateFixture(
          context,
          producer.runId,
        );
        expect(state.model_provider).toBe("built-in");
        expect(state.provenance?.definitions).toStrictEqual([
          expect.objectContaining({
            name: definitionName,
            revision: accepted.definition.revision,
          }),
        ]);
        expect(state.storage_mounts).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              org_id: SYSTEM_ORG_ID,
              user_id: VOLUME_ORG_USER_ID,
              storage_id: accepted.definition.artifact.storageId,
              version: accepted.definition.artifact.storageVersion,
            }),
          ]),
        );
        const source = await outbox.findSourceState({
          sourceRunId: producer.runId,
          sourceWorkflowAutomationId: producer.automationId,
        });
        expect(source.claim).not.toBeNull();
        expect(source.items).toStrictEqual([
          expect.objectContaining({
            public_brand: "okou",
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
    if (!sessionRun.body.runId) {
      throw new Error("Expected session Official Automation Run");
    }
    await completeSuccessfulRun(
      scenario.runnerGroup,
      sessionRun.body.runId,
      "Session-brand result",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: sessionRun.body.runId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toMatchObject({
      items: [{ public_brand: "okou" }],
      claim: { source_run_id: sessionRun.body.runId },
    });

    const agentToken = runs.okouTokenForRunWithCapabilities(
      scenario.actor,
      sessionRun.body.runId,
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
    if (!agentRun.body.runId) {
      throw new Error("Expected agent-token Official Automation Run");
    }

    mockEnv("RESEND_FROM_DOMAIN", undefined);
    await completeSuccessfulRun(
      scenario.runnerGroup,
      agentRun.body.runId,
      "Agent-token retry result",
    );
    expect(
      (await runs.readRun(scenario.actor, agentRun.body.runId)).status,
    ).toBe("completed");
    await expect(
      outbox.findSourceState({
        sourceRunId: agentRun.body.runId,
        sourceWorkflowAutomationId: scenario.automation.id,
      }),
    ).resolves.toStrictEqual({ items: [], claim: null });

    mockEnv("RESEND_FROM_DOMAIN", "mail.example.com");
    const redrive = await accept(
      automationExecutionClient().dispatchCallbacks({
        body: {
          run_id: agentRun.body.runId,
          status: "completed",
          dispatch_count: 8,
        },
      }),
      [200],
    );
    expect(redrive.body.successful_callbacks).toBeGreaterThan(0);
    const source = await outbox.findSourceState({
      sourceRunId: agentRun.body.runId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(source.claim).not.toBeNull();
    expect(source.items).toStrictEqual([
      expect.objectContaining({
        public_brand: "okou",
        source_run_id: agentRun.body.runId,
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
    if (!enabledRun.body.runId) {
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
      enabledRun.body.runId,
      "Enabled launch survives disablement",
    );
    const enabledSource = await outbox.findSourceState({
      sourceRunId: enabledRun.body.runId,
      sourceWorkflowAutomationId: scenario.automation.id,
    });
    expect(enabledSource.claim).not.toBeNull();
    expect(enabledSource.items).toStrictEqual([
      expect.objectContaining({ public_brand: "okou" }),
    ]);

    const disabledRun = await accept(
      automationClient().run({
        headers: scenario.headers,
        params: { id: scenario.automation.id },
      }),
      [201],
    );
    if (!disabledRun.body.runId) {
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
      disabledRun.body.runId,
      "Disabled launch stays ineligible",
    );
    await expect(
      outbox.findSourceState({
        sourceRunId: disabledRun.body.runId,
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
    if (!launched.body.runId) {
      throw new Error("Expected pre-uninstall Official Automation Run");
    }
    const launchedRunId = launched.body.runId;
    const beforeUninstall = await readOfficialWorkflowRunStateFixture(
      context,
      launchedRunId,
    );
    expect(beforeUninstall.provenance?.definitions).toHaveLength(1);
    expect(beforeUninstall.storage_mounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ org_id: SYSTEM_ORG_ID }),
      ]),
    );

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

  it.each(["reconciling", "needs_reconfiguration", "failed"] as const)(
    "repairs stale %s admission state",
    async (status) => {
      const { agentId, automation, headers } =
        await installStaleAdmissionScenario();
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const beforeRunFamily = await readAgentRunFamilyCountsFixture(
        context,
        agentId,
      );

      await setOfficialWorkflowAutomationAdmissionStateFixture(
        context,
        automation.id,
        status,
      );
      const admitted = await accept(
        automationClient().run({
          headers,
          params: { id: automation.id },
        }),
        [201],
      );
      if (!admitted.body.runId) {
        throw new Error(`Expected repaired ${status} Official Automation Run`);
      }
      await completeSuccessfulRun(
        runnerGroup,
        admitted.body.runId,
        `Repaired ${status} admission`,
      );
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual({
        run_count: beforeRunFamily.run_count + 1,
        callback_count: beforeRunFamily.callback_count + 2,
        runner_job_count: beforeRunFamily.runner_job_count,
        launch_queue_count: beforeRunFamily.launch_queue_count,
      });
    },
  );

  it("repairs a stale applied fingerprint and reconciles a changed release at admission", async () => {
    const {
      agentId,
      automation,
      definitionName,
      headers,
      originalFingerprint,
    } = await installStaleAdmissionScenario();
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const beforeRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    await setOfficialWorkflowAutomationAdmissionStateFixture(
      context,
      automation.id,
      "current",
      "0".repeat(64),
    );
    const repairedFingerprint = await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [201],
    );
    if (!repairedFingerprint.body.runId) {
      throw new Error("Expected repaired fingerprint Official Automation Run");
    }
    await completeSuccessfulRun(
      runnerGroup,
      repairedFingerprint.body.runId,
      "Repaired fingerprint admission",
    );
    await setOfficialWorkflowAutomationAdmissionStateFixture(
      context,
      automation.id,
      "current",
      originalFingerprint,
    );

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
    if (!reconciledRelease.body.runId) {
      throw new Error("Expected admission-time Blueprint reconciliation Run");
    }
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.id),
    ).resolves.toMatchObject({ autonomyBudget: 5, enabled: true });
    await completeSuccessfulRun(
      runnerGroup,
      reconciledRelease.body.runId,
      "Reconciled release admission",
    );
    await expect(
      readWorkflowAutomationAutonomyFixture(context, automation.id),
    ).resolves.toMatchObject({ autonomyBudget: 5, enabled: true });

    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual({
      run_count: beforeRunFamily.run_count + 2,
      callback_count: beforeRunFamily.callback_count + 4,
      runner_job_count: beforeRunFamily.runner_job_count,
      launch_queue_count: beforeRunFamily.launch_queue_count,
    });
  });

  it("creates no Run for cross-table mismatched, unresolved, or unavailable admission", async () => {
    const {
      actor,
      agentId,
      automation,
      definitionName,
      headers,
      installed,
      suffix,
    } = await installStaleAdmissionScenario();
    const ordinaryWorkflowId = await workflowBdd.createWorkflow(actor, {
      agentId,
      name: `api-test-stale-ordinary-${suffix}`,
    });
    const ordinaryAutomation = await accept(
      automationClient().create({
        headers,
        params: { workflowId: ordinaryWorkflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const beforeRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const crossTableMismatches = [
      {
        automationId: automation.id,
        mismatchedWorkflowId: ordinaryWorkflowId,
        restoredWorkflowId: installed.body.workflow.id,
      },
      {
        automationId: ordinaryAutomation.body.id,
        mismatchedWorkflowId: installed.body.workflow.id,
        restoredWorkflowId: ordinaryWorkflowId,
      },
    ];

    for (const mismatch of crossTableMismatches) {
      await retargetWorkflowAutomationFixture(
        context,
        mismatch.automationId,
        mismatch.mismatchedWorkflowId,
      );
      await assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture(
        context,
        mismatch.automationId,
        installed.body.workflow.id,
      );
      await accept(
        automationClient().run({
          headers,
          params: { id: mismatch.automationId },
        }),
        [409],
      );
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(beforeRunFamily);
      await retargetWorkflowAutomationFixture(
        context,
        mismatch.automationId,
        mismatch.restoredWorkflowId,
      );
    }

    await syncCatalog(
      catalog([activeDefinition(definitionName, [unresolvedLoopBlueprint()])]),
    );
    await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [409],
    );
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRunFamily);
    const unresolved = await accept(
      installationClient().get({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    expect(unresolved.body.workflow.automations[0]).toMatchObject({
      enabled: false,
      official: {
        intendedEnabled: true,
        reconciliationStatus: "needs_reconfiguration",
      },
    });

    await cleanupCatalog();
    await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [409],
    );
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeRunFamily);
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
    const before = await readAgentRunFamilyCountsFixture(context, agentId);

    await accept(
      automationClient().run({ headers, params: { id: pulse.id } }),
      [409],
    );
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);

    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      await accept(
        automationExecutionClient().execute({
          body: { automation_id: daily.id },
        }),
        [200],
      );
    });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);

    await withMockNowForTest(now() + 120_000, async () => {
      await accept(
        automationExecutionClient().execute({
          body: { automation_id: once.id },
        }),
        [200],
      );
    });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);

    const webhook = await postOfficialWorkflowWebhook({
      webhookUrl: webhookCredentials.body.webhookUrl,
      secret: webhookCredentials.body.webhookSecret,
      body: JSON.stringify({ event: "unresolved-official-admission" }),
    });
    expect(webhook).toMatchObject({
      status: 500,
      body: { error: "Failed to start webhook workflow run" },
    });
    await flushWaitUntilForTest();
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);
    for (const automation of [daily, pulse, once, webhookAutomation]) {
      await expect(
        readLatestWorkflowAutomationRunFixture(context, automation.id),
      ).resolves.toBeNull();
    }
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

  it("keeps a failed queued Automation admission retryable and revalidates it on redrive", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-automation-redrive-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [loopBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
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
    const automation = installed.body.workflow.automations[0];
    if (!automation) {
      throw new Error("Expected Official Automation redrive fixture");
    }
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
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();

    const active = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
      [200],
    );
    if (!active.body.runId) {
      throw new Error("Expected active Official Workflow Run");
    }
    const activeClaim = await runs.claimRunnerJob(active.body.runId);
    const queued = await accept(
      automationClient().run({
        headers,
        params: { id: automation.id },
      }),
      [201],
    );
    expect(queued.body).toMatchObject({
      runId: null,
      chatThreadId: active.body.chatThreadId,
    });
    const beforeFailedDrain = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );
    await corruptOfficialWorkflowRevisionPayloadFixture(
      context,
      definitionName,
    );
    await webhooks.requestAgentComplete(
      { runId: active.body.runId, exitCode: 1 },
      { authorization: `Bearer ${activeClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(beforeFailedDrain);
    await expect(
      readLatestWorkflowAutomationRunFixture(context, automation.id),
    ).resolves.toBeNull();

    await cleanupCatalog();
    await syncCatalog(
      catalog([
        activeDefinition(
          definitionName,
          [loopBlueprint()],
          "Repaired queued Automation Definition.",
        ),
      ]),
    );
    await setOfficialWorkflowsEnabled(actor, false);
    await withMockNowForTest(now() + 10 * 60 * 1000, async () => {
      await reconcileStaleQueuedMessages(active.body.chatThreadId);
    });
    await flushWaitUntilForTest();
    await expect
      .poll(async () => {
        return (
          await readLatestWorkflowAutomationRunFixture(context, automation.id)
        )?.runId;
      })
      .toEqual(expect.any(String));
    const redriven = await readLatestWorkflowAutomationRunFixture(
      context,
      automation.id,
    );
    if (!redriven) {
      throw new Error("Expected redriven Official Automation Run");
    }
    const accepted = await readAcceptedDefinitionFixture(definitionName);
    await expect(
      readOfficialWorkflowRunStateFixture(context, redriven.runId),
    ).resolves.toMatchObject({
      provenance: {
        definitions: [
          {
            name: definitionName,
            revision: accepted.definition.revision,
          },
        ],
      },
      runner_job_count: 1,
    });
    await runs.requestCancelRun(actor, redriven.runId, [200, 400]);
  });

  it("does not downgrade persisted Official catalog invariant failures to stale admission", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-run-invariant-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    const installed = await accept(
      officialClient().install({
        headers,
        params: { definitionName },
        body: { agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await cleanupCatalog();
      await bdd.deleteAgent(actor, agentId);
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const before = await readAgentRunFamilyCountsFixture(context, agentId);

    await corruptOfficialWorkflowRevisionPayloadFixture(
      context,
      definitionName,
    );
    await expect(
      workflowClient().run({
        headers,
        params: { workflowId: installed.body.workflow.id },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(before);
  });

  it("keeps pre-bootstrap Official source requirements fail closed without changing ordinary Workflow runs", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-bootstrap-${suffix}`;
    const ordinaryName = `api-test-ordinary-${suffix}`;
    await syncCatalog(
      catalog([activeDefinition(definitionName, [loopBlueprint()])]),
    );
    const setup = await workflowBdd.setupWorkflowOrg({
      timezone: "Asia/Shanghai",
      tier: "team",
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
      name: ordinaryName,
    });
    const install = async () => {
      return await accept(
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
    };
    let installation = await install();
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
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const initialCounts = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const directGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const directRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await directGate.read()).bootstrap_requirement;
      })
      .toStrictEqual({
        workflow_ids: [installation.body.workflow.id],
        queue_first_kind: "user_message",
        workflow_automation_id: null,
      });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await directGate.release();
    await accept(directRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialCounts);

    installation = await install();
    const automation = installation.body.workflow.automations.find(
      (candidate) => {
        return candidate.official?.blueprintKey === "pulse";
      },
    );
    if (!automation) {
      throw new Error("Expected Official Automation for bootstrap race");
    }
    const automationGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const automationRequest = automationClient().run({
      headers,
      params: { id: automation.id },
    });
    await expect
      .poll(async () => {
        return (await automationGate.read()).bootstrap_requirement;
      })
      .toStrictEqual({
        workflow_ids: [installation.body.workflow.id],
        queue_first_kind: "automation_event",
        workflow_automation_id: automation.id,
      });
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await automationGate.release();
    await accept(automationRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialCounts);

    const ordinaryGate = await installOfficialWorkflowRunGateFixture(
      context,
      "bootstrap-requirement",
    );
    const ordinary = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: ordinaryWorkflowId },
      }),
      [200],
    );
    await expect(ordinaryGate.read()).resolves.toMatchObject({ arrivals: 0 });
    await ordinaryGate.release();
    if (!ordinary.body.runId) {
      throw new Error("Expected ordinary Workflow Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, ordinary.body.runId),
    ).resolves.toMatchObject({
      status: "pending",
      provenance: null,
      runner_job_count: 1,
    });
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual({
      run_count: initialCounts.run_count + 1,
      callback_count: initialCounts.callback_count + 1,
      runner_job_count: initialCounts.runner_job_count + 1,
      launch_queue_count: initialCounts.launch_queue_count,
    });
    await runs.requestCancelRun(actor, ordinary.body.runId, [200, 400]);
  });

  it.each(officialQueueEncodings)(
    "preserves and terminalizes a queued Official source claim before draining the ordinary message behind it ($encoding $origin, persisted $storedBrand)",
    async (queueCase) => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
      const definitionName = `api-test-queued-source-${suffix}`;
      const setup = await workflowBdd.setupWorkflowOrg();
      const { actor } = setup;
      const { agentId } = await workflowBdd.createAgent(actor);
      const storage = installCatalogStorageFixture();
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
      if (!first.body.runId) {
        throw new Error("Expected first Official Workflow Run");
      }
      const firstRunId = first.body.runId;
      await expect(runs.readRun(actor, firstRunId)).resolves.toMatchObject({
        status: "pending",
      });
      await expect(
        readOfficialWorkflowRunStateFixture(context, firstRunId),
      ).resolves.toMatchObject({ runner_job_count: 1 });
      const firstClaim = await runs.claimRunnerJob(firstRunId);
      await setRunAutonomyBudgetFixture(context, firstRunId, 4);
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
      const beforeQueuedRunFamily = await readAgentRunFamilyCountsFixture(
        context,
        agentId,
      );

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

      const officialQueuedEventId = await prepareOfficialQueueEncoding({
        eventId: officialQueuedEvent.id,
        workflowId: installation.body.workflow.id,
        sourceRunId: firstRunId,
        sourceThreadId: first.body.chatThreadId,
        agentId,
        ...queueCase,
      });
      const immutableSource = await assertOfficialQueueRawHistory(
        actor,
        first.body.chatThreadId,
        officialQueuedEventId,
      );
      await assertOfficialQueueSnapshot(
        actor,
        first.body.chatThreadId,
        immutableSource,
        storage,
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

      const previousReaderBeforeResolution =
        await readChatEventRowsAsPreviousApiFixture(
          context,
          first.body.chatThreadId,
        );
      const previousReaderOfficialSource = previousReaderBeforeResolution.find(
        (event) => {
          return event.id === officialQueuedEventId;
        },
      );
      if (!previousReaderOfficialSource) {
        throw new Error("Previous API reader missed queued Official input");
      }
      expect(previousReaderOfficialSource).toMatchObject({
        event_type: "input.prompt",
        revokes_event_id: null,
      });
      expect(previousReaderOfficialSource.payload_keys).not.toContain(
        "requiredOfficialWorkflowIds",
      );

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

      await expect
        .poll(async () => {
          const events = await listOfficialQueueEvents(
            actor,
            first.body.chatThreadId,
            storage,
          );
          return events.events.filter((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === officialQueuedEventId &&
              event.error === "conflict"
            );
          }).length;
        })
        .toBe(1);
      const afterOfficialFailure = await listOfficialQueueEvents(
        actor,
        first.body.chatThreadId,
        storage,
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
      const previousReaderAfterResolution =
        await readChatEventRowsAsPreviousApiFixture(
          context,
          first.body.chatThreadId,
        );
      expect(
        previousReaderAfterResolution.find((event) => {
          return event.id === officialQueuedEventId;
        }),
      ).toMatchObject(previousReaderOfficialSource);
      expect(
        previousReaderAfterResolution.filter((event) => {
          return (
            event.event_type === "input.rejected" &&
            event.revokes_event_id === officialQueuedEventId
          );
        }),
      ).toHaveLength(1);
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(beforeQueuedRunFamily);

      await assertOfficialQueueSnapshot(
        actor,
        first.body.chatThreadId,
        immutableSource,
        storage,
      );

      const staleAt = now() + 10 * 60 * 1000;
      await withMockNowForTest(staleAt, async () => {
        await reconcileStaleQueuedMessages(first.body.chatThreadId);
      });
      await flushWaitUntilForTest();
      let ordinaryRunId: string | undefined;
      await expect
        .poll(async () => {
          const listed = await runs.listAgentRuns(actor, {
            agent: agentId,
            limit: 100,
          });
          ordinaryRunId = listed.runs.find((run) => {
            return run.prompt === ordinaryPrompt;
          })?.id;
          return ordinaryRunId;
        })
        .toStrictEqual(expect.any(String));
      if (!ordinaryRunId) {
        throw new Error("Expected ordinary queued control Run");
      }
      await expect(
        readOfficialWorkflowRunStateFixture(context, ordinaryRunId),
      ).resolves.toMatchObject({
        provenance: null,
        runner_job_count: 1,
      });
      const expectedRunFamilyAfterOrdinary = {
        run_count: beforeQueuedRunFamily.run_count + 1,
        callback_count: beforeQueuedRunFamily.callback_count + 1,
        runner_job_count: beforeQueuedRunFamily.runner_job_count + 1,
        launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
      };
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(expectedRunFamilyAfterOrdinary);

      const ordinaryClaim = await runs.claimRunnerJob(ordinaryRunId);
      await webhooks.requestAgentComplete(
        { runId: ordinaryRunId, exitCode: 1 },
        { authorization: `Bearer ${ordinaryClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const beforeLaterDrain = await readAgentRunFamilyCountsFixture(
        context,
        agentId,
      );
      await withMockNowForTest(staleAt + 10 * 60 * 1000, async () => {
        await reconcileStaleQueuedMessages(first.body.chatThreadId);
      });
      await flushWaitUntilForTest();

      const afterLaterDrain = await listOfficialQueueEvents(
        actor,
        first.body.chatThreadId,
        storage,
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
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(beforeLaterDrain);
    },
  );

  describe.each(officialQueueEncodings)(
    "keeps a queued Official source claim retryable across an unexpected persisted-revision failure ($encoding $origin, persisted $storedBrand)",
    (queueCase) => {
      async function prepareScenario() {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
        const definitionName = `api-test-queued-retry-${suffix}`;
        const setup = await workflowBdd.setupWorkflowOrg();
        const { actor } = setup;
        const { agentId } = await workflowBdd.createAgent(actor);
        const storage = installCatalogStorageFixture();
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
        return {
          headers,
          installation,
          actor,
          agentId,
          storage,
          definitionName,
        };
      }
      let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
      beforeEach(async () => {
        preparedScenario = await prepareScenario();
      });
      it("preserves the complete scenario", async () => {
        const {
          headers,
          installation,
          actor,
          agentId,
          storage,
          definitionName,
        } = preparedScenario;
        const first = await accept(
          workflowClient().run({
            headers,
            params: { workflowId: installation.body.workflow.id },
          }),
          [200],
        );
        if (!first.body.runId) {
          throw new Error("Expected first Official Workflow Run");
        }
        const firstRunId = first.body.runId;
        await expect(runs.readRun(actor, firstRunId)).resolves.toMatchObject({
          status: "pending",
        });
        await expect(
          readOfficialWorkflowRunStateFixture(context, firstRunId),
        ).resolves.toMatchObject({ runner_job_count: 1 });
        const firstClaim = await runs.claimRunnerJob(firstRunId);
        await setRunAutonomyBudgetFixture(context, firstRunId, 4);
        const queueHeaders = officialQueueHeaders(actor, firstRunId, queueCase);
        const beforeQueueEvents = await chat.listThreadEvents(
          actor,
          first.body.chatThreadId,
        );
        const beforeQueueEventIds = new Set(
          beforeQueueEvents.events.map((event) => {
            return event.id;
          }),
        );
        const beforeQueuedRunFamily = await readAgentRunFamilyCountsFixture(
          context,
          agentId,
        );

        const queued = await accept(
          workflowClient().run({
            headers: queueHeaders,
            extraHeaders: { origin: "https://app.okou.ai" },
            params: { workflowId: installation.body.workflow.id },
          }),
          [200],
        );
        expect(queued.body.runId).toBeNull();
        const afterQueued = await chat.listThreadEvents(
          actor,
          first.body.chatThreadId,
        );
        const queuedEvent = afterQueued.events.find((event) => {
          return (
            event.eventType === "input.prompt" &&
            !beforeQueueEventIds.has(event.id)
          );
        });
        if (!queuedEvent) {
          throw new Error(
            "Expected persisted retryable Official queued message",
          );
        }

        const queuedEventId = await prepareOfficialQueueEncoding({
          eventId: queuedEvent.id,
          workflowId: installation.body.workflow.id,
          sourceRunId: firstRunId,
          sourceThreadId: first.body.chatThreadId,
          agentId,
          ...queueCase,
        });
        const immutableSource = await assertOfficialQueueRawHistory(
          actor,
          first.body.chatThreadId,
          queuedEventId,
        );
        await assertOfficialQueueSnapshot(
          actor,
          first.body.chatThreadId,
          immutableSource,
          storage,
        );

        await corruptOfficialWorkflowRevisionPayloadFixture(
          context,
          definitionName,
        );
        await webhooks.requestAgentComplete(
          { runId: firstRunId, exitCode: 1 },
          { authorization: `Bearer ${firstClaim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();

        const afterUnexpectedFailure = await listOfficialQueueEvents(
          actor,
          first.body.chatThreadId,
          storage,
        );
        expect(
          afterUnexpectedFailure.events.filter((event) => {
            return event.revokesEventId === queuedEventId;
          }),
        ).toHaveLength(0);
        await expect(
          readAgentRunFamilyCountsFixture(context, agentId),
        ).resolves.toStrictEqual({
          run_count: beforeQueuedRunFamily.run_count,
          callback_count: beforeQueuedRunFamily.callback_count,
          runner_job_count: beforeQueuedRunFamily.runner_job_count,
          launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
        });

        await cleanupCatalog();
        await syncCatalog(
          catalog([
            activeDefinition(
              definitionName,
              [],
              "Execute the repaired accepted Definition content.",
            ),
          ]),
        );
        const repaired = await readAcceptedDefinitionFixture(definitionName);
        await withMockNowForTest(now() + 10 * 60 * 1000, async () => {
          await reconcileStaleQueuedMessages(first.body.chatThreadId);
        });
        await flushWaitUntilForTest();

        let retriedRunId: string | undefined;
        await expect
          .poll(async () => {
            const listed = await runs.listAgentRuns(actor, {
              agent: agentId,
              limit: 100,
            });
            retriedRunId = listed.runs.find((run) => {
              return run.id !== firstRunId;
            })?.id;
            return retriedRunId;
          })
          .toStrictEqual(expect.any(String));
        if (!retriedRunId) {
          throw new Error("Expected retried Official queued Run");
        }
        await expect(
          readOfficialWorkflowRunStateFixture(context, retriedRunId),
        ).resolves.toMatchObject({
          provenance: {
            definitions: [
              {
                name: definitionName,
                revision: repaired.definition.revision,
              },
            ],
          },
          runner_job_count: 1,
        });
        const afterRetry = await listOfficialQueueEvents(
          actor,
          first.body.chatThreadId,
          storage,
        );
        expect(
          afterRetry.events.filter((event) => {
            return (
              event.revokesEventId === queuedEventId &&
              event.runId === retriedRunId
            );
          }),
        ).toHaveLength(1);
        await expect(
          readOfficialWorkflowQueueRunFixture(retriedRunId),
        ).resolves.toStrictEqual({
          triggerSource: queueCase.origin === "agent_run" ? "agent" : "web",
          autonomyBudget: queueCase.origin === "agent_run" ? 3 : 10,
        });
        const retriedRun = await runs.readRun(actor, retriedRunId);
        if (queueCase.origin === "agent_run") {
          expect(retriedRun.appendSystemPrompt).toContain(
            `SOURCE_RUN_ID: ${firstRunId}`,
          );
          expect(retriedRun.appendSystemPrompt).toContain(
            `SOURCE_THREAD_ID: ${first.body.chatThreadId}`,
          );
        }
        await expect(
          readAgentRunFamilyCountsFixture(context, agentId),
        ).resolves.toStrictEqual({
          run_count: beforeQueuedRunFamily.run_count + 1,
          callback_count: beforeQueuedRunFamily.callback_count + 1,
          runner_job_count: beforeQueuedRunFamily.runner_job_count + 1,
          launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
        });
        const retriedClaim = await runs.claimRunnerJob(retriedRunId);
        const token = retriedClaim.platformEnvironment.OKOU_TOKEN;
        if (!token) {
          throw new Error("Expected queued Run Okou token");
        }
        expect(verifyOkouToken(token)).toMatchObject({
          userId: actor.userId,
          orgId: actor.orgId,
          runId: retriedRunId,
          capabilities: expect.arrayContaining(["agent:read"]),
        });

        await webhooks.requestAgentComplete(
          { runId: retriedRunId, exitCode: 1 },
          { authorization: `Bearer ${retriedClaim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        await assertOfficialQueueSnapshot(
          actor,
          first.body.chatThreadId,
          immutableSource,
          storage,
        );
        await withMockNowForTest(now() + 20 * 60 * 1000, async () => {
          await reconcileStaleQueuedMessages(first.body.chatThreadId);
        });
        await flushWaitUntilForTest();
        await expect(
          readAgentRunFamilyCountsFixture(context, agentId),
        ).resolves.toStrictEqual({
          run_count: beforeQueuedRunFamily.run_count + 1,
          callback_count: beforeQueuedRunFamily.callback_count + 1,
          runner_job_count: beforeQueuedRunFamily.runner_job_count,
          launch_queue_count: beforeQueuedRunFamily.launch_queue_count,
        });
      });
    },
  );

  it.each([
    {
      name: "legacy web without claim",
      encoding: "legacy",
      origin: "web",
      claim: "none",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "legacy agent without claim",
      encoding: "legacy",
      origin: "agent_run",
      claim: "none",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "canonical agent brand without claim",
      encoding: "canonical",
      origin: "agent_run",
      claim: "none",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "real source Run with claim",
      encoding: "source-run",
      origin: "agent_run",
      claim: "valid",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "arbitrary agent UUID with claim",
      encoding: "unknown",
      origin: "agent_run",
      claim: "valid",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "unknown web brand with claim",
      encoding: "unknown",
      origin: "web",
      claim: "valid",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "unsupported context with claim",
      encoding: "canonical",
      origin: "slack",
      claim: "valid",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "duplicate claim",
      encoding: "canonical",
      origin: "web",
      claim: "duplicate",
      source: "present",
      outcome: "invariant",
    },
    {
      name: "empty claim",
      encoding: "canonical",
      origin: "web",
      claim: "empty",
      source: "present",
      outcome: "storage",
    },
    {
      name: "invalid UUID claim",
      encoding: "canonical",
      origin: "web",
      claim: "invalid",
      source: "present",
      outcome: "storage",
    },
    {
      name: "legacy missing annotation",
      encoding: "legacy",
      origin: "agent_run",
      claim: "valid",
      source: "annotation-missing",
      outcome: "invariant",
    },
    {
      name: "canonical missing annotation",
      encoding: "canonical",
      origin: "agent_run",
      claim: "valid",
      source: "annotation-missing",
      outcome: "invariant",
    },
    {
      name: "legacy missing source Run",
      encoding: "legacy",
      origin: "agent_run",
      claim: "valid",
      source: "run-missing",
      outcome: "unavailable",
    },
    {
      name: "canonical missing source Run",
      encoding: "canonical",
      origin: "agent_run",
      claim: "valid",
      source: "run-missing",
      outcome: "unavailable",
    },
    {
      name: "canonical exhausted source budget",
      encoding: "canonical",
      origin: "agent_run",
      claim: "valid",
      source: "exhausted",
      outcome: "exhausted",
    },
  ] as const)(
    "fails closed for queued Official input: $name",
    async (queueCase) => {
      installCatalogStorageFixture();
      const definitionName = `api-test-queued-invalid-${randomUUID().slice(0, 8)}`;
      await syncCatalog(catalog([activeDefinition(definitionName, [])]));
      const { actor } = await workflowBdd.setupWorkflowOrg();
      const { agentId } = await workflowBdd.createAgent(actor);
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
      const firstRunId = first.body.runId;
      if (!firstRunId) {
        throw new Error("Expected active queue blocker");
      }
      const firstClaim = await runs.claimRunnerJob(firstRunId);
      const beforeQueued = await chat.listThreadEvents(
        actor,
        first.body.chatThreadId,
      );
      const beforeIds = new Set(
        beforeQueued.events.map((event) => {
          return event.id;
        }),
      );
      await accept(
        workflowClient().run({
          headers: officialQueueHeaders(actor, firstRunId, {
            origin: "agent_run",
          }),
          params: { workflowId: installation.body.workflow.id },
        }),
        [200],
      );
      const queued = (
        await chat.listThreadEvents(actor, first.body.chatThreadId)
      ).events.find((event) => {
        return event.eventType === "input.prompt" && !beforeIds.has(event.id);
      });
      if (queued?.eventType !== "input.prompt") {
        throw new Error("Expected server-annotated Official queued input");
      }
      const original = await readOfficialWorkflowQueueInputFixture(queued.id);
      const counts = await readAgentRunFamilyCountsFixture(context, agentId);
      const missingRunId = randomUUID();
      const userMessage = {
        ...queued.userMessage,
        parts: queued.userMessage.parts.flatMap<UserMessagePart>((part) => {
          if (part.type !== "source" || part.kind !== "agent") {
            return [part];
          }
          if (queueCase.source === "annotation-missing") {
            return [];
          }
          return [
            queueCase.source === "run-missing"
              ? {
                  ...part,
                  runId: missingRunId,
                  href: `/chats/${first.body.chatThreadId}#run-${missingRunId}`,
                }
              : part,
          ];
        }),
      };
      const claim =
        queueCase.claim === "none"
          ? null
          : queueCase.claim === "empty"
            ? []
            : queueCase.claim === "invalid"
              ? ["not-a-uuid"]
              : queueCase.claim === "duplicate"
                ? [installation.body.workflow.id, installation.body.workflow.id]
                : [installation.body.workflow.id];
      const append = appendOfficialWorkflowQueueInputFixture({
        eventId: queued.id,
        contextId:
          queueCase.encoding === "source-run"
            ? firstRunId
            : queueCase.encoding === "unknown"
              ? randomUUID()
              : officialQueueContextIds[queueCase.encoding].okou,
        contextType: queueCase.origin,
        claim,
        userMessage,
      });
      if (queueCase.outcome === "storage") {
        await expect(append).rejects.toMatchObject({
          cause: {
            code: queueCase.claim === "empty" ? "23514" : "22P02",
          },
        });
        await expect(
          readOfficialWorkflowQueueInputFixture(queued.id),
        ).resolves.toStrictEqual(original);
        const rows = await chat.listThreadEventRows(
          actor,
          first.body.chatThreadId,
        );
        expect(
          rows.some((row) => {
            return row.revokesEventId === queued.id;
          }),
        ).toBeFalsy();
        await expect(
          readAgentRunFamilyCountsFixture(context, agentId),
        ).resolves.toStrictEqual(counts);
        return;
      }
      const invalid = await append;
      await expect(
        readOfficialWorkflowQueueInputFixture(queued.id),
      ).resolves.toStrictEqual(original);
      if (queueCase.source === "exhausted") {
        await setRunAutonomyBudgetFixture(context, firstRunId, 0);
      }
      await webhooks.requestAgentComplete(
        { runId: firstRunId, exitCode: 1 },
        { authorization: `Bearer ${firstClaim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      await withMockNowForTest(now() + 10 * 60 * 1000, async () => {
        await reconcileStaleQueuedMessages(first.body.chatThreadId);
      });
      await flushWaitUntilForTest();
      const after = await chat.listThreadEventRows(
        actor,
        first.body.chatThreadId,
      );
      const replacements = after.filter((event) => {
        return event.revokesEventId === invalid.id;
      });
      if (queueCase.outcome === "invariant") {
        expect(replacements).toHaveLength(0);
      } else {
        expect(replacements).toHaveLength(1);
        expect(replacements[0]).toMatchObject({
          eventType: "input.rejected",
          runId: null,
          payload: {
            error:
              queueCase.outcome === "exhausted"
                ? "autonomy_budget_exhausted"
                : "autonomy_source_unavailable",
          },
        });
      }
      await expect(
        readAgentRunFamilyCountsFixture(context, agentId),
      ).resolves.toStrictEqual(counts);
    },
  );

  it("checks uninstall before both successful and retained-failure Run insertion paths", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-uninstall-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
    const headers = authHeaders(actor);
    await setOfficialWorkflowsEnabled(actor, true);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const install = async () => {
      return await accept(
        officialClient().install({
          headers,
          params: { definitionName },
          body: { agentId, blueprints: [] },
        }),
        [201],
      );
    };
    let installation = await install();
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    const initialRunFamily = await readAgentRunFamilyCountsFixture(
      context,
      agentId,
    );

    const normalGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const normalRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await normalGate.read()).arrivals;
      })
      .toBe(1);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await normalGate.release();
    await accept(normalRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialRunFamily);

    installation = await install();
    const acceptedDefinition =
      await readAcceptedDefinitionFixture(definitionName);
    await accept(
      storageClient().action({
        body: {
          action: "cleanup-owned-storage-cache",
          storage_id: acceptedDefinition.definition.artifact.storageId,
        },
      }),
      [200],
    );
    context.mocks.s3.getSignedUrl.mockRejectedValue(
      new Error("unrelated presign failure after Official resolution"),
    );
    const failedGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const failedRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await failedGate.read()).arrivals;
      })
      .toBe(1);
    await accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await failedGate.release();
    await accept(failedRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, agentId),
    ).resolves.toStrictEqual(initialRunFamily);

    installation = await install();
    const retainedFailure = await accept(
      workflowClient().run({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [200],
    );
    if (!retainedFailure.body.runId) {
      throw new Error("Expected retained unrelated-failure Run");
    }
    const failedState = await readOfficialWorkflowRunStateFixture(
      context,
      retainedFailure.body.runId,
    );
    expect(failedState).toMatchObject({
      status: "failed",
      runner_job_count: 0,
      callback_count: 1,
      storage_mounts: null,
      provenance: {
        definitions: [expect.objectContaining({ name: definitionName })],
      },
    });
  });

  it("serializes Run-first uninstall after exact Run persistence", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-run-first-${suffix}`;
    await syncCatalog(catalog([activeDefinition(definitionName, [])]));
    const setup = await workflowBdd.setupWorkflowOrg();
    const { actor } = setup;
    if (!actor.orgId) {
      throw new Error("Expected organization-scoped actor");
    }
    const { agentId } = await workflowBdd.createAgent(actor);
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
      await bdd.deleteAgent(actor, agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const gate = await installOfficialWorkflowRunGateFixture(
      context,
      "final-admission",
    );
    const runRequest = workflowClient().run({
      headers,
      params: { workflowId: installation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return await gate.read();
      })
      .toMatchObject({ arrivals: 1, shared_catalog_holder_count: 1 });
    const uninstallRequest = accept(
      installationClient().uninstall({
        headers,
        params: { workflowId: installation.body.workflow.id },
      }),
      [204],
    );
    await expect
      .poll(async () => {
        return (await gate.read()).blocked_waiter_count;
      })
      .toBe(1);
    await gate.release();
    const run = await accept(runRequest, [200]);
    await uninstallRequest;
    if (!run.body.runId) {
      throw new Error("Expected Run-first Official Workflow Run");
    }
    await expect(
      readOfficialWorkflowRunStateFixture(context, run.body.runId),
    ).resolves.toMatchObject({
      status: "pending",
      provenance: {
        definitions: [expect.objectContaining({ name: definitionName })],
      },
    });
    await runs.requestCancelRun(actor, run.body.runId, [200, 400]);
  });

  it("admits cross-org Runs concurrently under the shared catalog lock and rejects a superseded observation", async () => {
    installCatalogStorageFixture();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const definitionName = `api-test-shared-lock-${suffix}`;
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision one"),
      ]),
    );
    const original = await readAcceptedDefinitionFixture(definitionName);
    const firstSetup = await workflowBdd.setupWorkflowOrg();
    const secondSetup = await workflowBdd.setupWorkflowOrg();
    const firstActor = firstSetup.actor;
    const secondActor = secondSetup.actor;
    if (!firstActor.orgId || !secondActor.orgId) {
      throw new Error("Expected organization-scoped actors");
    }
    const firstAgent = await workflowBdd.createAgent(firstActor);
    const secondAgent = await workflowBdd.createAgent(secondActor);
    await setOfficialWorkflowsEnabled(firstActor, true);
    await setOfficialWorkflowsEnabled(secondActor, true);
    const firstHeaders = authHeaders(firstActor);
    const firstInstallation = await accept(
      officialClient().install({
        headers: firstHeaders,
        params: { definitionName },
        body: { agentId: firstAgent.agentId, blueprints: [] },
      }),
      [201],
    );
    const secondHeaders = authHeaders(secondActor);
    await accept(
      officialClient().install({
        headers: secondHeaders,
        params: { definitionName },
        body: { agentId: secondAgent.agentId, blueprints: [] },
      }),
      [201],
    );
    onTestFinished(async () => {
      installCatalogStorageFixture();
      await bdd.deleteAgent(firstActor, firstAgent.agentId);
      await bdd.deleteAgent(secondActor, secondAgent.agentId);
      await cleanupCatalog();
    });
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const sharedGate = await installOfficialWorkflowRunGateFixture(
      context,
      "final-admission",
    );
    const firstRunPromise = runs.createRun(firstActor, {
      agentId: firstAgent.agentId,
      prompt: "hold the first shared Official admission",
    });
    await expect
      .poll(async () => {
        return (await sharedGate.read()).arrivals;
      })
      .toBe(1);
    const secondRunPromise = runs.createRun(secondActor, {
      agentId: secondAgent.agentId,
      prompt: "hold the second shared Official admission",
    });
    await expect
      .poll(async () => {
        return await sharedGate.read();
      })
      .toMatchObject({ arrivals: 2, shared_catalog_holder_count: 2 });

    const activation = syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision two"),
      ]),
    );
    await expect
      .poll(async () => {
        return (await sharedGate.read()).exclusive_catalog_waiter_count;
      })
      .toBe(1);
    await sharedGate.release();
    const [firstRun, secondRun] = await Promise.all([
      firstRunPromise,
      secondRunPromise,
    ]);
    await activation;
    for (const runId of [firstRun.runId, secondRun.runId]) {
      await expect(
        readOfficialWorkflowRunStateFixture(context, runId),
      ).resolves.toMatchObject({
        provenance: {
          definitions: [
            expect.objectContaining({
              name: definitionName,
              revision: original.definition.revision,
            }),
          ],
        },
      });
    }

    const beforeRace = await readAgentRunFamilyCountsFixture(
      context,
      firstAgent.agentId,
    );
    const raceGate = await installOfficialWorkflowRunGateFixture(
      context,
      "observation",
    );
    const staleRequest = workflowClient().run({
      headers: authHeaders(firstActor),
      params: { workflowId: firstInstallation.body.workflow.id },
    });
    await expect
      .poll(async () => {
        return (await raceGate.read()).arrivals;
      })
      .toBe(1);
    await syncCatalog(
      catalog([
        activeDefinition(definitionName, [], "shared-lock revision three"),
      ]),
    );
    await raceGate.release();
    await accept(staleRequest, [409]);
    await expect(
      readAgentRunFamilyCountsFixture(context, firstAgent.agentId),
    ).resolves.toStrictEqual(beforeRace);
    await runs.requestCancelRun(firstActor, firstRun.runId, [200, 400]);
    await runs.requestCancelRun(secondActor, secondRun.runId, [200, 400]);
  });
});
