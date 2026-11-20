import { mockOAuthCompletions } from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowAutomationsContract,
  type WorkflowAutomationCreateRequest,
  type WorkflowAutomationUpdateRequest,
  type WorkflowUpdateRequest,
  type WorkflowDetailResponse,
  type WorkflowSummary,
  type WorkflowAutomationSummary,
  type GoogleCalendarAutomationEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi, type Mock } from "vitest";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();
const CURRENT_USER_ID = "test-user-123";
const UPDATED_USER_ID = "test-user-456";
const AGENT_ID = "c0000000-0000-4000-a000-000000000101";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000102";
const SALES_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const OPS_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000202";
const OTHER_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000203";

const COPIED_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000205";

const GMAIL_AUTOMATION_ID = "workflow-automation-gmail-new-message";
const GMAIL_LABEL_AUTOMATION_ID = "workflow-automation-gmail-label-applied";
const GITHUB_PULL_REQUEST_AUTOMATION_ID =
  "workflow-automation-github-pull-request";
const GOOGLE_CALENDAR_AUTOMATION_ID =
  "workflow-automation-google-calendar-created";
const GOOGLE_MEET_AUTOMATION_ID = "workflow-automation-google-meet-transcript";
const WORKFLOW_CHAT_THREAD_ID = "00000000-0000-4000-a000-000000000300";
const AUTOMATION_RUN_THREAD_ID = "00000000-0000-4000-a000-000000000301";

type WorkflowDetailTestTab = "automations" | "instructions" | "info";

function workflowDetailPath(tab: WorkflowDetailTestTab): string {
  return `/workflows/${SALES_WORKFLOW_ID}/${tab}`;
}

function setupWorkflowDetailPage(
  path: string,
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
  billingTier = "team",
  billingCapabilities: Partial<BillingStatusResponse> = {},
) {
  mockBillingTier(billingTier, billingCapabilities);
  return setupPage({
    context,
    path,
    featureSwitches: {
      ...featureSwitches,
    },
  });
}

function installScrollIntoViewMock(): Mock<HTMLElement["scrollIntoView"]> {
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

function billingStatus(
  tier: string,
  capabilities: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier,
    ...billingPlanCapabilities(tier),
    credits: 20_000,
    onboardingPaymentPending: false,
    subscriptionStatus: tier === "team" ? "active" : null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: tier === "pro" || tier === "team",
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
    ...capabilities,
  };
}

function mockBillingTier(
  tier: string,
  capabilities: Partial<BillingStatusResponse> = {},
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier, capabilities));
  });
}

async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

async function expectComposerText(text: string): Promise<void> {
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor.textContent).toContain(text);
  });
}

type WorkflowScheduleAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "schedule" }
>;
type WorkflowGmailNewMessageAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "gmail-new-message" }
>;
type WorkflowWebhookAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "webhook-received" }
>;
type WorkflowGmailLabelAppliedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "gmail-label-applied" }
>;
type WorkflowGithubPullRequestAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "github-pull-request" }
>;
type WorkflowGoogleCalendarEventCreatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-created" }
>;
type WorkflowGoogleCalendarEventUpdatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-updated" }
>;
type WorkflowGoogleCalendarEventCancelledAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-cancelled" }
>;
type WorkflowGoogleCalendarAutomationSummary =
  | WorkflowGoogleCalendarEventCreatedAutomationSummary
  | WorkflowGoogleCalendarEventUpdatedAutomationSummary
  | WorkflowGoogleCalendarEventCancelledAutomationSummary;
type WorkflowGoogleFormsResponseSubmittedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "google-forms-response-submitted" }
>;
type WorkflowGoogleMeetTranscriptGeneratedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "google-meet-transcript-generated" }
>;
type WorkflowNotionChildPageCreatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-child-page-created" }
>;
type WorkflowNotionDatabaseItemCreatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-database-item-created" }
>;
type WorkflowNotionPageContentUpdatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-page-content-updated" }
>;

function workflowAutomations(): WorkflowAutomationSummary[] {
  return [weekdayWorkflowAutomation()];
}

function weekdayWorkflowAutomation(): WorkflowScheduleAutomationSummary {
  return {
    id: "workflow-automation-weekday-brief",
    kind: "schedule",
    schedule: {
      type: "cron",
      cronExpression: "0 9 * * 1-5",
      timezone: "UTC",
    },
    scheduleSummary: "Weekdays at 9:00 AM",
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_weekday_brief",
    nextRunAt: "2026-06-19T01:00:00.000Z",
    lastRunAt: "2026-06-18T01:00:00.000Z",
    official: null,
  };
}

function gmailWorkflowAutomation(): WorkflowGmailNewMessageAutomationSummary {
  return {
    id: GMAIL_AUTOMATION_ID,
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: {
      provider: "gmail",
      event: "new_message",
      match: {
        from: { contains: "@acme.com" },
        subject: { doesNotContain: "newsletter" },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_new_message",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function gmailLabelWorkflowAutomation(): WorkflowGmailLabelAppliedAutomationSummary {
  return {
    id: GMAIL_LABEL_AUTOMATION_ID,
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: {
      provider: "gmail",
      event: "label_applied",
      labelName: "Support",
      resolvedLabelId: "Label_support",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_label_applied",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function githubPullRequestWorkflowAutomation(): WorkflowGithubPullRequestAutomationSummary {
  return {
    id: GITHUB_PULL_REQUEST_AUTOMATION_ID,
    kind: "event",
    eventType: "github-pull-request",
    eventConfig: {
      provider: "github",
      event: "pull_request",
      repository: "okou-ai/okou",
      action: "closed",
      merged: true,
      filters: {},
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_github_pull_request",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function googleCalendarWorkflowAutomation(
  overrides: Partial<WorkflowGoogleCalendarEventCreatedAutomationSummary> = {},
): WorkflowGoogleCalendarEventCreatedAutomationSummary {
  return {
    id: GOOGLE_CALENDAR_AUTOMATION_ID,
    kind: "event",
    eventType: "google-calendar-event-created",
    eventConfig: {
      provider: "google-calendar",
      event: "event_created",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_created",
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
    official: null,
  };
}

function googleCalendarUpdatedWorkflowAutomation(
  overrides: Partial<WorkflowGoogleCalendarEventUpdatedAutomationSummary> = {},
): WorkflowGoogleCalendarEventUpdatedAutomationSummary {
  return {
    id: "workflow-automation-google-calendar-updated",
    kind: "event",
    eventType: "google-calendar-event-updated",
    eventConfig: {
      provider: "google-calendar",
      event: "event_updated",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_updated",
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
    official: null,
  };
}

function googleCalendarCancelledWorkflowAutomation(
  overrides: Partial<WorkflowGoogleCalendarEventCancelledAutomationSummary> = {},
): WorkflowGoogleCalendarEventCancelledAutomationSummary {
  return {
    id: "workflow-automation-google-calendar-cancelled",
    kind: "event",
    eventType: "google-calendar-event-cancelled",
    eventConfig: {
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_cancelled",
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
    official: null,
  };
}

function googleMeetTranscriptGeneratedWorkflowAutomation(): WorkflowGoogleMeetTranscriptGeneratedAutomationSummary {
  return {
    id: GOOGLE_MEET_AUTOMATION_ID,
    kind: "event",
    eventType: "google-meet-transcript-generated",
    eventConfig: {
      provider: "google-meet",
      event: "transcript_generated",
      scope: { type: "organizer_user" },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_meet_transcript_generated",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function googleFormsResponseSubmittedWorkflowAutomation(
  warning?: string,
): WorkflowGoogleFormsResponseSubmittedAutomationSummary {
  return {
    id: "workflow-automation-google-forms-response-submitted",
    kind: "event",
    eventType: "google-forms-response-submitted",
    eventConfig: {
      provider: "google-forms",
      event: "response_submitted",
      connectorId: "00000000-0000-4000-a000-000000000412",
      form: {
        id: "1FAIpQLScGoogleFormsAutomationTest",
        title: "Customer feedback",
        url: "https://docs.google.com/forms/d/1FAIpQLScGoogleFormsAutomationTest/edit",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_forms_response_submitted",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
    ...(warning ? { warning } : {}),
  };
}

function notionChildPageWorkflowAutomation(): WorkflowNotionChildPageCreatedAutomationSummary {
  return {
    id: "workflow-automation-notion-child-page",
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: "00000000-0000-4000-a000-000000000410",
      parentPage: {
        id: "11111111-1111-4111-8111-111111111111",
        url: "https://www.notion.so/Roadmap-11111111111141118111111111111111",
        title: "Roadmap",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_child_page",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function notionDatabaseItemWorkflowAutomation(): WorkflowNotionDatabaseItemCreatedAutomationSummary {
  return {
    id: "workflow-automation-notion-database-item",
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: "00000000-0000-4000-a000-000000000410",
      dataSource: {
        id: "22222222-2222-4222-8222-222222222222",
        url: "https://www.notion.so/Bug-Bash-22222222222242228222222222222222",
        title: "Bug Bash",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_database_item",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function notionPageContentUpdatedWorkflowAutomation(): WorkflowNotionPageContentUpdatedAutomationSummary {
  return {
    id: "workflow-automation-notion-page-content-updated",
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: "00000000-0000-4000-a000-000000000410",
      scope: {
        type: "page",
        page: {
          id: "33333333-3333-4333-8333-333333333333",
          url: "https://www.notion.so/Release-plan-33333333333343338333333333333333",
          title: "Release plan",
        },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_page_content_updated",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
  };
}

function webhookWorkflowAutomation(): WorkflowWebhookAutomationSummary {
  return {
    id: "workflow-automation-webhook",
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_webhook",
    nextRunAt: null,
    lastRunAt: null,
    official: null,
    webhookUrl:
      "https://api.okou.test/api/webhooks/workflow-automations/whk_test",
    secretLastFour: "abcd",
    lastReceivedAt: null,
  };
}

function publicWorkflowAutomation(
  automation: WorkflowAutomationSummary,
): WorkflowAutomationSummary {
  if (
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received"
  ) {
    return automation;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = automation;
  return rest;
}

function publicWorkflowDetail(
  detail: WorkflowDetailResponse,
): WorkflowDetailResponse {
  return {
    ...detail,
    automations: detail.automations.map(publicWorkflowAutomation),
  };
}

function salesResearch(): WorkflowDetailResponse {
  return {
    id: SALES_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    visibility: "public",
    official: null,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: false,
    importSource: null,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: UPDATED_USER_ID,
    createdAt: "2026-06-17T13:52:00.000Z",
    updatedAt: "2026-06-20T14:16:00.000Z",
    instruction: "Gather CRM context before outreach.",
    files: [
      { path: "examples/prompt.md", size: 1536 },
      { path: "config/settings.json", size: 32 },
    ],
    fileContents: [
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
      {
        path: "config/settings.json",
        content: '{ "risk": "low", "tone": "direct" }',
      },
    ],
    automations: workflowAutomations(),
  };
}

function opsPlaybook(): WorkflowDetailResponse {
  return {
    id: OPS_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "ops-playbook",
    displayName: "Ops Playbook",
    description: null,
    visibility: "private",
    official: null,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: true,
    importSource: null,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-15T12:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
    instruction: null,
    files: [],
    fileContents: [],
    automations: [],
  };
}

function otherAgentWorkflow(): WorkflowDetailResponse {
  return {
    id: OTHER_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    name: "support-intake",
    displayName: "Support Intake",
    description: "Sorts incoming support requests.",
    visibility: "public",
    official: null,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: false,
    importSource: null,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-16T12:00:00.000Z",
    updatedAt: "2026-06-16T12:00:00.000Z",
    instruction: null,
    files: [],
    fileContents: [],
    automations: [],
  };
}

function agent(id: string, displayName: string): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId: id,
    ownerId: CURRENT_USER_ID,
    displayName,
    description: "Finds and summarizes information",
    sound: null,
    avatarUrl: null,
    visibility: "public",
  };
}

function summary(workflow: WorkflowDetailResponse): WorkflowSummary {
  return {
    id: workflow.id,
    agentId: workflow.agentId,
    agentName: workflow.agentName,
    agentDisplayName: workflow.agentDisplayName,
    name: workflow.name,
    displayName: workflow.displayName,
    description: workflow.description,
    visibility: workflow.visibility,
    ownerUserId: workflow.ownerUserId,
    createdAt: workflow.createdAt,
    canManage: workflow.canManage,
    canPublish: workflow.canPublish,
    shadowedBy: workflow.shadowedBy,
    official: workflow.official,
    importSource: workflow.importSource,
  };
}

function mockAgentPageApis(): void {
  context.mocks.data.agents([
    agent(AGENT_ID, "Research Bot"),
    agent(OTHER_AGENT_ID, "Support Bot"),
  ]);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const displayName =
      params.id === OTHER_AGENT_ID ? "Support Bot" : "Research Bot";
    return respond(200, {
      isDefaultAgent: false,
      agentId: params.id,
      ownerId: CURRENT_USER_ID,
      description: "Finds and summarizes information",
      displayName,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    });
  });
}

function applyWorkflowUpdate(
  workflow: WorkflowDetailResponse,
  body: WorkflowUpdateRequest,
): WorkflowDetailResponse {
  return {
    ...workflow,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.instruction !== undefined
      ? { instruction: body.instruction }
      : {}),
    ...(body.displayName !== undefined
      ? { displayName: body.displayName }
      : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.files !== undefined
      ? {
          files: body.files.map((file) => {
            return { path: file.path, size: file.content.length };
          }),
          fileContents: body.files,
        }
      : {}),
    updatedByUserId: CURRENT_USER_ID,
    updatedAt: "2026-06-21T12:00:00.000Z",
  };
}

function mockWorkflowApis(
  workflows: WorkflowDetailResponse[],
  onUpdate?: (body: WorkflowUpdateRequest) => void,
): void {
  const setAutomationEnabled = (
    automationId: string,
    enabled: boolean,
  ): WorkflowAutomationSummary | null => {
    for (const workflow of workflows) {
      const automationIndex = workflow.automations.findIndex((automation) => {
        return automation.id === automationId;
      });
      if (automationIndex === -1) {
        continue;
      }
      const currentAutomation = workflow.automations[automationIndex];
      if (!currentAutomation) {
        continue;
      }
      const updatedAutomation = { ...currentAutomation, enabled };
      workflow.automations[automationIndex] = updatedAutomation;
      return updatedAutomation;
    }
    return null;
  };

  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, { displayName: "Test User", imageUrl: null });
  });
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    const visible = query.agentId
      ? workflows.filter((workflow) => {
          return workflow.agentId === query.agentId;
        })
      : workflows;
    return respond(200, visible.map(summary));
  });
  context.mocks.api(workflowsDetailContract.get, ({ params, respond }) => {
    const detail = workflows.find((workflow) => {
      return workflow.id === params.workflowId;
    });
    if (!detail) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    }
    const publicDetail = publicWorkflowDetail(detail);
    return respond(200, publicDetail);
  });
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(
        200,
        workflows.flatMap((workflow) => {
          return workflow.automations.map((automation) => {
            return {
              workflow: summary(workflow),
              automation: publicWorkflowAutomation(automation),
            };
          });
        }) as never,
      );
    },
  );
  context.mocks.api(
    workflowAutomationsContract.revealWebhookSecret,
    ({ params, respond }) => {
      const automation = workflows
        .flatMap((workflow) => {
          return workflow.automations;
        })
        .find((item) => {
          return item.id === params.id;
        });
      if (
        automation &&
        automation.kind === "event" &&
        automation.eventType === "webhook-received"
      ) {
        return respond(200, {
          webhookUrl:
            automation.webhookUrl ??
            "https://api.okou.test/api/webhooks/workflow-automations/whk_test",
          webhookSecret: automation.webhookSecret ?? "webhook-secret",
        });
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    },
  );
  context.mocks.api(
    workflowAutomationsContract.enable,
    ({ params, respond }) => {
      const automation = setAutomationEnabled(params.id, true);
      if (!automation) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, automation);
    },
  );
  context.mocks.api(
    workflowAutomationsContract.disable,
    ({ params, respond }) => {
      const automation = setAutomationEnabled(params.id, false);
      if (!automation) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, automation);
    },
  );
  context.mocks.api(
    workflowsDetailContract.update,
    ({ params, body, respond }) => {
      const index = workflows.findIndex((workflow) => {
        return workflow.id === params.workflowId;
      });
      if (index === -1) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      onUpdate?.(body);
      const workflow = workflows[index];
      workflows[index] = applyWorkflowUpdate(workflow, body);
      return respond(200, workflows[index]);
    },
  );
}

function mockDeleteWorkflow(
  workflows: WorkflowDetailResponse[],
  onDelete: (workflowId: string) => void | Promise<void>,
): void {
  context.mocks.api(
    workflowsDetailContract.delete,
    async ({ params, respond }) => {
      await onDelete(params.workflowId);
      const index = workflows.findIndex((workflow) => {
        return workflow.id === params.workflowId;
      });
      if (index !== -1) {
        workflows.splice(index, 1);
      }
      return respond(204);
    },
  );
}

function mockConfiguredEventAutomation(
  body: Extract<WorkflowAutomationCreateRequest, { readonly kind: "event" }>,
): WorkflowAutomationSummary {
  return {
    ...gmailWorkflowAutomation(),
    eventType: body.eventType,
    eventConfig: body.eventConfig,
  } as WorkflowAutomationSummary;
}

function mockGoogleCalendarEventAutomation(
  body: Extract<WorkflowAutomationCreateRequest, { readonly kind: "event" }>,
): WorkflowAutomationSummary {
  switch (body.eventType) {
    case "google-calendar-event-created": {
      return {
        ...googleCalendarWorkflowAutomation(),
        eventConfig: body.eventConfig,
      };
    }
    case "google-calendar-event-updated": {
      return {
        ...googleCalendarUpdatedWorkflowAutomation(),
        eventConfig: body.eventConfig,
      };
    }
    case "google-calendar-event-cancelled": {
      return {
        ...googleCalendarCancelledWorkflowAutomation(),
        eventConfig: body.eventConfig,
      };
    }
    default: {
      throw new Error("Expected a Google Calendar event automation");
    }
  }
}

function mockCreateWorkflowAutomation(
  onCreate: (body: WorkflowAutomationCreateRequest) => void,
): void {
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    onCreate(body);
    if (body.kind !== "event") {
      return respond(201, weekdayWorkflowAutomation());
    }
    if (body.eventType === "webhook-received") {
      return respond(201, {
        ...webhookWorkflowAutomation(),
        eventConfig:
          body.eventConfig ?? webhookWorkflowAutomation().eventConfig,
        webhookSecret: "webhook-secret",
      });
    }
    if (body.eventType === "gmail-label-applied") {
      return respond(201, {
        ...gmailLabelWorkflowAutomation(),
        eventConfig: body.eventConfig,
      });
    }
    if (body.eventType === "github-pull-request") {
      return respond(201, {
        ...githubPullRequestWorkflowAutomation(),
        eventConfig: body.eventConfig,
      });
    }
    if (body.eventType === "github-workflow-run-completed") {
      return respond(201, {
        ...githubPullRequestWorkflowAutomation(),
        eventType: "github-workflow-run-completed",
        eventConfig: body.eventConfig,
      });
    }
    if (body.eventConfig.provider === "google-calendar") {
      return respond(201, mockGoogleCalendarEventAutomation(body));
    }
    if (body.eventType === "google-meet-transcript-generated") {
      return respond(201, {
        ...googleMeetTranscriptGeneratedWorkflowAutomation(),
        eventConfig: body.eventConfig,
      });
    }
    if (body.eventType === "notion-child-page-created") {
      return respond(201, {
        ...notionChildPageWorkflowAutomation(),
        eventConfig: {
          provider: "notion",
          event: "child_page_created",
          connectorId: "00000000-0000-4000-a000-000000000410",
          parentPage: {
            id: "11111111-1111-4111-8111-111111111111",
            url: body.eventConfig.parentPageUrl,
            title: "Roadmap",
            rawUrl: body.eventConfig.parentPageUrl,
          },
        },
      });
    }
    if (body.eventType === "notion-database-item-created") {
      return respond(201, {
        ...notionDatabaseItemWorkflowAutomation(),
        eventConfig: {
          provider: "notion",
          event: "database_item_created",
          connectorId: "00000000-0000-4000-a000-000000000410",
          dataSource: {
            id: "22222222-2222-4222-8222-222222222222",
            url: body.eventConfig.databaseUrl,
            title: "Bug Bash",
            rawUrl: body.eventConfig.databaseUrl,
          },
        },
      });
    }
    if (body.eventType === "notion-page-content-updated") {
      return respond(201, {
        ...notionPageContentUpdatedWorkflowAutomation(),
        eventConfig: {
          provider: "notion",
          event: "page_content_updated",
          connectorId: "00000000-0000-4000-a000-000000000410",
          scope: body.eventConfig.pageUrl
            ? {
                type: "page",
                page: {
                  id: "33333333-3333-4333-8333-333333333333",
                  url: body.eventConfig.pageUrl,
                  title: "Release plan",
                  rawUrl: body.eventConfig.pageUrl,
                },
              }
            : {
                type: "data_source",
                dataSource: {
                  id: "22222222-2222-4222-8222-222222222222",
                  url: body.eventConfig.databaseUrl ?? "",
                  title: "Bug Bash",
                  rawUrl: body.eventConfig.databaseUrl,
                },
              },
        },
      });
    }
    if (
      body.eventConfig.provider === "github" ||
      body.eventConfig.provider === "google-forms" ||
      body.eventConfig.provider === "chat"
    ) {
      return respond(201, mockConfiguredEventAutomation(body));
    }
    return respond(201, {
      ...gmailWorkflowAutomation(),
      eventConfig: body.eventConfig,
    });
  });
}

function mockUpdateWorkflowAutomation(
  onUpdate: (
    automationId: string,
    body: WorkflowAutomationUpdateRequest,
  ) => void,
): void {
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ params, body, respond }) => {
      onUpdate(params.id, body);
      if ("eventConfig" in body) {
        if (body.eventConfig.provider === "github") {
          if (body.eventConfig.event === "workflow_run_completed") {
            return respond(200, {
              ...githubPullRequestWorkflowAutomation(),
              id: params.id,
              eventType: "github-workflow-run-completed",
              eventConfig: body.eventConfig,
            });
          }
          if (body.eventConfig.event !== "pull_request") {
            return respond(200, {
              ...githubPullRequestWorkflowAutomation(),
              id: params.id,
              eventType:
                body.eventConfig.event === "workflow_job_completed"
                  ? "github-workflow-job-completed"
                  : body.eventConfig.event === "pull_request_review_submitted"
                    ? "github-pull-request-review-submitted"
                    : body.eventConfig.event === "deployment_status_created"
                      ? "github-deployment-status-created"
                      : "github-issue-comment-created",
              eventConfig: body.eventConfig,
            } as WorkflowAutomationSummary);
          }
          return respond(200, {
            ...githubPullRequestWorkflowAutomation(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        if (body.eventConfig.provider === "google-calendar") {
          const automation =
            body.eventConfig.event === "event_created"
              ? googleCalendarWorkflowAutomation()
              : body.eventConfig.event === "event_updated"
                ? googleCalendarUpdatedWorkflowAutomation()
                : googleCalendarCancelledWorkflowAutomation();
          return respond(200, {
            ...automation,
            id: params.id,
            eventConfig: body.eventConfig,
          } as WorkflowAutomationSummary);
        }
        if (body.eventConfig.event === "label_applied") {
          return respond(200, {
            ...gmailLabelWorkflowAutomation(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        return respond(200, {
          ...gmailWorkflowAutomation(),
          id: params.id,
          eventConfig: body.eventConfig,
        });
      }
      return respond(200, {
        ...weekdayWorkflowAutomation(),
        id: params.id,
        schedule: body.schedule,
      });
    },
  );
}

function applyGoogleCalendarAutomationUpdate(
  automation: WorkflowAutomationSummary,
  eventConfig: GoogleCalendarAutomationEventConfig,
): WorkflowGoogleCalendarAutomationSummary {
  switch (eventConfig.event) {
    case "event_created": {
      if (
        automation.kind !== "event" ||
        automation.eventType !== "google-calendar-event-created"
      ) {
        throw new Error("Expected a Google Calendar event-created automation");
      }
      const { warning: _warning, ...rest } = automation;
      return { ...rest, eventConfig };
    }
    case "event_updated": {
      if (
        automation.kind !== "event" ||
        automation.eventType !== "google-calendar-event-updated"
      ) {
        throw new Error("Expected a Google Calendar event-updated automation");
      }
      const { warning: _warning, ...rest } = automation;
      return { ...rest, eventConfig };
    }
    case "event_cancelled": {
      if (
        automation.kind !== "event" ||
        automation.eventType !== "google-calendar-event-cancelled"
      ) {
        throw new Error(
          "Expected a Google Calendar event-cancelled automation",
        );
      }
      const { warning: _warning, ...rest } = automation;
      return { ...rest, eventConfig };
    }
  }
}

function googleCalendarAccount(args: {
  readonly id: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly externalUsername: string;
  readonly status?: ConnectorAccountConnection["connectionStatus"];
}): ConnectorAccountConnection {
  return {
    id: args.id,
    target: { kind: "builtin", connectorSlug: "google-calendar" },
    authMethod: "oauth",
    displayName: args.displayName,
    isDefault: args.isDefault,
    externalId: null,
    externalUsername: args.externalUsername,
    externalEmail: `${args.externalUsername}@example.com`,
    oauthScopes: [],
    scopeMismatch: false,
    connectionStatus: args.status ?? "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason:
      args.status === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function mockRunWorkflowAutomation(
  onRun: (automationId: string) => void,
): void {
  context.mocks.api(workflowAutomationsContract.run, ({ params, respond }) => {
    onRun(params.id);
    return respond(201, {
      runId: null,
      chatThreadId: AUTOMATION_RUN_THREAD_ID,
    });
  });
}

function mockDisableWorkflowAutomation(
  onDisable: (automationId: string) => void,
): void {
  context.mocks.api(
    workflowAutomationsContract.disable,
    ({ params, respond }) => {
      onDisable(params.id);
      return respond(200, {
        ...weekdayWorkflowAutomation(),
        id: params.id,
        enabled: false,
      });
    },
  );
}

function mockOpenWorkflowChat(onOpen: (workflowId: string) => void): void {
  context.mocks.api(
    workflowsDetailContract.chatThread,
    ({ params, respond }) => {
      onOpen(params.workflowId);
      return respond(200, {
        chatThreadId: WORKFLOW_CHAT_THREAD_ID,
        prompt: "help me refine the workflow /sales-research",
      });
    },
  );
}

type RoleTextMatch = RegExp | string;

function textFor(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function valueMatchesText(value: string, text: RoleTextMatch): boolean {
  return typeof text === "string" ? value === text : text.test(value);
}

function matchesText(element: Element, text: RoleTextMatch): boolean {
  const label = element.getAttribute("aria-label") ?? "";
  return [textFor(element), label].some((value) => {
    return value.length > 0 && valueMatchesText(value, text);
  });
}

function matchLabel(text: RoleTextMatch): string {
  return typeof text === "string" ? text : text.toString();
}

function buttonByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`${matchLabel(text)} button not found`);
  }
  return button;
}

function queryButtonByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement | null {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return matchesText(candidate, text);
  });
  return button ?? null;
}

function linkByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement {
  const links = queryAllByRoleFast("link", container);
  const link = links.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!link) {
    throw new Error(`${matchLabel(text)} link not found`);
  }
  return link;
}

function menuItemByText(text: RoleTextMatch): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!item) {
    throw new Error(`${matchLabel(text)} menu item not found`);
  }
  return item;
}

function workflowFileItemByText(text: RoleTextMatch): HTMLElement {
  const item = queryAllByRoleFast("menuitemradio").find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!item) {
    throw new Error(`${matchLabel(text)} workflow file item not found`);
  }
  return item;
}

// The "Add automation" automation picker is a dialog split into category tabs on
// the left and automation cards on the right; a card only mounts once its category
// is active. Select the category, then the card (matched by its leading title,
// since cards also render a description line).
function pickAutomation(category: string, title: RoleTextMatch): void {
  const dialog = screen.getByRole("dialog");
  const tab = queryAllByRoleFast("button", dialog).find((candidate) => {
    return textFor(candidate) === category;
  });
  if (!tab) {
    throw new Error(`${category} automation category not found`);
  }
  click(tab);
  const card = queryAllByRoleFast("button", dialog).find((candidate) => {
    const text = textFor(candidate);
    return typeof title === "string"
      ? text.startsWith(title)
      : title.test(text);
  });
  if (!card) {
    throw new Error(`${matchLabel(title)} automation card not found`);
  }
  click(card);
}

function linkByAriaLabel(
  label: string,
  candidates = queryAllByRoleFast("link"),
): HTMLAnchorElement {
  const link = candidates.find((candidate): candidate is HTMLAnchorElement => {
    return (
      candidate instanceof HTMLAnchorElement &&
      candidate.getAttribute("aria-label") === label
    );
  });
  if (!link) {
    throw new Error(`${label} link not found`);
  }
  return link;
}

function selectOptionByLabel(
  label: string,
  option: string | RegExp,
  container: HTMLElement,
): void {
  const control =
    within(container)
      .getAllByLabelText(label)
      .find((element) => {
        return element.getAttribute("role") === "combobox";
      }) ?? within(container).getByLabelText(label);
  click(control);
  click(screen.getByRole("option", { name: option }));
}

async function openCopyDialog(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(buttonByText(/^Copy workflow$/)).toBeInTheDocument();
  });
  click(buttonByText(/^Copy workflow$/));
  return await waitFor(() => {
    return screen.getByRole("dialog");
  });
}

test("Return to Workflows with a toast when a legacy detail link is inaccessible", async () => {
  mockWorkflowApis([opsPlaybook()]);
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Workflow access denied" },
    });
  });

  await setupWorkflowDetailPage(`/workflows/${SALES_WORKFLOW_ID}`);

  await expect(
    screen.findByText("Workflow not found."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  });
});

test("Open and manage a deep-linked automation", async () => {
  context.mocks.data.userPreferences({ timezone: "UTC" });
  const workflow = {
    ...salesResearch(),
    automations: [weekdayWorkflowAutomation(), gmailWorkflowAutomation()],
  };
  const scrollIntoView = installScrollIntoViewMock();
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(
    `${workflowDetailPath("automations")}?automationId=${GMAIL_AUTOMATION_ID}`,
  );

  const gmailSwitch = await screen.findByRole("switch", {
    name: "Disable Gmail new message",
  });
  const gmailRow = document.querySelector<HTMLElement>(
    `[data-automation-id="${GMAIL_AUTOMATION_ID}"]`,
  );
  const weekdayRow = document.querySelector<HTMLElement>(
    '[data-automation-id="workflow-automation-weekday-brief"]',
  );
  if (!gmailRow || !weekdayRow) {
    throw new Error("Expected both automation cards");
  }
  expect(
    within(gmailRow).getByText(/from contains "@acme.com"/),
  ).toBeInTheDocument();
  expect(
    within(gmailRow).getByText(/subject does not contain "newsletter"/),
  ).toBeInTheDocument();
  expect(within(gmailRow).queryByText("Next")).not.toBeInTheDocument();
  expect(within(weekdayRow).getByText("Next")).toBeInTheDocument();
  expect(gmailRow).toHaveAttribute("aria-current", "true");
  expect(weekdayRow).not.toHaveAttribute("aria-current");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(search()).toBe(`?automationId=${GMAIL_AUTOMATION_ID}`);

  click(gmailSwitch);

  await screen.findByRole("switch", { name: "Enable Gmail new message" });
  expect(
    screen.getByRole("switch", {
      name: "Disable Every weekday at 9:00 AM",
    }),
  ).toBeChecked();
  expect(workflow.automations[0]?.enabled).toBeTruthy();
  expect(workflow.automations[1]?.enabled).toBeFalsy();
});

test("Block workflow publishing without permission on the owning agent", async () => {
  const workflow = {
    ...opsPlaybook(),
    canManage: true,
    canPublish: false,
    importSource: null,
  };
  mockWorkflowApis([workflow]);

  await setupPage({
    context,
    path: `/workflows/${OPS_WORKFLOW_ID}/info`,
  });

  const publishSwitch = await screen.findByRole("switch", {
    name: "Make workflow public",
  });
  // The shared `Switch` renders a `<span role="switch">`, so the disabled
  // contract is `aria-disabled` rather than the `disabled` attribute.
  expect(publishSwitch).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(publishSwitch);
  expect(publishSwitch).toHaveAttribute("aria-checked", "false");
  expect(
    screen.getByText(
      "Publishing a workflow under an agent you do not own requires org admin permissions.",
    ),
  ).toBeInTheDocument();
});

test("Refine a workflow in its agent chat", async () => {
  const openedWorkflowIds: string[] = [];
  mockChatLifecycle(context, { threadId: WORKFLOW_CHAT_THREAD_ID });
  mockWorkflowApis([salesResearch()]);
  mockOpenWorkflowChat((workflowId) => {
    openedWorkflowIds.push(workflowId);
  });

  await setupWorkflowDetailPage(workflowDetailPath("instructions"));

  await waitFor(() => {
    expect(
      screen.getByText("Gather CRM context before outreach."),
    ).toBeInTheDocument();
  });

  click(buttonByText("Refine with Research Bot"));

  await waitFor(() => {
    expect(openedWorkflowIds).toStrictEqual([SALES_WORKFLOW_ID]);
  });
  expect(pathname()).toBe(`/chats/${WORKFLOW_CHAT_THREAD_ID}`);
  expect(search()).toBe("");
  await expectComposerText("help me refine the workflow /sales-research");
});

test("Copy a workflow to another agent", async () => {
  const workflows = [salesResearch()];
  const copiedWorkflow: WorkflowDetailResponse = {
    ...salesResearch(),
    id: COPIED_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    visibility: "private",
    automations: [],
  };
  const copyRequests: {
    readonly workflowId: string;
    readonly toAgentId: string;
  }[] = [];
  const disabledAutomationIds: string[] = [];
  const deletedWorkflowIds: string[] = [];
  mockAgentPageApis();
  mockWorkflowApis(workflows);
  mockDisableWorkflowAutomation((automationId) => {
    disabledAutomationIds.push(automationId);
  });
  mockDeleteWorkflow(workflows, (workflowId) => {
    deletedWorkflowIds.push(workflowId);
  });
  context.mocks.api(
    workflowsDetailContract.copy,
    ({ params, body, respond }) => {
      copyRequests.push({
        workflowId: params.workflowId,
        toAgentId: body.toAgentId,
      });
      workflows.push(copiedWorkflow);
      return respond(201, summary(copiedWorkflow));
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  const dialog = await openCopyDialog();
  expect(
    within(dialog).getByText(
      "Copy this workflow to another agent as a new private workflow.",
    ),
  ).toBeInTheDocument();

  selectOptionByLabel("Copy to", "Support Bot", dialog);
  click(buttonByText(/^Copy workflow$/, dialog));

  await waitFor(() => {
    expect(copyRequests).toStrictEqual([
      { workflowId: SALES_WORKFLOW_ID, toAgentId: OTHER_AGENT_ID },
    ]);
  });
  // Copy-only never touches the source workflow or its automations.
  expect(disabledAutomationIds).toStrictEqual([]);
  expect(deletedWorkflowIds).toStrictEqual([]);
  // Stays on the source page and offers a link to the fresh copy.
  expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
  await expect(
    screen.findByText("Copied to Support Bot"),
  ).resolves.toBeInTheDocument();

  click(buttonByText("View"));
  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${COPIED_WORKFLOW_ID}/automations`);
  });
});

test("Move a workflow to another agent", async () => {
  const user = userEvent.setup();
  const workflows = [salesResearch()];
  const copiedWorkflow: WorkflowDetailResponse = {
    ...salesResearch(),
    id: COPIED_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    visibility: "private",
    automations: [],
  };
  const copyRequests: {
    readonly workflowId: string;
    readonly toAgentId: string;
  }[] = [];
  const disabledAutomationIds: string[] = [];
  const deletedWorkflowIds: string[] = [];
  mockAgentPageApis();
  mockWorkflowApis(workflows);
  mockDisableWorkflowAutomation((automationId) => {
    disabledAutomationIds.push(automationId);
  });
  mockDeleteWorkflow(workflows, (workflowId) => {
    deletedWorkflowIds.push(workflowId);
  });
  context.mocks.api(
    workflowsDetailContract.copy,
    ({ params, body, respond }) => {
      copyRequests.push({
        workflowId: params.workflowId,
        toAgentId: body.toAgentId,
      });
      workflows.push(copiedWorkflow);
      return respond(201, summary(copiedWorkflow));
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  const dialog = await openCopyDialog();
  selectOptionByLabel("Copy to", "Support Bot", dialog);

  // Opting to remove the original reveals the destructive alert and
  // relabels the primary action.
  const removeOriginal = within(dialog).getByRole("checkbox");
  await user.click(removeOriginal);
  expect(removeOriginal).toBeChecked();
  expect(
    within(dialog).getByText("This deletes the original"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "1 automation is paused on Research Bot and this workflow is deleted.",
    ),
  ).toBeInTheDocument();

  click(buttonByText(/^Copy and remove$/, dialog));

  await waitFor(() => {
    expect(copyRequests).toStrictEqual([
      { workflowId: SALES_WORKFLOW_ID, toAgentId: OTHER_AGENT_ID },
    ]);
  });
  await waitFor(() => {
    expect(disabledAutomationIds).toStrictEqual([
      "workflow-automation-weekday-brief",
    ]);
  });
  await waitFor(() => {
    expect(deletedWorkflowIds).toStrictEqual([SALES_WORKFLOW_ID]);
  });
  // Navigates to the copy because the source page no longer exists.
  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${COPIED_WORKFLOW_ID}/automations`);
  });
  await expect(
    screen.findByText("Moved to Support Bot"),
  ).resolves.toBeInTheDocument();
  expect(
    workflows.some((workflow) => {
      return workflow.id === SALES_WORKFLOW_ID;
    }),
  ).toBeFalsy();
});

test("Delete a workflow only navigates after success and keeps the dialog available on failure", async () => {
  const workflows = [salesResearch(), opsPlaybook()];
  let rejectDelete = true;
  mockWorkflowApis(workflows);
  context.mocks.api(workflowsDetailContract.delete, ({ params, respond }) => {
    if (rejectDelete) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Workflow is still in use" },
      });
    }
    const index = workflows.findIndex((workflow) => {
      return workflow.id === params.workflowId;
    });
    workflows.splice(index, 1);
    return respond(204);
  });
  await setupWorkflowDetailPage(workflowDetailPath("info"));
  click(buttonByText("Delete workflow"));
  const dialog = await screen.findByRole("dialog", { name: "Delete workflow" });
  click(buttonByText("Delete", dialog));

  await expect(
    screen.findByText("Workflow is still in use"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(workflowDetailPath("info"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(buttonByText("Delete", dialog)).toBeEnabled();

  rejectDelete = false;
  click(buttonByText("Delete", dialog));
  await expect(screen.findByText("Ops Playbook")).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/workflows");
  expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Edit workflow metadata", async () => {
  const updateBodies: WorkflowUpdateRequest[] = [];
  mockWorkflowApis([salesResearch()], (body) => {
    updateBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  const form = await screen.findByRole("form", {
    name: "Workflow metadata",
  });
  expect(within(form).getByLabelText("Name")).toHaveValue("Sales Research");
  expect(within(form).getByLabelText("Slug")).toHaveValue("sales-research");
  expect(within(form).getByLabelText("Description")).toHaveValue(
    "Collects account context before outreach.",
  );
  expect(
    within(form).getByText(/Lowercase letters, numbers, and - only/),
  ).toBeInTheDocument();
  expect(
    within(form).getByText(/Tell the agent when to use this workflow/),
  ).toBeInTheDocument();

  await fill(within(form).getByLabelText("Name"), "Account Brief");
  await fill(within(form).getByLabelText("Slug"), "account-brief");
  await fill(
    within(form).getByLabelText("Description"),
    "Use when an account needs a fresh research brief.",
  );
  await waitFor(() => {
    expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
  });
  click(screen.getByTestId("save-button"));

  await waitFor(() => {
    expect(updateBodies.at(-1)).toStrictEqual({
      name: "account-brief",
      displayName: "Account Brief",
      description: "Use when an account needs a fresh research brief.",
    });
  });
});

test("Navigate between workflow detail tabs", async () => {
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockWorkflowApis([salesResearch()]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
  });
  click(buttonByText("Settings"));

  await waitFor(() => {
    expect(screen.getAllByText("Visibility").length).toBeGreaterThan(0);
  });
  expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
  expect(search()).toBe("");
  click(buttonByText("Instructions"));
  await waitFor(() => {
    expect(
      screen.getByText("Gather CRM context before outreach."),
    ).toBeInTheDocument();
  });
  expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/instructions`);
  expect(search()).toBe("");
});

test("Recover when a stale Run now action receives the automatic-only policy rejection", async () => {
  const message =
    "Official Workflows can only run through their automatic triggers";
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.run, ({ respond }) => {
    return respond(409, { error: { code: "CONFLICT", message } });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  click(buttonByText("Run now"));

  await screen.findByText(message);
  expect(buttonByText("Run now")).toBeEnabled();
  expect(pathname()).toBe(workflowDetailPath("automations"));
});

test("Run a workflow automation now and promote it in the next composer overview", async () => {
  const runAutomationIds: string[] = [];
  mockWorkflowApis([salesResearch()]);
  mockChatLifecycle(context, { threadId: AUTOMATION_RUN_THREAD_ID });
  mockRunWorkflowAutomation((automationId) => {
    runAutomationIds.push(automationId);
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      {
        id: OPS_WORKFLOW_ID,
        name: "alpha",
        displayName: null,
        description: null,
      },
      {
        id: SALES_WORKFLOW_ID,
        name: "sales-research",
        displayName: null,
        description: null,
      },
    ]);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(buttonByText("Run now")).toBeInTheDocument();
  });
  click(buttonByText("Run now"));

  await waitFor(() => {
    expect(runAutomationIds).toStrictEqual([
      "workflow-automation-weekday-brief",
    ]);
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${AUTOMATION_RUN_THREAD_ID}`);
  });
  expect(search()).toBe("");
  await fill(await findComposerEditor(), "Draft /");
  await waitFor(() => {
    const menu = screen.getByTestId("slash-workflow-menu");
    const names = queryAllByRoleFast("button", menu)
      .map((button) => {
        return button.textContent ?? "";
      })
      .filter((name) => {
        return name.startsWith("/");
      });
    // The highest priority is nearest the composer in the anchored menu.
    expect(names).toStrictEqual(["/sales-research", "/alpha"]);
  });
});

test("Create a Gmail new-message automation with match rules", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Email", /^Gmail new message/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Gmail automation",
  });
  expect(within(createAutomationForm).getAllByRole("textbox")).toHaveLength(1);
  expect(
    buttonByText("Remove condition 1", createAutomationForm),
  ).toBeDisabled();
  await fill(
    within(createAutomationForm).getByLabelText("From contains"),
    "@acme.com",
  );
  click(buttonByText("Add condition", createAutomationForm));
  expect(within(createAutomationForm).getAllByRole("textbox")).toHaveLength(2);
  selectOptionByLabel("Condition 2 field", "Subject", createAutomationForm);
  selectOptionByLabel(
    "Condition 2 operator",
    "Does not contain",
    createAutomationForm,
  );
  await fill(
    within(createAutomationForm).getByLabelText("Subject does not contain"),
    "newsletter",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: {
        provider: "gmail",
        event: "new_message",
        match: {
          from: { contains: "@acme.com" },
          subject: { doesNotContain: "newsletter" },
        },
      },
    });
  });
});

test("Correct an unavailable Gmail label and create the automation", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const workflows: WorkflowDetailResponse[] = [
    { ...salesResearch(), automations: [] },
  ];
  mockWorkflowApis(workflows);
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    if (body.kind !== "event" || body.eventType !== "gmail-label-applied") {
      throw new Error("Expected a Gmail label automation");
    }
    if (body.eventConfig.labelName === "Missing") {
      return respond(400, {
        error: {
          code: "GMAIL_LABEL_NOT_FOUND",
          message: "Label is unavailable",
        },
      });
    }
    const automation = {
      ...gmailLabelWorkflowAutomation(),
      eventConfig: { ...body.eventConfig, resolvedLabelId: "Label_support" },
    };
    workflows[0].automations.push(automation);
    return respond(201, automation);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  pickAutomation("Email", /^Gmail label applied/);

  const form = await screen.findByRole("form", {
    name: "Add Gmail label automation",
  });
  const input = within(form).getByLabelText("Label name");
  await fill(input, "Missing");
  click(buttonByText("Add label automation", form));

  await expect(within(form).findByRole("alert")).resolves.toHaveTextContent(
    "Label not found in the connected Gmail account. Check the label name and connected account.",
  );
  expect(screen.queryByText("Label is unavailable")).not.toBeInTheDocument();
  expect(input).toHaveValue("Missing");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(buttonByText("Add label automation", form)).toBeEnabled();

  await fill(input, "Support");
  click(buttonByText("Add label automation", form));
  await expect(
    screen.findByText('Label "Support"'),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("form", { name: "Add Gmail label automation" }),
  ).not.toBeInTheDocument();
  expect(consoleError.mock.calls.flat()).not.toContainEqual(
    expect.objectContaining({
      name: "ApiError",
      code: "GMAIL_LABEL_NOT_FOUND",
    }),
  );
});

test("Keep Gmail provider failures visible while preserving the form", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Failed to read Gmail labels" },
    });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  pickAutomation("Email", /^Gmail label applied/);
  const form = await screen.findByRole("form", {
    name: "Add Gmail label automation",
  });
  const input = within(form).getByLabelText("Label name");
  await fill(input, "Support");
  fireEvent.submit(form);

  await expect(
    screen.findByText("Failed to read Gmail labels"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(consoleError.mock.calls.flat()).toContainEqual(
      expect.objectContaining({
        name: "ApiError",
        code: "BAD_REQUEST",
        status: 400,
        expected: false,
      }),
    );
  });
  expect(input).toHaveValue("Support");
  expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  expect(buttonByText("Add label automation", form)).toBeEnabled();
});

test("Create a filtered GitHub workflow-run automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });
  setMockGithubIntegration(createDefaultMockGithubIntegration());

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("GitHub", /^GitHub workflow completed/);

  const form = await screen.findByRole("form", {
    name: "Add GitHub workflow automation",
  });
  await fill(within(form).getByLabelText("Repositories"), "okou-ai/okou");
  await fill(
    within(form).getByLabelText("GitHub workflows"),
    "Turbo, .github/workflows/turbo.yml",
  );
  await fill(within(form).getByLabelText("Branches"), "main");
  await fill(within(form).getByLabelText("Triggering events"), "push");
  await fill(within(form).getByLabelText("Actors"), "lancy");
  click(within(form).getByLabelText("Failure"));
  click(within(form).getByLabelText("Startup failure"));
  fireEvent.submit(form);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "github-workflow-run-completed",
      eventConfig: {
        provider: "github",
        event: "workflow_run_completed",
        filters: {
          repositories: ["okou-ai/okou"],
          workflows: ["Turbo", ".github/workflows/turbo.yml"],
          conclusions: ["failure", "startup_failure"],
          branches: ["main"],
          events: ["push"],
          actors: ["lancy"],
        },
      },
    });
  });
});

test("Offer GitHub App installation when GitHub is unavailable", async () => {
  mockWorkflowApis([salesResearch()]);
  setMockGithubIntegration(null);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("GitHub", /^GitHub workflow completed/);

  const form = await screen.findByRole("form", {
    name: "Add GitHub workflow automation",
  });
  await waitFor(() => {
    expect(linkByText("Install GitHub App", form)).toHaveAttribute(
      "href",
      "https://github.com/apps/okou-test/installations/new?state=abc",
    );
  });
});

test.each([
  {
    label: "created",
    automation: googleCalendarWorkflowAutomation({
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "missing-created@example.com",
      },
      warning: "calendar_not_found",
    }),
    expectedEventConfig: {
      provider: "google-calendar",
      event: "event_created",
      calendarId: "replacement@example.com",
    },
  },
] satisfies readonly {
  readonly label: string;
  readonly automation: WorkflowGoogleCalendarAutomationSummary;
  readonly expectedEventConfig: GoogleCalendarAutomationEventConfig;
}[])(
  "Recover a missing Calendar for an event-$label automation without changing its event contract",
  async ({ automation, expectedEventConfig }) => {
    const updates: {
      readonly automationId: string;
      readonly body: WorkflowAutomationUpdateRequest;
    }[] = [];
    const automations: WorkflowGoogleCalendarAutomationSummary[] = [automation];
    const workflow = { ...salesResearch(), automations };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowAutomation((automationId, body) => {
      updates.push({ automationId, body });
      if (
        !("eventConfig" in body) ||
        body.eventConfig.provider !== "google-calendar"
      ) {
        throw new Error("Expected a Google Calendar event-config update");
      }
      const current = workflow.automations[0];
      if (!current) {
        throw new Error("Expected a Google Calendar automation");
      }
      workflow.automations[0] = applyGoogleCalendarAutomationUpdate(
        current,
        body.eventConfig,
      );
    });

    await setupWorkflowDetailPage(workflowDetailPath("automations"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Enabled · Action required — delivery paused",
    );
    expect(alert).toHaveTextContent(
      "This calendar is no longer available. Choose another calendar to resume this automation.",
    );
    const row = alert.closest("[data-automation-id]");
    if (!(row instanceof HTMLElement)) {
      throw new Error("Expected the Calendar automation row");
    }
    expect(row).not.toHaveClass("opacity-75");
    expect(within(row).getByRole("switch")).toBeChecked();
    expect(buttonByText("Edit automation", row)).toBeInTheDocument();

    click(buttonByText("Change calendar", alert));
    const form = await screen.findByRole("form", {
      name: "Change Google Calendar automation",
    });
    expect(within(form).getByLabelText("Calendar ID")).toHaveValue(
      automation.eventConfig.calendarId,
    );
    await fill(
      within(form).getByLabelText("Calendar ID"),
      expectedEventConfig.calendarId,
    );
    fireEvent.submit(form);

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          automationId: automation.id,
          body: { eventConfig: expectedEventConfig },
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("form", {
          name: "Change Google Calendar automation",
        }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  },
);

test("Show a Calendar warning without recovery mutations for another user's automation", async () => {
  const automation = googleCalendarWorkflowAutomation({
    ownerUserId: UPDATED_USER_ID,
    warning: "reconnect_required",
  });
  const workflow = {
    ...salesResearch(),
    canManage: false,
    automations: [automation],
  };
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Enabled · Action required — delivery paused",
  );
  const row = alert.closest("[data-automation-id]");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the Calendar automation row");
  }
  expect(within(row).getByRole("switch")).toBeChecked();
  expect(within(row).getByRole("switch")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(queryButtonByText("Change calendar", alert)).toBeNull();
  expect(queryButtonByText("Reconnect Google Calendar", alert)).toBeNull();
});

test("Open a Calendar action-required workflow at the exact automation from the workflow list", async () => {
  const automation = googleCalendarWorkflowAutomation({
    warning: "calendar_not_found",
  });
  const workflow = { ...salesResearch(), automations: [automation] };
  const scrollIntoView = installScrollIntoViewMock();
  mockWorkflowApis([workflow]);

  await setupPage({ context, path: "/workflows" });

  click(
    await waitFor(() => {
      return buttonByText("Action required");
    }),
  );
  const recoveryLink = await waitFor(() => {
    return linkByText("Open Sales Research recovery");
  });
  expect(recoveryLink).toHaveAttribute(
    "href",
    `/workflows/${SALES_WORKFLOW_ID}/automations?automationId=${GOOGLE_CALENDAR_AUTOMATION_ID}`,
  );
  const popover = recoveryLink.closest('[data-slot="popover-content"]');
  if (!(popover instanceof HTMLElement)) {
    throw new Error("Expected the automation popover");
  }
  expect(within(popover).getByRole("switch")).toBeChecked();
  click(recoveryLink);

  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
    expect(search()).toBe(`?automationId=${GOOGLE_CALENDAR_AUTOMATION_ID}`);
  });
  const row = document.querySelector(
    `[data-automation-id="${GOOGLE_CALENDAR_AUTOMATION_ID}"]`,
  );
  expect(row).toHaveAttribute("aria-current", "true");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Action required — delivery paused",
  );
});

function mockCalendarReconnect(workflow: WorkflowDetailResponse) {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const healthyAccount = googleCalendarAccount({
    id: "10000000-0000-4000-a000-000000000020",
    displayName: "Work Calendar",
    isDefault: true,
    externalUsername: "work",
  });
  let reconnectAccount = googleCalendarAccount({
    id: "10000000-0000-4000-a000-000000000021",
    displayName: "Personal Calendar",
    isDefault: false,
    externalUsername: "personal",
    status: "reconnect-required",
  });
  mockWorkflowApis([workflow]);
  context.mocks.data.connectors([
    {
      id: healthyAccount.id,
      slug: "google-calendar",
      authMethod: "oauth",
      externalId: "google-calendar-work",
      externalUsername: "work",
      externalEmail: "work@example.com",
      oauthScopes: [],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      if (params.connectionId === healthyAccount.id) {
        return respond(200, healthyAccount);
      }
      if (params.connectionId !== reconnectAccount.id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Account not found" },
        });
      }
      return respond(200, reconnectAccount);
    },
  );
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [healthyAccount, reconnectAccount],
      nextCursor: null,
      defaultConnection: healthyAccount,
    });
  });
  const submittedAccounts: unknown[] = [];
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      submittedAccounts.push(body.account);
      return respond(200, {
        authorizationUrl: "https://oauth.test/google-calendar/authorize",
        oauthAttemptId,
      });
    },
  );
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);

  return {
    submittedAccounts,
    open: async () => {
      mockBillingTier("team");
      await setupPage({
        context,
        path: workflowDetailPath("automations"),
        sharedWorkerTestTransport: "message-port",
      });

      const warning = await screen.findByRole("alert");
      expect(warning).toHaveTextContent(
        "Google Calendar needs to be reconnected before this automation can resume.",
      );
      const reconnectEntry = buttonByText("Reconnect Google Calendar", warning);
      await waitFor(() => {
        expect(reconnectEntry).toBeEnabled();
      });
      click(reconnectEntry);

      const manager = await screen.findByRole("dialog", {
        name: "Manage Google Calendar accounts",
      });
      const healthyRow = await within(manager).findByRole("group", {
        name: "Work Calendar",
      });
      const reconnectRow = within(manager).getByRole("group", {
        name: "Personal Calendar",
      });
      expect(healthyRow).toHaveTextContent("Connected");
      expect(reconnectRow).toHaveTextContent("Reconnect required");
      expect(submittedAccounts).toStrictEqual([]);
      expect(queryButtonByText("Reconnect", healthyRow)).toBeNull();
      click(buttonByText("Reconnect", reconnectRow));

      const connectDialog = await waitFor(() => {
        const dialog = screen
          .getAllByRole("dialog", { name: "Google Calendar" })
          .find((candidate) => {
            return queryButtonByText("Reconnect", candidate);
          });
        if (!dialog) {
          throw new Error("Expected Google Calendar reconnect dialog");
        }
        return dialog;
      });
      click(buttonByText("Reconnect", connectDialog));
      await waitFor(() => {
        expect(authWindow.location.href).toBe(
          "https://oauth.test/google-calendar/authorize",
        );
      });
      expect(submittedAccounts).toStrictEqual([
        {
          intent: "reconnect",
          connectionId: reconnectAccount.id,
        },
      ]);
    },
    complete: () => {
      completedAttempts.set(oauthAttemptId, reconnectAccount.id);
      reconnectAccount = {
        ...reconnectAccount,
        connectionStatus: "connected",
        reconnectReason: null,
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-calendar",
      });
    },
  };
}

test("Reconnect the selected Calendar account and reload the warning state", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [
      googleCalendarWorkflowAutomation({ warning: "reconnect_required" }),
    ],
  };
  const reconnect = mockCalendarReconnect(workflow);
  await reconnect.open();
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  reconnect.complete();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Google Calendar" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(screen.getByRole("switch")).toBeChecked();
});

test("Create a Google Forms automation and surface its warning", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  const warning = "This Google Form is not accepting responses yet.";
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    createBodies.push(body);
    return respond(
      201,
      googleFormsResponseSubmittedWorkflowAutomation(warning),
    );
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"), {});

  click(await screen.findByText("Add automation"));
  await screen.findByRole("dialog");
  pickAutomation("Google Forms", /^Google Forms response submitted/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Google Forms response automation",
  });
  await fill(
    within(createAutomationForm).getByLabelText("Form link"),
    "https://docs.google.com/forms/d/1FAIpQLScGoogleFormsAutomationTest/edit",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "google-forms-response-submitted",
      eventConfig: {
        provider: "google-forms",
        event: "response_submitted",
        formUrl:
          "https://docs.google.com/forms/d/1FAIpQLScGoogleFormsAutomationTest/edit",
      },
    });
  });
  await expect(screen.findByText(warning)).resolves.toBeInTheDocument();
});

async function verifyWebhookFieldInteractions(
  dialog: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
  clipboardWrites: readonly string[],
) {
  const fields = [
    { label: "Webhook URL", value: webhookWorkflowAutomation().webhookUrl },
    { label: "Signing secret", value: "webhook-secret" },
  ];
  const copyButtons = queryAllByRoleFast("button", dialog).filter((button) => {
    return textFor(button) === "Copy";
  });
  expect(copyButtons).toHaveLength(3);
  const expectedWrites: string[] = [];

  for (const [index, { label, value }] of fields.entries()) {
    const input = within(dialog).getByLabelText<HTMLInputElement>(label, {
      exact: true,
    });
    expect(within(dialog).getByRole("textbox", { name: label })).toBe(input);
    expect(input).toHaveValue(value);
    expect(input).toHaveAttribute("readonly");

    await user.click(within(dialog).getByText(label, { exact: true }));
    expect(input).toHaveFocus();
    expect(clipboardWrites).toStrictEqual(expectedWrites);

    await user.keyboard("{Control>}a{/Control}");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await user.keyboard("x");
    expect(input).toHaveValue(value);

    await user.keyboard("{Tab}");
    const copyButton = copyButtons[index];
    expect(copyButton).toHaveFocus();
    expect(copyButton).toHaveAttribute("type", "button");
    await user.keyboard("{Enter}");
    expectedWrites.push(input.value);
    expect(clipboardWrites).toStrictEqual(expectedWrites);
    await user.keyboard(" ");
    expectedWrites.push(input.value);
    expect(clipboardWrites).toStrictEqual(expectedWrites);
    await user.click(copyButton);
    expectedWrites.push(input.value);
    expect(clipboardWrites).toStrictEqual(expectedWrites);
    await user.keyboard("{Tab}");
    expect(
      index === 0
        ? within(dialog).getByLabelText("Signing secret", { exact: true })
        : copyButtons[2],
    ).toHaveFocus();
  }

  await user.keyboard("{Enter}");
  expect(clipboardWrites).toHaveLength(7);
  expect(clipboardWrites[6]).toContain(fields[0].value);
  expect(clipboardWrites[6]).toContain(fields[1].value);
}

test("Reveal an existing webhook secret on demand", async () => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const workflow = {
    ...salesResearch(),
    automations: [webhookWorkflowAutomation()],
  };
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getByText("Webhook URL hidden")).toBeInTheDocument();
  });
  expect(
    screen.queryByDisplayValue(webhookWorkflowAutomation().webhookUrl ?? ""),
  ).not.toBeInTheDocument();
  click(buttonByText("More actions"));
  click(menuItemByText("View webhook secret"));
  const dialog = await screen.findByRole("dialog", {
    name: "View webhook secret",
  });
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  click(buttonByText("Reveal secret", dialog));

  await expect(
    within(dialog).findByLabelText("Webhook URL"),
  ).resolves.toHaveValue(webhookWorkflowAutomation().webhookUrl);
  await verifyWebhookFieldInteractions(dialog, user, clipboard.writes);
  click(buttonByText("Done", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  click(buttonByText("More actions"));
  click(menuItemByText("View webhook secret"));
  const reopened = await screen.findByRole("dialog", {
    name: "View webhook secret",
  });
  expect(within(reopened).queryByRole("textbox")).not.toBeInTheDocument();
  expect(buttonByText("Reveal secret", reopened)).toBeEnabled();
  expect(clipboard.writes).toHaveLength(7);
});

test("Create a one-time automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Schedule", /^One-time run/u);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add one-time automation",
  });
  fireEvent.change(within(createAutomationForm).getByLabelText("Run at"), {
    target: { value: "2026-07-01T10:30" },
  });
  click(buttonByText("Add one-time run", createAutomationForm));

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      schedule: {
        type: "once",
        atTime: new Date("2026-07-01T10:30").toISOString(),
        timezone: "UTC",
      },
    });
  });
});

test("A completed automation update preserves a reopened editor draft", async () => {
  const automation: WorkflowScheduleAutomationSummary = {
    ...weekdayWorkflowAutomation(),
    schedule: { type: "loop", intervalSeconds: 3600 },
    scheduleSummary: "Every 1 hour",
  };
  const workflow = { ...salesResearch(), automations: [automation] };
  mockWorkflowApis([workflow]);
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(workflowAutomationsContract.update, async ({ respond }) => {
    started.resolve();
    await response.promise;
    const saved: WorkflowScheduleAutomationSummary = {
      ...automation,
      schedule: { type: "loop", intervalSeconds: 18_000 },
      scheduleSummary: "Every 5 hours",
    };
    workflow.automations = [saved];
    return respond(200, saved);
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  click(
    await waitFor(() => {
      return buttonByText("Edit automation");
    }),
  );
  const first = screen.getByRole("form", {
    name: "Update schedule automation",
  });
  fireEvent.submit(first);
  await started.promise;
  click(buttonByText("Close", screen.getByRole("dialog")));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(buttonByText("Edit automation"));
  const draft = screen.getByRole("form", {
    name: "Update schedule automation",
  });
  selectOptionByLabel("Every", "30 minutes", draft);
  response.resolve();
  await screen.findByText("Every 5 hours");
  await expect(
    screen.findByRole("form", { name: "Update schedule automation" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(draft).getByRole("combobox", { name: "Every" }),
  ).toHaveTextContent("30 minutes");
});

test("Correct an unavailable Gmail label while preserving the saved automation", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const workflows = [
    { ...salesResearch(), automations: [gmailLabelWorkflowAutomation()] },
  ];
  mockWorkflowApis(workflows);
  context.mocks.api(workflowAutomationsContract.update, ({ body, respond }) => {
    if (
      !("eventConfig" in body) ||
      body.eventConfig.provider !== "gmail" ||
      body.eventConfig.event !== "label_applied"
    ) {
      throw new Error("Expected a Gmail label update");
    }
    if (body.eventConfig.labelName === "Missing") {
      return respond(400, {
        error: {
          code: "GMAIL_LABEL_NOT_FOUND",
          message: "Label is unavailable",
        },
      });
    }
    const automation = {
      ...gmailLabelWorkflowAutomation(),
      eventConfig: { ...body.eventConfig, resolvedLabelId: "Label_escalated" },
    };
    workflows[0].automations = [automation];
    return respond(200, automation);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  await expect(
    screen.findByText('Label "Support"'),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Edit automation"));
  const form = await screen.findByRole("form", {
    name: "Update Gmail label automation",
  });
  const input = within(form).getByLabelText("Label name");
  await fill(input, "Missing");
  click(buttonByText("Save label", form));

  await expect(within(form).findByRole("alert")).resolves.toHaveTextContent(
    "Label not found in the connected Gmail account. Check the label name and connected account.",
  );
  expect(screen.queryByText("Label is unavailable")).not.toBeInTheDocument();
  expect(input).toHaveValue("Missing");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText('Label "Support"')).toBeInTheDocument();
  expect(buttonByText("Save label", form)).toBeEnabled();

  await fill(input, "Escalated");
  click(buttonByText("Save label", form));
  await expect(
    screen.findByText('Label "Escalated"'),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("form", { name: "Update Gmail label automation" }),
  ).not.toBeInTheDocument();
  expect(consoleError.mock.calls.flat()).not.toContainEqual(
    expect.objectContaining({
      name: "ApiError",
      code: "GMAIL_LABEL_NOT_FOUND",
    }),
  );
});

test("Select workflow files with Enter and Space and preserve accessible current state", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch()]);

  await setupWorkflowDetailPage(
    `${workflowDetailPath("instructions")}?file=config%2Fsettings.json`,
  );
  await expect(
    screen.findByDisplayValue('{ "risk": "low", "tone": "direct" }'),
  ).resolves.toBeInTheDocument();

  const picker = screen.getByLabelText("Workflow files");
  expect(picker).toHaveTextContent("config/settings.json");
  click(picker);
  expect(workflowFileItemByText(/config\/settings\.json/)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const instructions = workflowFileItemByText("instructions");
  expect(instructions).toHaveAttribute("aria-checked", "false");
  expect(workflowFileItemByText(/examples\/prompt\.md/)).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await user.keyboard("{Home}");
  expect(instructions).toHaveFocus();
  expect(search()).toBe("?file=config%2Fsettings.json");
  await user.keyboard("{Enter}");
  await expect(
    screen.findByText("Gather CRM context before outreach."),
  ).resolves.toBeInTheDocument();
  expect(search()).toBe("");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });

  click(picker);
  expect(workflowFileItemByText("instructions")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  workflowFileItemByText(/examples\/prompt\.md/).focus();
  await user.keyboard(" ");
  await expect(
    screen.findByText("Ask for market segment and urgency."),
  ).resolves.toBeInTheDocument();
  expect(search()).toBe("?file=examples%2Fprompt.md");
  expect(picker).toHaveTextContent("examples/prompt.md");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });

  click(picker);
  expect(workflowFileItemByText(/examples\/prompt\.md/)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(workflowFileItemByText("instructions")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });
  expect(search()).toBe("?file=examples%2Fprompt.md");
});

test("Reach workflow file actions with arrows and typeahead, then delete with Enter", async () => {
  const user = userEvent.setup();
  const updateBodies: WorkflowUpdateRequest[] = [];
  mockWorkflowApis([salesResearch()], (body) => {
    updateBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("instructions"));

  await waitFor(() => {
    expect(
      screen.getByText("Gather CRM context before outreach."),
    ).toBeInTheDocument();
  });
  click(screen.getByLabelText("Workflow files"));
  click(workflowFileItemByText(/config\/settings\.json/));
  await user.click(screen.getByLabelText("Workflow files"));
  await user.keyboard("{End}");
  expect(menuItemByText("Delete selected file")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(menuItemByText("Upload text files")).toHaveFocus();
  await user.keyboard("{Home}u");
  expect(menuItemByText("Upload text files")).toHaveFocus();
  await user.keyboard("{Escape}{ArrowDown}d");
  expect(menuItemByText("Delete selected file")).toHaveFocus();
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(updateBodies.at(-1)?.files).toStrictEqual([
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
    ]);
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Workflow files")).toHaveTextContent(
      "instructions",
    );
  });
});

test.each(["upload"])(
  "Keep the selected workflow file and its content when %s fails",
  async (operation) => {
    const user = userEvent.setup({ delay: null });
    mockWorkflowApis([salesResearch()]);
    context.mocks.api(workflowsDetailContract.update, ({ respond }) => {
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Workflow files could not be saved",
        },
      });
    });
    await setupWorkflowDetailPage(
      `${workflowDetailPath("instructions")}?file=config%2Fsettings.json`,
    );
    await expect(
      screen.findByDisplayValue('{ "risk": "low", "tone": "direct" }'),
    ).resolves.toBeInTheDocument();

    if (operation === "upload") {
      await user.upload(
        screen.getByLabelText("Upload workflow files"),
        new File(["new notes"], "notes.md", { type: "text/markdown" }),
      );
    } else {
      click(screen.getByLabelText("Workflow files"));
      click(menuItemByText("Delete selected file"));
    }

    await expect(
      screen.findByText("Workflow files could not be saved"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Workflow files")).toHaveTextContent(
      "config/settings.json",
    );
    expect(screen.getByLabelText("Workflow file content")).toHaveValue(
      '{ "risk": "low", "tone": "direct" }',
    );
    expect(search()).toBe("?file=config%2Fsettings.json");
    expect(screen.getByLabelText("Upload workflow files")).toBeEnabled();
  },
);

test("Upload after the file menu closes and reselect the same file after an empty selection", async () => {
  const user = userEvent.setup();
  const updateBodies: WorkflowUpdateRequest[] = [];
  mockWorkflowApis([salesResearch()], (body) => {
    updateBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("instructions"));

  await waitFor(() => {
    expect(
      screen.getByText("Gather CRM context before outreach."),
    ).toBeInTheDocument();
  });

  await user.click(screen.getByLabelText("Workflow files"));
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  const file = new File(["new notes"], "notes.md", {
    type: "text/markdown",
  });
  await user.upload(screen.getByLabelText("Upload workflow files"), file);

  await waitFor(() => {
    expect(updateBodies.at(-1)?.files).toContainEqual({
      path: "notes.md",
      content: "new notes",
    });
  });
  expect(updateBodies.at(-1)?.files).toContainEqual({
    path: "config/settings.json",
    content: '{ "risk": "low", "tone": "direct" }',
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Workflow files")).toHaveTextContent(
      "notes.md",
    );
  });

  await user.upload(screen.getByLabelText("Upload workflow files"), []);
  expect(screen.getByLabelText("Workflow files")).toHaveTextContent("notes.md");

  click(screen.getByLabelText("Workflow files"));
  click(workflowFileItemByText("instructions"));
  await user.upload(screen.getByLabelText("Upload workflow files"), file);
  await waitFor(() => {
    expect(screen.getByLabelText("Workflow files")).toHaveTextContent(
      "notes.md",
    );
  });
});

test("Replace an uploaded workflow file by path without dropping its siblings", async () => {
  const user = userEvent.setup({ delay: null });
  const workflow = salesResearch();
  mockWorkflowApis([workflow]);
  await setupWorkflowDetailPage(workflowDetailPath("instructions"));
  await screen.findByLabelText("Workflow instruction");

  const file = new File(["Updated prompt instructions"], "prompt.md", {
    type: "text/markdown",
  });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "./examples/prompt.md",
  });
  await user.upload(screen.getByLabelText("Upload workflow files"), file);

  await expect(
    screen.findByText("Updated prompt instructions"),
  ).resolves.toBeInTheDocument();
  expect(search()).toBe("?file=examples%2Fprompt.md");
  click(screen.getByLabelText("Workflow files"));
  expect(
    queryAllByRoleFast("menuitemradio").filter((item) => {
      return item.textContent?.includes("examples/prompt.md");
    }),
  ).toHaveLength(1);
  click(workflowFileItemByText(/config\/settings\.json/));
  await expect(
    screen.findByDisplayValue('{ "risk": "low", "tone": "direct" }'),
  ).resolves.toBeInTheDocument();
});

test("A completed automation creation preserves a reopened creation draft", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [] as WorkflowAutomationSummary[],
  };
  mockWorkflowApis([workflow]);
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(workflowAutomationsContract.create, async ({ respond }) => {
    started.resolve();
    await response.promise;
    const automation: WorkflowScheduleAutomationSummary = {
      ...weekdayWorkflowAutomation(),
      schedule: { type: "loop", intervalSeconds: 18_000 },
      scheduleSummary: "Every 5 hours",
    };
    workflow.automations.push(automation);
    return respond(201, automation);
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  click(
    await waitFor(() => {
      return buttonByText("Add automation");
    }),
  );
  pickAutomation("Schedule", /^Interval/u);
  const first = await screen.findByRole("form", {
    name: "Add interval automation",
  });
  click(buttonByText("Add interval", first));
  await started.promise;
  click(buttonByText("Close", screen.getByRole("dialog")));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(buttonByText("Add automation"));
  pickAutomation("Schedule", /^Scheduled time/u);
  const draft = await screen.findByRole("form", {
    name: "Add schedule automation",
  });
  selectOptionByLabel("Hour", "16", draft);
  response.resolve();
  await screen.findByText("Every 5 hours");
  await expect(
    screen.findByRole("form", { name: "Add schedule automation" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(draft).getByRole("combobox", { name: "Hour" }),
  ).toHaveTextContent("16");
});

test("Workspace Workflows ignore stale Agent filters and identify the caller's private override", async () => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockAgentPageApis();
  mockChatLifecycle(context);
  const shared = salesResearch();
  const personal: WorkflowDetailResponse = {
    ...shared,
    id: COPIED_WORKFLOW_ID,
    visibility: "private",
    displayName: "My sales research",
    instruction: "My private steps",
    shadowedBy: null,
  };
  const visibleShared = {
    ...shared,
    shadowedBy: {
      id: personal.id,
      name: personal.name,
      displayName: personal.displayName,
    },
  };
  mockWorkflowApis([visibleShared, personal, otherAgentWorkflow()]);
  await setupPage({
    context,
    path: `/workflows?agent=${OTHER_AGENT_ID}`,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  await expect(
    screen.findByText("Overridden for you"),
  ).resolves.toBeInTheDocument();
  expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  expect(linkByAriaLabel("Open My sales research")).toBeInTheDocument();
  expect(screen.getByText("Used for /sales-research")).toBeInTheDocument();
  const sharedLink = linkByAriaLabel("Open Sales Research");
  expect(sharedLink).toHaveAttribute(
    "href",
    `/workflows/${SALES_WORKFLOW_ID}/automations`,
  );
});

test("Make private copy opens the existing private definition without overwriting it", async () => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockAgentPageApis();
  mockChatLifecycle(context);
  const shared = salesResearch();
  const personal: WorkflowDetailResponse = {
    ...shared,
    id: COPIED_WORKFLOW_ID,
    visibility: "private",
    displayName: "My saved copy",
    instruction: "Retained private instructions",
    shadowedBy: null,
  };
  const visibleShared = {
    ...shared,
    shadowedBy: {
      id: personal.id,
      name: personal.name,
      displayName: personal.displayName,
    },
  };
  mockWorkflowApis([visibleShared, personal]);
  await setupWorkflowDetailPage(workflowDetailPath("info"), {
    [FeatureSwitchKey.SingleAgent]: true,
  });
  await waitFor(() => {
    expect(buttonByText("Make private copy")).toBeEnabled();
  });
  const metadata = screen.getByLabelText("Workflow metadata");
  expect(
    within(metadata).getByText(
      "/sales-research uses your private copy. You are viewing the shared definition.",
    ),
  ).toBeInTheDocument();
  const privateLink = linkByText("Open private copy");
  expect(privateLink).toHaveAttribute(
    "href",
    `/workflows/${COPIED_WORKFLOW_ID}/instructions`,
  );
  click(buttonByText("Make private copy"));
  const dialog = await screen.findByRole("dialog", {
    name: "Make private copy",
  });
  const link = linkByText("Open private copy", dialog);
  expect(link).toHaveAttribute(
    "href",
    `/workflows/${COPIED_WORKFLOW_ID}/instructions`,
  );
  click(link);
  await waitFor(() => {
    return expect(pathname()).toBe(
      `/workflows/${COPIED_WORKFLOW_ID}/instructions`,
    );
  });
  await expect(
    screen.findByText("Retained private instructions"),
  ).resolves.toBeInTheDocument();
});

test("creates a workspace Workflow with the default Okou without choosing an Agent", async () => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  mockAgentPageApis();
  mockChatLifecycle(context);
  mockWorkflowApis([salesResearch()]);
  await setupPage({
    context,
    path: "/workflows",
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  await waitFor(() => {
    expect(buttonByText("Create in chat")).toBeEnabled();
  });
  click(buttonByText("Create in chat"));
  const dialog = await screen.findByRole("dialog", { name: "Create workflow" });
  expect(
    within(dialog).getByText(
      "Create a workflow with your personal Okou in this workspace.",
    ),
  ).toBeInTheDocument();
  click(buttonByText("Create workflow", dialog));
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
});
