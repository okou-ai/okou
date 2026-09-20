import { mockOAuthCompletions } from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as timers from "signal-timers";
import { mockNow } from "../../../lib/time.ts";
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
  workflowVisibilityContract,
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
import {
  officialWorkflowInstallationsContract,
  officialWorkflowsContract,
  type OfficialWorkflowCatalogDetail,
} from "@okouai/api-contracts/contracts/official-workflows";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi, type Mock, describe, beforeEach, it } from "vitest";

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

vi.mock("signal-timers", async () => {
  return {
    ...(await vi.importActual<typeof import("signal-timers")>("signal-timers")),
  };
});

const context = testContext();
const CURRENT_USER_ID = "test-user-123";
const UPDATED_USER_ID = "test-user-456";
const AGENT_ID = "c0000000-0000-4000-a000-000000000101";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000102";
const SALES_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const OPS_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000202";
const OTHER_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000203";
const CHECKLIST_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000204";
const COPIED_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000205";
const MORNING_BRIEF_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000206";
const GMAIL_AUTOMATION_ID = "workflow-automation-gmail-new-message";
const GMAIL_LABEL_AUTOMATION_ID = "workflow-automation-gmail-label-applied";
const GITHUB_PULL_REQUEST_AUTOMATION_ID =
  "workflow-automation-github-pull-request";
const GOOGLE_CALENDAR_AUTOMATION_ID =
  "workflow-automation-google-calendar-created";
const GOOGLE_MEET_AUTOMATION_ID = "workflow-automation-google-meet-transcript";
const WORKFLOW_CHAT_THREAD_ID = "00000000-0000-4000-a000-000000000300";
const AUTOMATION_RUN_THREAD_ID = "00000000-0000-4000-a000-000000000301";
const OFFICIAL_REVISION = "a".repeat(64);
const OFFICIAL_BLUEPRINT_FINGERPRINT = "b".repeat(64);

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
type WorkflowStripeInvoicePaidAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { kind: "event"; eventType: "stripe-invoice-paid" }
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
      repository: "vm0-ai/vm0",
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

function stripeInvoicePaidWorkflowAutomation(
  overrides: Partial<WorkflowStripeInvoicePaidAutomationSummary> = {},
): WorkflowStripeInvoicePaidAutomationSummary {
  return {
    id: "workflow-automation-stripe-invoice-paid",
    kind: "event",
    eventType: "stripe-invoice-paid",
    eventConfig: {
      provider: "stripe",
      event: "invoice_paid",
      connectorId: "00000000-0000-4000-a000-000000000411",
      stripeAccountId: "acct_mock_stripe_invoice_paid",
      mode: "live",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_stripe_invoice_paid",
    nextRunAt: null,
    lastRunAt: null,
    health: {
      lastMatchingEventReceivedAt: null,
      lastDeliveryStatus: null,
      lastDeliveryStatusAt: null,
      warning: null,
    },
    ...overrides,
    official: overrides.official ?? null,
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

function officialCatalogDetail(
  lifecycle: "active" | "retired" = "active",
): OfficialWorkflowCatalogDetail {
  return {
    name: "sales-research",
    revision: OFFICIAL_REVISION,
    lifecycle,
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    presentation: {
      category: "Sales",
      marketingCopy: "Start every sales conversation with useful context.",
    },
    workflow: {
      displayName: "Sales Research",
      description: "Collects account context before outreach.",
      instruction: "Use the accepted Official instructions.",
      files: [{ path: "references/playbook.md", content: "Official playbook" }],
    },
    blueprints: [
      {
        key: "daily",
        fingerprint: OFFICIAL_BLUEPRINT_FINGERPRINT,
        parameters: [
          {
            key: "time-zone",
            type: "string",
            format: "timezone",
            required: true,
            default: "UTC",
          },
          {
            key: "interval-seconds",
            type: "integer",
            required: true,
            default: 3600,
          },
          {
            key: "include-weekends",
            type: "boolean",
            required: true,
            default: false,
          },
        ],
        desiredState: {
          kind: "schedule",
          schedule: {
            type: "loop",
            intervalSeconds: { parameter: "interval-seconds" },
          },
        },
        runtime: { resultEmail: false },
      },
    ],
  };
}

function officialSalesResearch(
  lifecycle: "active" | "retired" | "unavailable" = "active",
  reconciliationStatus:
    | "current"
    | "reconciling"
    | "needs_reconfiguration"
    | "failed" = "current",
): WorkflowDetailResponse {
  const ordinary = salesResearch();
  const [automation] = ordinary.automations;
  if (!automation) {
    throw new Error("Expected the Official Workflow automation fixture");
  }
  return {
    ...ordinary,
    visibility: "private",
    canManage: false,
    canPublish: false,
    instruction: "Use the accepted Official instructions.",
    files: [{ path: "references/playbook.md", size: 17 }],
    fileContents: [
      { path: "references/playbook.md", content: "Official playbook" },
    ],
    official: {
      definitionName: "sales-research",
      installationState: "installed",
      definitionLifecycle: lifecycle,
      readOnly: true,
    },
    automations: [
      {
        ...automation,
        enabled: false,
        official: {
          blueprintKey: "daily",
          appliedFingerprint: OFFICIAL_BLUEPRINT_FINGERPRINT,
          reconciliationStatus,
          intendedEnabled: true,
          parameterBindings: [
            { key: "time-zone", value: "UTC" },
            { key: "interval-seconds", value: 3600 },
            { key: "include-weekends", value: false },
          ],
        },
      },
    ],
  };
}

function morningBriefWorkflow(): WorkflowDetailResponse {
  const workflow = officialSalesResearch();
  if (!workflow.official) {
    throw new Error("Expected an Official Workflow fixture");
  }
  return {
    ...workflow,
    id: MORNING_BRIEF_WORKFLOW_ID,
    name: "morning-brief",
    displayName: "Morning Brief",
    official: {
      ...workflow.official,
      definitionName: "morning-brief",
    },
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

function launchChecklistWorkflow(): WorkflowDetailResponse {
  return {
    id: CHECKLIST_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "launch-checklist",
    displayName: "Launch Checklist",
    description: "Prepares release approvals.",
    visibility: "private",
    official: null,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: true,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-18T12:00:00.000Z",
    updatedAt: "2026-06-18T12:00:00.000Z",
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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
    official: workflow.official,
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
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

function mockConnectedAutomationConnectors(): void {
  context.mocks.data.connectors([
    {
      id: "10000000-0000-4000-a000-000000000001",
      slug: "slack",
      authMethod: "oauth",
      externalId: "slack-workspace",
      externalUsername: "workspace",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "10000000-0000-4000-a000-000000000002",
      slug: "gmail",
      authMethod: "oauth",
      externalId: "gmail-user",
      externalUsername: "user@example.com",
      externalEmail: "user@example.com",
      oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
}

function mockConfiguredEventAutomation(
  body: Extract<WorkflowAutomationCreateRequest, { readonly kind: "event" }>,
): WorkflowAutomationSummary {
  if (body.eventType === "stripe-invoice-paid") {
    return {
      ...gmailWorkflowAutomation(),
      eventType: "stripe-invoice-paid",
      eventConfig: {
        ...body.eventConfig,
        connectorId: "00000000-0000-4000-a000-000000000411",
        stripeAccountId: "acct_mock_stripe_invoice_paid",
        mode: "live",
      },
      health: {
        lastMatchingEventReceivedAt: null,
        lastDeliveryStatus: null,
        lastDeliveryStatusAt: null,
        warning: null,
      },
    };
  }
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
      body.eventConfig.provider === "stripe" ||
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

function articleByText(text: string): HTMLElement {
  const article = screen
    .getAllByText(text)
    .map((element) => {
      return element.closest("article");
    })
    .find((candidate): candidate is HTMLElement => {
      return candidate instanceof HTMLElement;
    });
  if (!article) {
    throw new Error(`${text} card not found`);
  }
  return article;
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

function tabByName(name: string): HTMLElement {
  const tab = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`${name} filter pill not found`);
  }
  return tab;
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

test("Browse workspace workflows", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch()]);

  await setupPage({
    context,
    path: "/workflows",
  });

  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
    expect(
      screen.getByRole("heading", { name: "Workflows" }),
    ).toBeInTheDocument();
  });
  expect(screen.getByText("Sales Research")).toBeInTheDocument();

  await user.hover(linkByAriaLabel("Open Sales Research"));
  await expect(screen.findByText("TU")).resolves.toBeInTheDocument();
});

test("Hide Official Workflow discovery when it is unavailable", async () => {
  mockWorkflowApis([officialSalesResearch()]);
  await setupPage({
    context,
    path: "/workflows",
    featureSwitches: {
      [FeatureSwitchKey.MorningBrief]: true,
      [FeatureSwitchKey.OfficialWorkflows]: false,
    },
  });
  await screen.findByRole("heading", { name: "Workflows" });
  expect(screen.queryByText("Browse Official")).not.toBeInTheDocument();
});

test("Redirect a cold Morning Brief detail to its preference", async () => {
  mockWorkflowApis([morningBriefWorkflow()]);
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      nextRunAt: null,
      timezone: "UTC",
      unavailableReason: null,
    });
  });

  await setupWorkflowDetailPage(
    `/workflows/${MORNING_BRIEF_WORKFLOW_ID}/automations`,
    {
      [FeatureSwitchKey.MorningBrief]: true,
      [FeatureSwitchKey.OfficialWorkflows]: false,
    },
  );

  await waitFor(() => {
    expect(pathname()).toBe("/agents");
    expect(search()).toBe("?settings=preference&focus=morning-brief");
  });
  await expect(
    screen.findByTestId("morning-brief-preference"),
  ).resolves.toBeVisible();
  expect(screen.queryByText("Instructions")).not.toBeInTheDocument();
});

test("Show Official Workflow discovery without requiring Morning Brief", async () => {
  mockWorkflowApis([officialSalesResearch()]);
  await setupPage({
    context,
    path: "/workflows",
    featureSwitches: {
      [FeatureSwitchKey.MorningBrief]: false,
      [FeatureSwitchKey.OfficialWorkflows]: true,
    },
  });

  await screen.findByRole("heading", { name: "Workflows" });
  expect(screen.getByText("Browse Official")).toBeVisible();
});

test.each(["sales-research", "morning-brief"])(
  "Show %s as installed in the Official Workflow catalog",
  async (definitionName) => {
    const installedWorkflow =
      definitionName === "morning-brief"
        ? morningBriefWorkflow()
        : officialSalesResearch();
    const {
      workflow: _workflow,
      lifecycle: _lifecycle,
      ...catalogEntry
    } = officialCatalogDetail();
    mockWorkflowApis([installedWorkflow]);
    context.mocks.api(officialWorkflowsContract.list, ({ respond }) => {
      return respond(200, [{ ...catalogEntry, name: definitionName }]);
    });

    await setupPage({
      context,
      path: "/workflows/official",
      featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
    });

    await waitFor(() => {
      expect(buttonByText("Installed")).toBeDisabled();
    });
    expect(screen.queryByText("View and install")).not.toBeInTheDocument();
  },
);

test("Retry the Official catalog when installation status is unavailable", async () => {
  const {
    workflow: _workflow,
    lifecycle: _lifecycle,
    ...catalogEntry
  } = officialCatalogDetail();
  let unavailable = true;
  context.mocks.api(officialWorkflowsContract.list, ({ respond }) => {
    return respond(200, [catalogEntry]);
  });
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    if (unavailable) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Workflows unavailable" },
      });
    }
    return respond(200, [summary(officialSalesResearch())]);
  });

  await setupPage({
    context,
    path: "/workflows/official",
    featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
  });

  await screen.findByText("Official Workflows could not be loaded");
  expect(screen.queryByText("View and install")).not.toBeInTheDocument();
  unavailable = false;
  click(buttonByText("Try again"));
  await waitFor(() => {
    expect(buttonByText("Installed")).toBeDisabled();
  });
});

test("Show the current status of a retired Official Workflow", async () => {
  const active = officialCatalogDetail("active");
  const { workflow: _workflow, lifecycle: _lifecycle, ...summary } = active;
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(officialWorkflowsContract.list, ({ respond }) => {
    return respond(200, [summary]);
  });
  context.mocks.api(officialWorkflowsContract.get, ({ params, respond }) => {
    return respond(
      200,
      officialCatalogDetail(
        params.definitionName === active.name ? "retired" : "active",
      ),
    );
  });

  await setupPage({
    context,
    path: "/workflows",
    featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
  });
  click(await screen.findByText("Browse Official"));
  await waitFor(() => {
    expect(pathname()).toBe("/workflows/official");
  });
  await expect(
    screen.findByText("View and install"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Sales")).toBeInTheDocument();

  click(screen.getByText("View and install"));
  await waitFor(() => {
    expect(pathname()).toBe("/workflows/official/sales-research");
  });
  await expect(
    screen.findByText("Retired Definition"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "This retained Definition can be viewed, but it can no longer be installed.",
    ),
  ).toBeInTheDocument();
  expect(queryButtonByText("Install")).toBeNull();
});

async function dismissOfficialWorkflowDialog(
  dialog: HTMLElement,
  dismissal: "Cancel" | "Close" | "Escape" | "backdrop",
) {
  if (dismissal === "Cancel") {
    click(buttonByText("Cancel", dialog));
  } else if (dismissal === "Close") {
    click(within(dialog).getByLabelText("Close"));
  } else if (dismissal === "Escape") {
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
  } else {
    const viewport = dialog.closest('[data-slot="dialog-viewport"]');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error("Expected the Official Workflow dialog viewport");
    }
    await userEvent.setup({ delay: null }).click(viewport);
  }
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

test.each(["Cancel", "Close", "Escape", "backdrop"] as const)(
  "Clear the previous Official Workflow install error after %s",
  async (dismissal) => {
    const definition = officialCatalogDetail();
    mockAgentPageApis();
    context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis([]);
    context.mocks.api(officialWorkflowsContract.get, ({ respond }) => {
      return respond(200, definition);
    });
    context.mocks.api(officialWorkflowsContract.install, ({ respond }) => {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Install failed" },
      });
    });
    await setupPage({
      context,
      path: `/workflows/official/${definition.name}`,
      featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
    });
    const installButton = await waitFor(() => {
      return buttonByText("Install");
    });
    click(installButton);
    const dialog = await screen.findByRole("dialog");
    await fill(
      within(dialog).getByLabelText("interval-seconds (required)"),
      "7200",
    );
    await userEvent
      .setup({ delay: null })
      .click(buttonByText("Install", dialog));
    await expect(
      within(dialog).findByText("Official Workflow could not be installed"),
    ).resolves.toBeVisible();
    expect(buttonByText("Install", dialog)).toBeEnabled();

    await dismissOfficialWorkflowDialog(dialog, dismissal);
    click(installButton);
    const reopened = await screen.findByRole("dialog");
    expect(
      within(reopened).getByLabelText("interval-seconds (required)"),
    ).toHaveValue(3600);
    expect(
      within(reopened).queryByText("Official Workflow could not be installed"),
    ).not.toBeInTheDocument();
    expect(buttonByText("Install", reopened)).toBeEnabled();

    click(buttonByText("Install", reopened));
    await expect(
      within(reopened).findByText("Official Workflow could not be installed"),
    ).resolves.toBeVisible();
  },
);

test("Install an Official Workflow with typed Blueprint settings", async () => {
  const definition = officialCatalogDetail();
  const {
    workflow: _workflow,
    lifecycle: _lifecycle,
    ...catalogEntry
  } = definition;
  const workflows: WorkflowDetailResponse[] = [];
  const installBodies: unknown[] = [];
  mockAgentPageApis();
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockWorkflowApis(workflows);
  context.mocks.api(officialWorkflowsContract.list, ({ respond }) => {
    return respond(200, [catalogEntry]);
  });
  context.mocks.api(officialWorkflowsContract.get, ({ respond }) => {
    return respond(200, definition);
  });
  context.mocks.api(officialWorkflowsContract.install, ({ body, respond }) => {
    installBodies.push(body);
    workflows.push(officialSalesResearch());
    return respond(201, {
      workflow: officialSalesResearch(),
      definition: {
        name: definition.name,
        revision: definition.revision,
        lifecycle: "active",
        blueprints: definition.blueprints,
      },
    });
  });

  await setupPage({
    context,
    path: "/workflows/official",
    featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
  });
  const viewAndInstall = await screen.findByText("View and install");
  click(viewAndInstall);
  click(
    await waitFor(() => {
      return buttonByText("Install");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Research Bot")).toBeInTheDocument();
  expect(within(dialog).getByLabelText("time-zone (required)")).toHaveValue(
    "UTC",
  );
  expect(
    within(dialog).getByLabelText("interval-seconds (required)"),
  ).toHaveValue(3600);
  expect(
    within(dialog).getByRole("combobox", {
      name: "include-weekends (required)",
    }),
  ).toHaveTextContent("No");
  fireEvent.change(
    within(dialog).getByLabelText("interval-seconds (required)"),
    { target: { value: "7200" } },
  );
  click(
    within(dialog).getByRole("combobox", {
      name: "include-weekends (required)",
    }),
  );
  click(await screen.findByRole("option", { name: "Yes" }));
  click(buttonByText("Install", dialog));

  await waitFor(() => {
    expect(installBodies).toStrictEqual([
      {
        agentId: AGENT_ID,
        blueprints: [
          {
            blueprintKey: "daily",
            bindings: [
              { key: "time-zone", value: "UTC" },
              { key: "interval-seconds", value: 7200 },
              { key: "include-weekends", value: true },
            ],
          },
        ],
      },
    ]);
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
  });
  await screen.findByText("Official Workflow");
  click(linkByText("Workflows"));
  const browseOfficial = await screen.findByText("Browse Official");
  click(browseOfficial);
  await waitFor(() => {
    expect(buttonByText("Installed")).toBeDisabled();
  });
});

test("Explain workflow visibility from the list", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch(), opsPlaybook()]);

  await setupPage({
    context,
    path: "/workflows",
  });

  const publicWorkflow = await waitFor(() => {
    return articleByText("Sales Research");
  });
  const publicIcon = within(publicWorkflow).getByLabelText("Public");
  await user.hover(publicIcon);
  await expect(
    screen.findByText("Public", {
      selector: '[data-slot="tooltip-content"]',
    }),
  ).resolves.toBeInTheDocument();

  await user.unhover(publicIcon);
  await waitFor(() => {
    expect(
      screen.queryByText("Public", {
        selector: '[data-slot="tooltip-content"]',
      }),
    ).not.toBeInTheDocument();
  });

  const privateWorkflow = articleByText("Ops Playbook");
  await user.hover(within(privateWorkflow).getByLabelText("Private"));
  await expect(
    screen.findByText("Private", {
      selector: '[data-slot="tooltip-content"]',
    }),
  ).resolves.toBeInTheDocument();
});

test("Identify existing Stripe automations in the workflow list", async () => {
  mockWorkflowApis([
    {
      ...salesResearch(),
      automations: [stripeInvoicePaidWorkflowAutomation()],
    },
  ]);

  await setupPage({
    context,
    path: "/workflows",
    featureSwitches: {
      [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: false,
    },
  });

  const stripePill = await waitFor(() => {
    return buttonByText(/^Stripe$/u);
  });
  click(stripePill);
  await expect(
    screen.findByText("When a matching Stripe invoice is paid"),
  ).resolves.toBeInTheDocument();
});

test("Open a workflow from the workspace", async () => {
  mockWorkflowApis([salesResearch()]);
  mockConnectedAutomationConnectors();

  await setupPage({
    context,
    path: `/workflows/${SALES_WORKFLOW_ID}/automations`,
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
    expect(screen.getAllByText("Sales Research").length).toBeGreaterThan(0);
  });
  expect(screen.queryByText("Workflow not found.")).not.toBeInTheDocument();
});

test("Filter workflows by automation and visibility", async () => {
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockAgentPageApis();
  mockChatLifecycle(context);
  mockWorkflowApis([
    salesResearch(),
    opsPlaybook(),
    launchChecklistWorkflow(),
    otherAgentWorkflow(),
  ]);

  await setupPage({
    context,
    path: "/workflows",
  });

  await waitFor(() => {
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  });
  expect(search()).toBe("");

  // The default "All" view lists every workspace workflow.
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();

  // The automated workflow surfaces its connector pill on the row.
  const salesCard = articleByText("Sales Research");
  expect(within(salesCard).getByText("Schedule")).toBeInTheDocument();

  const supportLink = linkByAriaLabel("Open Support Intake");
  expect(supportLink).toHaveAttribute(
    "href",
    `/workflows/${OTHER_WORKFLOW_ID}/automations`,
  );

  // "Automated" keeps only workflows that have at least one automation.
  click(tabByName("Automated"));
  await waitFor(() => {
    expect(search()).toBe("?filter=automated");
  });
  expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();
  expect(screen.queryByText("Launch Checklist")).not.toBeInTheDocument();
  expect(screen.queryByText("Support Intake")).not.toBeInTheDocument();

  // "Manual" keeps only the manual workflows.
  click(tabByName("Manual"));
  await waitFor(() => {
    expect(search()).toBe("?filter=without");
  });
  expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();

  // The pills are a single mutually-exclusive group: selecting "Private"
  // replaces the automation selection rather than combining with it.
  click(tabByName("Private"));
  await waitFor(() => {
    expect(search()).toBe("?filter=private");
  });
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();
  expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
  expect(screen.queryByText("Support Intake")).not.toBeInTheDocument();

  // "Public" keeps only the public workflows.
  click(tabByName("Public"));
  await waitFor(() => {
    expect(search()).toBe("?filter=public");
  });
  expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
  expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();
  expect(screen.queryByText("Launch Checklist")).not.toBeInTheDocument();

  // Clearing the filter returns to the full list.
  click(tabByName("All"));
  await waitFor(() => {
    expect(search()).toBe("");
  });
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
});

test("Start creating a workflow in an agent chat", async () => {
  mockAgentPageApis();
  mockChatLifecycle(context);
  mockWorkflowApis([salesResearch()]);

  await setupPage({
    context,
    path: "/workflows",
  });

  const createInChat = await waitFor(() => {
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    return buttonByText(/create in chat/i);
  });
  click(createInChat);
  const dialog = await screen.findByRole("dialog", {
    name: "Create workflow",
  });
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByText("Research Bot")).toBeInTheDocument();
  expect(within(dialog).getByText("Support Bot")).toBeInTheDocument();

  click(buttonByText("Research Bot", dialog));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  });
  await expectComposerText("desired outcome");
  const editor = await findComposerEditor();
  expect(editor).toHaveTextContent("automation");
});

test("Filter workflows by agent", async () => {
  mockAgentPageApis();
  mockWorkflowApis([salesResearch(), opsPlaybook(), otherAgentWorkflow()]);

  await setupPage({
    context,
    path: "/workflows",
  });

  await waitFor(() => {
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  });
  // Every agent's workflows show under the default "All agents" scope.
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();

  // Scope the list to a single agent via the agent dropdown.
  click(buttonByText("All agents"));
  click(menuItemByText("Support Bot"));
  await waitFor(() => {
    expect(search()).toBe(`?agent=${OTHER_AGENT_ID}`);
  });
  expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
  expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
  expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();

  // The automation reflects the active agent; clearing returns everything.
  click(buttonByText("Support Bot"));
  click(menuItemByText("All agents"));
  await waitFor(() => {
    expect(search()).toBe("");
  });
  expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
  expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
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
  const gmailRow = document.querySelector(
    `[data-automation-id="${GMAIL_AUTOMATION_ID}"]`,
  );
  const weekdayRow = document.querySelector(
    '[data-automation-id="workflow-automation-weekday-brief"]',
  );
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

test("Keep Automations usable when a direct link is stale", async () => {
  context.mocks.data.userPreferences({ timezone: "UTC" });
  const scrollIntoView = installScrollIntoViewMock();
  mockWorkflowApis([salesResearch()]);

  await setupWorkflowDetailPage(
    `${workflowDetailPath("automations")}?automationId=deleted-automation`,
  );

  await expect(
    screen.findByRole("switch", {
      name: "Disable Every weekday at 9:00 AM",
    }),
  ).resolves.toBeInTheDocument();
  expect(document.querySelector('[aria-current="true"]')).toBeNull();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("Handle a direct automation link to an unavailable workflow", async () => {
  const scrollIntoView = installScrollIntoViewMock();
  mockWorkflowApis([]);

  await setupWorkflowDetailPage(
    `${workflowDetailPath("automations")}?automationId=${GMAIL_AUTOMATION_ID}`,
  );

  await expect(
    screen.findByText("Workflow not found."),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
  expect(search()).toBe(`?automationId=${GMAIL_AUTOMATION_ID}`);
  expect(document.querySelector('[aria-current="true"]')).toBeNull();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("Block workflow publishing without permission on the owning agent", async () => {
  const workflow = {
    ...opsPlaybook(),
    canManage: true,
    canPublish: false,
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

test("Present workflow settings in a task-focused order", async () => {
  mockWorkflowApis([salesResearch()]);

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  await waitFor(() => {
    expect(screen.getAllByText("Visibility").length).toBeGreaterThan(0);
  });

  const pageText = textFor(document.body);
  expect(pageText).not.toContain("Created by");
  expect(pageText).not.toContain("Last updated by");
  expect(pageText).not.toContain("Jun 17, 2026");
  expect(pageText).not.toContain("Jun 20, 2026");
  expect(pageText.indexOf("Slug")).toBeLessThan(pageText.indexOf("Visibility"));
  expect(pageText.indexOf("Visibility")).toBeLessThan(
    pageText.indexOf("Copy workflow"),
  );
  expect(pageText.indexOf("Copy workflow")).toBeLessThan(
    pageText.indexOf("Delete workflow"),
  );
});

test("Confirm before making a public workflow private", async () => {
  const demotedIds: string[] = [];
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(
    workflowVisibilityContract.demote,
    ({ params, respond }) => {
      demotedIds.push(params.workflowId);
      return respond(
        200,
        summary({ ...salesResearch(), visibility: "private" }),
      );
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  const toggle = await screen.findByRole("switch", {
    name: "Make workflow public",
  });
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);

  // Demoting a public workflow now requires an explicit confirmation.
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Make this workflow private?"),
  ).toBeInTheDocument();
  expect(demotedIds).toStrictEqual([]);

  // Cancelling leaves the workflow public and fires no request.
  click(buttonByText("Cancel", dialog));
  await waitFor(() => {
    expect(
      screen.queryByText("Make this workflow private?"),
    ).not.toBeInTheDocument();
  });
  expect(demotedIds).toStrictEqual([]);

  // Reopening and confirming demotes the workflow.
  fireEvent.click(
    await screen.findByRole("switch", { name: "Make workflow public" }),
  );
  const confirmDialog = await screen.findByRole("dialog");
  click(buttonByText("Make private", confirmDialog));
  await waitFor(() => {
    expect(demotedIds).toStrictEqual([SALES_WORKFLOW_ID]);
  });
});

test("Keep a retired Official Workflow operable but structurally read-only", async () => {
  const workflow = officialSalesResearch("retired", "needs_reconfiguration");
  const definition = officialCatalogDetail("retired");
  mockAgentPageApis();
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockWorkflowApis([workflow]);
  context.mocks.api(
    officialWorkflowInstallationsContract.get,
    ({ respond }) => {
      return respond(200, {
        workflow,
        definition: {
          name: definition.name,
          revision: definition.revision,
          lifecycle: "retired",
          blueprints: definition.blueprints,
        },
      });
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  await expect(
    screen.findByText("Official Workflow retired"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Needs reconfiguration · intended on"),
  ).toBeInTheDocument();
  expect(buttonByText("Run now")).toBeEnabled();
  expect(screen.getByRole("switch")).toBeEnabled();
  expect(screen.queryByText("Add automation")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Edit automation")).not.toBeInTheDocument();
  expect(screen.queryByText("Delete automation")).not.toBeInTheDocument();
  expect(screen.queryByText(/Refine with/)).not.toBeInTheDocument();

  click(buttonByText("Settings"));
  await waitFor(() => {
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });
  expect(screen.getByLabelText("Slug")).toBeDisabled();
  expect(screen.getByLabelText("Description")).toBeDisabled();
  expect(
    screen.getByRole("switch", { name: "Make workflow public" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByText("Delete workflow")).not.toBeInTheDocument();
  expect(buttonByText("Reconfigure")).toBeInTheDocument();
  expect(buttonByText("Uninstall")).toBeInTheDocument();

  click(buttonByText("Instructions"));
  const instructions = await screen.findByLabelText("Workflow instruction");
  expect(instructions).toHaveAttribute("contenteditable", "false");
  click(screen.getByLabelText("Workflow files"));
  expect(screen.queryByText("Upload text files")).not.toBeInTheDocument();
  expect(screen.queryByText("Delete selected file")).not.toBeInTheDocument();
});

async function expectOfficialReconciliation(
  status: "current" | "reconciling" | "needs_reconfiguration" | "failed",
  label: string,
): Promise<HTMLElement> {
  mockWorkflowApis([officialSalesResearch("active", status)]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  const reconciliation = await screen.findByText(label);
  expect(reconciliation).toBeInTheDocument();
  expect(screen.getByText("Official Workflow")).toBeInTheDocument();
  return reconciliation;
}

test("Show an Official Workflow that needs reconfiguration", async () => {
  await expect(
    expectOfficialReconciliation(
      "needs_reconfiguration",
      "Needs reconfiguration · intended on",
    ),
  ).resolves.toBeInTheDocument();
});

test.each(["Cancel", "Close", "Escape", "backdrop"] as const)(
  "Clear the previous Official Workflow reconfigure error after %s",
  async (dismissal) => {
    const workflow = officialSalesResearch();
    const definition = officialCatalogDetail();
    mockAgentPageApis();
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis([workflow]);
    context.mocks.api(
      officialWorkflowInstallationsContract.get,
      ({ respond }) => {
        return respond(200, {
          workflow,
          definition: {
            name: definition.name,
            revision: definition.revision,
            lifecycle: "active",
            blueprints: definition.blueprints,
          },
        });
      },
    );
    context.mocks.api(
      officialWorkflowInstallationsContract.reconfigure,
      ({ respond }) => {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Reconfigure failed",
          },
        });
      },
    );
    await setupWorkflowDetailPage(workflowDetailPath("info"));
    const reconfigureButton = await waitFor(() => {
      return buttonByText("Reconfigure");
    });
    click(reconfigureButton);
    const dialog = await screen.findByRole("dialog");
    await fill(
      within(dialog).getByLabelText("interval-seconds (required)"),
      "7200",
    );
    await userEvent
      .setup({ delay: null })
      .click(buttonByText("Reconfigure", dialog));
    await expect(
      within(dialog).findByText("Official Workflow could not be reconfigured"),
    ).resolves.toBeVisible();
    expect(buttonByText("Reconfigure", dialog)).toBeEnabled();

    await dismissOfficialWorkflowDialog(dialog, dismissal);
    click(reconfigureButton);
    const reopened = await screen.findByRole("dialog");
    expect(
      within(reopened).getByLabelText("interval-seconds (required)"),
    ).toHaveValue(3600);
    expect(
      within(reopened).queryByText(
        "Official Workflow could not be reconfigured",
      ),
    ).not.toBeInTheDocument();
    expect(buttonByText("Reconfigure", reopened)).toBeEnabled();

    click(buttonByText("Reconfigure", reopened));
    await expect(
      within(reopened).findByText(
        "Official Workflow could not be reconfigured",
      ),
    ).resolves.toBeVisible();
  },
);

test.each(["Install", "Reconfigure"] as const)(
  "Keep an Official Workflow %s submission disabled until failure and allow retry",
  async (operation) => {
    const workflow = officialSalesResearch();
    const definition = officialCatalogDetail();
    const response = context.mocks.deferred<void>();
    const installing = operation === "Install";
    mockAgentPageApis();
    context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis(installing ? [] : [workflow]);
    context.mocks.api(officialWorkflowsContract.get, ({ respond }) => {
      return respond(200, definition);
    });
    context.mocks.api(
      officialWorkflowsContract.install,
      async ({ respond, withSignal }) => {
        await withSignal(response.promise);
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Install failed" },
        });
      },
    );
    context.mocks.api(
      officialWorkflowInstallationsContract.get,
      ({ respond }) => {
        return respond(200, {
          workflow,
          definition: {
            name: definition.name,
            revision: definition.revision,
            lifecycle: "active",
            blueprints: definition.blueprints,
          },
        });
      },
    );
    context.mocks.api(
      officialWorkflowInstallationsContract.reconfigure,
      async ({ respond, withSignal }) => {
        await withSignal(response.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Reconfigure failed",
          },
        });
      },
    );
    await setupPage({
      context,
      path: installing
        ? `/workflows/official/${definition.name}`
        : workflowDetailPath("info"),
      featureSwitches: { [FeatureSwitchKey.OfficialWorkflows]: true },
    });
    const openButton = await waitFor(() => {
      return buttonByText(operation);
    });
    click(openButton);
    const dialog = await screen.findByRole("dialog");
    click(buttonByText(operation, dialog));
    await waitFor(() => {
      expect(buttonByText(operation, dialog)).toBeDisabled();
    });
    response.resolve();
    await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
      installing
        ? "Official Workflow could not be installed"
        : "Official Workflow could not be reconfigured",
    );
    expect(buttonByText(operation, dialog)).toBeEnabled();
  },
);

test("Reconfigure typed settings for an Official Workflow", async () => {
  const workflow = officialSalesResearch("retired");
  const definition = officialCatalogDetail("retired");
  const reconfigureBodies: unknown[] = [];
  mockAgentPageApis();
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockWorkflowApis([workflow]);
  context.mocks.api(
    officialWorkflowInstallationsContract.get,
    ({ respond }) => {
      return respond(200, {
        workflow,
        definition: {
          name: definition.name,
          revision: definition.revision,
          lifecycle: "retired",
          blueprints: definition.blueprints,
        },
      });
    },
  );
  context.mocks.api(
    officialWorkflowInstallationsContract.reconfigure,
    ({ body, respond }) => {
      reconfigureBodies.push(body);
      return respond(200, {
        workflow,
        definition: {
          name: definition.name,
          revision: definition.revision,
          lifecycle: "retired",
          blueprints: definition.blueprints,
        },
      });
    },
  );
  await setupWorkflowDetailPage(workflowDetailPath("info"));
  click(
    await waitFor(() => {
      return buttonByText("Reconfigure");
    }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByLabelText("interval-seconds (required)"),
  ).toHaveValue(3600);
  fireEvent.change(within(dialog).getByLabelText("time-zone (required)"), {
    target: { value: "Asia/Shanghai" },
  });
  fireEvent.change(
    within(dialog).getByLabelText("interval-seconds (required)"),
    { target: { value: "1800" } },
  );
  click(
    within(dialog).getByRole("combobox", {
      name: "include-weekends (required)",
    }),
  );
  click(await screen.findByRole("option", { name: "Yes" }));
  click(buttonByText("Reconfigure", dialog));
  await waitFor(() => {
    expect(reconfigureBodies).toStrictEqual([
      {
        blueprints: [
          {
            blueprintKey: "daily",
            bindings: [
              { key: "time-zone", value: "Asia/Shanghai" },
              { key: "interval-seconds", value: 1800 },
              { key: "include-weekends", value: true },
            ],
          },
        ],
      },
    ]);
  });
});

test.each(["active", "retired"] as const)(
  "Uninstall an %s Official Workflow",
  async (lifecycle) => {
    const workflow = officialSalesResearch(lifecycle);
    const workflows = [workflow];
    const definition = officialCatalogDetail(lifecycle);
    const {
      workflow: _workflow,
      lifecycle: _lifecycle,
      ...catalogEntry
    } = definition;
    const uninstalledWorkflowIds: string[] = [];
    mockAgentPageApis();
    mockWorkflowApis(workflows);
    context.mocks.api(officialWorkflowsContract.list, ({ respond }) => {
      return respond(200, lifecycle === "active" ? [catalogEntry] : []);
    });
    context.mocks.api(
      officialWorkflowInstallationsContract.get,
      ({ respond }) => {
        return respond(200, {
          workflow,
          definition: {
            name: definition.name,
            revision: definition.revision,
            lifecycle,
            blueprints: definition.blueprints,
          },
        });
      },
    );
    context.mocks.api(
      officialWorkflowInstallationsContract.uninstall,
      ({ params, respond }) => {
        uninstalledWorkflowIds.push(params.workflowId);
        workflows.splice(0, workflows.length);
        return respond(204);
      },
    );

    await setupWorkflowDetailPage(workflowDetailPath("info"), {
      [FeatureSwitchKey.OfficialWorkflows]: true,
    });

    const uninstall = await waitFor(() => {
      return buttonByText("Uninstall");
    });
    click(uninstall);
    const uninstallDialog = await screen.findByRole("dialog");
    click(buttonByText("Uninstall", uninstallDialog));

    await waitFor(() => {
      expect(uninstalledWorkflowIds).toStrictEqual([SALES_WORKFLOW_ID]);
    });
    await waitFor(() => {
      expect(pathname()).toBe("/workflows");
    });
    const browseOfficial = await screen.findByText("Browse Official");
    click(browseOfficial);
    await screen.findByText(
      lifecycle === "active"
        ? "View and install"
        : "No Official Workflows are available.",
    );
    expect(queryButtonByText("Installed")).toBeNull();
  },
);

test("Do not carry an Official reconfiguration draft to another installation", async () => {
  const definition = officialCatalogDetail("retired");
  const firstWorkflow = officialSalesResearch("retired");
  const secondFixture = officialSalesResearch("retired");
  const [secondAutomation] = secondFixture.automations;
  if (!secondAutomation?.official) {
    throw new Error("Expected the second Official Workflow automation");
  }
  const secondWorkflow: WorkflowDetailResponse = {
    ...secondFixture,
    id: OTHER_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    displayName: "Support Sales Research",
    automations: [
      {
        ...secondAutomation,
        id: "workflow-automation-official-support",
        official: {
          ...secondAutomation.official,
          parameterBindings: [
            { key: "time-zone", value: "America/New_York" },
            { key: "interval-seconds", value: 7200 },
            { key: "include-weekends", value: true },
          ],
        },
      },
    ],
  };
  const workflows = [firstWorkflow, secondWorkflow];
  const installationReads: string[] = [];
  const reconfigureRequests: unknown[] = [];
  mockAgentPageApis();
  context.mocks.data.userPreferences({ timezone: "UTC" });
  mockWorkflowApis(workflows);
  context.mocks.api(
    officialWorkflowInstallationsContract.get,
    ({ params, respond }) => {
      installationReads.push(params.workflowId);
      const workflow = workflows.find((candidate) => {
        return candidate.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, {
        workflow,
        definition: {
          name: definition.name,
          revision: definition.revision,
          lifecycle: "retired",
          blueprints: definition.blueprints,
        },
      });
    },
  );
  context.mocks.api(
    officialWorkflowInstallationsContract.reconfigure,
    ({ params, body, respond }) => {
      reconfigureRequests.push({ workflowId: params.workflowId, body });
      return respond(200, {
        workflow: secondWorkflow,
        definition: {
          name: definition.name,
          revision: definition.revision,
          lifecycle: "retired",
          blueprints: definition.blueprints,
        },
      });
    },
  );

  await setupWorkflowDetailPage("/workflows");
  click(
    await waitFor(() => {
      return linkByAriaLabel("Open Sales Research");
    }),
  );
  click(
    await waitFor(() => {
      return buttonByText("Settings");
    }),
  );
  click(
    await waitFor(() => {
      return buttonByText("Reconfigure");
    }),
  );
  const firstDialog = await screen.findByRole("dialog");
  fireEvent.change(within(firstDialog).getByLabelText("time-zone (required)"), {
    target: { value: "Asia/Shanghai" },
  });
  fireEvent.change(
    within(firstDialog).getByLabelText("interval-seconds (required)"),
    { target: { value: "1800" } },
  );

  window.history.back();
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  click(linkByAriaLabel("Open Support Sales Research"));
  click(
    await waitFor(() => {
      return buttonByText("Settings");
    }),
  );
  await waitFor(() => {
    expect(installationReads.at(-1)).toBe(OTHER_WORKFLOW_ID);
    expect(pathname()).toBe(`/workflows/${OTHER_WORKFLOW_ID}/info`);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  click(buttonByText("Reconfigure"));
  const secondDialog = await screen.findByRole("dialog");
  expect(
    within(secondDialog).getByLabelText("time-zone (required)"),
  ).toHaveValue("America/New_York");
  expect(
    within(secondDialog).getByLabelText("interval-seconds (required)"),
  ).toHaveValue(7200);
  expect(
    within(secondDialog).getByRole("combobox", {
      name: "include-weekends (required)",
    }),
  ).toHaveTextContent("Yes");
  fireEvent.change(
    within(secondDialog).getByLabelText("time-zone (required)"),
    { target: { value: "Europe/London" } },
  );
  click(buttonByText("Reconfigure", secondDialog));

  await waitFor(() => {
    expect(reconfigureRequests).toStrictEqual([
      {
        workflowId: OTHER_WORKFLOW_ID,
        body: {
          blueprints: [
            {
              blueprintKey: "daily",
              bindings: [
                { key: "interval-seconds", value: 7200 },
                { key: "include-weekends", value: true },
                { key: "time-zone", value: "Europe/London" },
              ],
            },
          ],
        },
      },
    ]);
  });
});

test("Preserve a copied Official Workflow when uninstalling the original fails", async () => {
  const workflow = officialSalesResearch();
  const copiedWorkflow: WorkflowDetailResponse = {
    ...salesResearch(),
    id: COPIED_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    visibility: "private",
    automations: [],
  };
  const disabledAutomationIds: string[] = [];
  const deletedWorkflowIds: string[] = [];
  const uninstallRequests: string[] = [];
  mockAgentPageApis();
  mockWorkflowApis([workflow, copiedWorkflow]);
  mockDisableWorkflowAutomation((automationId) => {
    disabledAutomationIds.push(automationId);
  });
  mockDeleteWorkflow([workflow], (workflowId) => {
    deletedWorkflowIds.push(workflowId);
  });
  context.mocks.api(workflowsDetailContract.copy, ({ respond }) => {
    return respond(201, summary(copiedWorkflow));
  });
  context.mocks.api(
    officialWorkflowInstallationsContract.uninstall,
    ({ params, respond }) => {
      uninstallRequests.push(params.workflowId);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Uninstall failed" },
      });
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("info"));
  const dialog = await openCopyDialog();
  selectOptionByLabel("Copy to", "Support Bot", dialog);
  await userEvent.setup().click(within(dialog).getByRole("checkbox"));
  click(buttonByText("Copy and remove", dialog));

  await waitFor(() => {
    expect(uninstallRequests).toStrictEqual([SALES_WORKFLOW_ID]);
  });
  expect(disabledAutomationIds).toStrictEqual([]);
  expect(deletedWorkflowIds).toStrictEqual([]);
  await waitFor(() => {
    expect(pathname()).toBe(`/workflows/${COPIED_WORKFLOW_ID}/automations`);
  });
  await expect(
    screen.findByText(
      "The copy is ready, but the original Official Workflow could not be uninstalled.",
    ),
  ).resolves.toBeInTheDocument();
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

test("Recover when copying a workflow fails", async () => {
  mockAgentPageApis();
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowsDetailContract.copy, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message: "Failed to copy workflow",
      },
    });
  });

  await setupWorkflowDetailPage(workflowDetailPath("info"));

  const dialog = await openCopyDialog();
  selectOptionByLabel("Copy to", "Support Bot", dialog);
  click(buttonByText(/^Copy workflow$/, dialog));

  await expect(
    screen.findByText("Failed to copy workflow"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText(/Copied to/)).not.toBeInTheDocument();
  expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
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

test("Summarize Gmail automation match conditions", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [...workflowAutomations(), gmailWorkflowAutomation()],
  };
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(0);
  });

  await waitFor(() => {
    expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(0);
  });
  expect(screen.getByText(/from contains "@acme.com"/)).toBeInTheDocument();
  expect(
    screen.getByText(/subject does not contain "newsletter"/),
  ).toBeInTheDocument();
  // Only the schedule automation shows a "Next" run stat; event automations omit it.
  expect(screen.getAllByText("Next")).toHaveLength(1);
});

test("Run a workflow automation now", async () => {
  const runAutomationIds: string[] = [];
  mockWorkflowApis([salesResearch()]);
  mockChatLifecycle(context, { threadId: AUTOMATION_RUN_THREAD_ID });
  mockRunWorkflowAutomation((automationId) => {
    runAutomationIds.push(automationId);
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

test("Create a Gmail label-applied automation", async () => {
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
  pickAutomation("Email", /^Gmail label applied/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Gmail label automation",
  });
  await fill(
    within(createAutomationForm).getByLabelText("Label name"),
    "Support",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Support",
      },
    });
  });
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
  await fill(within(form).getByLabelText("Repositories"), "vm0-ai/vm0");
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
          repositories: ["vm0-ai/vm0"],
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

test("Ask an administrator to install GitHub when self-service is unavailable", async () => {
  mockWorkflowApis([salesResearch()]);
  setMockGithubIntegration(null);
  context.mocks.api(
    integrationsGithubContract.getInstallation,
    ({ respond }) => {
      return respond(404, {
        error: {
          message: "GitHub installation not found",
          code: "NOT_FOUND",
        },
        installUrl: null,
      });
    },
  );

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
    expect(
      within(form).getByText("Ask an organization admin to install it."),
    ).toBeInTheDocument();
  });
  expect(queryAllByRoleFast("link", form)).toHaveLength(0);
});

test("Create a filtered GitHub issue-comment automation", async () => {
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
  pickAutomation("GitHub", /^GitHub issue comment created/);

  const form = await screen.findByRole("form", {
    name: "Add GitHub issue comment created automation",
  });
  await waitFor(() => {
    expect(within(form).getByLabelText("Trusted authors")).toBeEnabled();
  });
  await fill(within(form).getByLabelText("Repositories"), "vm0-ai/vm0");
  selectOptionByLabel("Subject", "Pull requests only", form);
  fireEvent.change(within(form).getByLabelText("Trusted authors"), {
    target: { value: "e7h4n, lancy" },
  });
  fireEvent.change(within(form).getByLabelText("Comment prefixes"), {
    target: { value: "/verify, /deploy" },
  });
  fireEvent.submit(form);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "github-issue-comment-created",
      eventConfig: {
        provider: "github",
        event: "issue_comment_created",
        filters: {
          repositories: ["vm0-ai/vm0"],
          subject: "pull_requests",
          trustedAuthors: ["e7h4n", "lancy"],
          commentPrefixes: ["/verify", "/deploy"],
        },
      },
    });
  });
});

test("Create a Google Calendar event-updated automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"), {});

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Calendar", /^Google Calendar event updated/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Google Calendar automation",
  });
  await fill(
    within(createAutomationForm).getByLabelText("Calendar ID"),
    "team@example.com",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "team@example.com",
      },
    });
  });
});

test("Create a Google Calendar event-cancelled automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"), {});

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Calendar", /^Google Calendar event cancelled/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Google Calendar automation",
  });
  await fill(
    within(createAutomationForm).getByLabelText("Calendar ID"),
    "team@example.com",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "google-calendar-event-cancelled",
      eventConfig: {
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "team@example.com",
      },
    });
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
  {
    label: "updated",
    automation: googleCalendarUpdatedWorkflowAutomation({
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "missing-updated@example.com",
      },
      warning: "calendar_not_found",
    }),
    expectedEventConfig: {
      provider: "google-calendar",
      event: "event_updated",
      calendarId: "replacement@example.com",
    },
  },
  {
    label: "cancelled",
    automation: googleCalendarCancelledWorkflowAutomation({
      eventConfig: {
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "missing-cancelled@example.com",
      },
      warning: "calendar_not_found",
    }),
    expectedEventConfig: {
      provider: "google-calendar",
      event: "event_cancelled",
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
    const workflow = { ...salesResearch(), automations: [automation] };
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

test("Keep the Calendar recovery editor open and disabled while the update is pending", async () => {
  const automation = googleCalendarWorkflowAutomation({
    warning: "calendar_not_found",
  });
  const workflow: WorkflowDetailResponse = {
    ...salesResearch(),
    automations: [automation],
  };
  const updateGate = context.mocks.deferred<void>();
  mockWorkflowApis([workflow]);
  context.mocks.api(
    workflowAutomationsContract.update,
    async ({ body, params, respond }) => {
      if (
        !("eventConfig" in body) ||
        body.eventConfig.provider !== "google-calendar"
      ) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Expected Calendar update" },
        });
      }
      await updateGate.promise;
      const updated = applyGoogleCalendarAutomationUpdate(
        automation,
        body.eventConfig,
      );
      workflow.automations[0] = updated;
      return respond(200, { ...updated, id: params.id });
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  const warning = await screen.findByRole("alert");
  click(buttonByText("Change calendar", warning));
  const form = await screen.findByRole("form", {
    name: "Change Google Calendar automation",
  });
  const calendarId = within(form).getByLabelText("Calendar ID");
  await fill(calendarId, "replacement@example.com");
  fireEvent.submit(form);

  await waitFor(() => {
    expect(calendarId).toBeDisabled();
    expect(buttonByText("Save calendar", form)).toBeDisabled();
    expect(form).toBeInTheDocument();
  });
  updateGate.resolve();
  await waitFor(() => {
    expect(
      screen.queryByRole("form", {
        name: "Change Google Calendar automation",
      }),
    ).not.toBeInTheDocument();
  });
});

test("Keep the Calendar recovery editor open with an inline error when the update fails", async () => {
  const automation = googleCalendarWorkflowAutomation({
    warning: "calendar_not_found",
  });
  const workflow = { ...salesResearch(), automations: [automation] };
  mockWorkflowApis([workflow]);
  context.mocks.api(workflowAutomationsContract.update, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: "Calendar update failed" },
    });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  click(buttonByText("Change calendar", await screen.findByRole("alert")));
  const form = await screen.findByRole("form", {
    name: "Change Google Calendar automation",
  });
  await fill(
    within(form).getByLabelText("Calendar ID"),
    "replacement@example.com",
  );
  fireEvent.submit(form);

  const updateError = await within(form).findByRole("alert");
  expect(updateError).toHaveTextContent(
    "We couldn't change this calendar. Try again.",
  );
  expect(within(form).getByLabelText("Calendar ID")).toBeEnabled();
  expect(form).toBeInTheDocument();
});

test("Accept a server-normalized Calendar ID after recovery", async () => {
  const automation = googleCalendarWorkflowAutomation({
    eventConfig: {
      provider: "google-calendar",
      event: "event_created",
      calendarId: "missing@example.com",
    },
    warning: "calendar_not_found",
  });
  const workflow: WorkflowDetailResponse = {
    ...salesResearch(),
    automations: [automation],
  };
  mockWorkflowApis([workflow]);
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ body, params, respond }) => {
      if (
        !("eventConfig" in body) ||
        body.eventConfig.provider !== "google-calendar"
      ) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Expected Calendar update" },
        });
      }
      const normalized = applyGoogleCalendarAutomationUpdate(automation, {
        ...body.eventConfig,
        calendarId: "primary",
      });
      workflow.automations[0] = normalized;
      return respond(200, { ...normalized, id: params.id });
    },
  );

  await setupWorkflowDetailPage(workflowDetailPath("automations"));
  click(buttonByText("Change calendar", await screen.findByRole("alert")));
  const form = await screen.findByRole("form", {
    name: "Change Google Calendar automation",
  });
  await fill(within(form).getByLabelText("Calendar ID"), "owner@example.com");
  fireEvent.submit(form);

  await waitFor(() => {
    expect(
      screen.queryByRole("form", {
        name: "Change Google Calendar automation",
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  const enabledSwitch = await screen.findByRole("switch", {
    name: "Disable Google Calendar event created",
  });
  const row = enabledSwitch.closest("[data-automation-id]");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the reloaded Calendar automation row");
  }
  click(buttonByText("Edit automation", row));
  const normalizedForm = await screen.findByRole("form", {
    name: "Change Google Calendar automation",
  });
  expect(within(normalizedForm).getByLabelText("Calendar ID")).toHaveValue(
    "primary",
  );
});

test.each(["calendar_not_found", "reconnect_required"] as const)(
  "Show the %s Calendar warning without recovery mutations for another user's automation",
  async (warning) => {
    const automation = googleCalendarWorkflowAutomation({
      ownerUserId: UPDATED_USER_ID,
      warning,
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
  },
);

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

test("Keep a healthy Calendar automation on the existing workflow surfaces", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [googleCalendarWorkflowAutomation()],
  };
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  const enabledSwitch = await screen.findByRole("switch", {
    name: "Disable Google Calendar event created",
  });
  expect(enabledSwitch).toBeChecked();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("Change calendar")).not.toBeInTheDocument();

  const row = enabledSwitch.closest("[data-automation-id]");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the Calendar automation row");
  }
  click(buttonByText("Edit automation", row));
  const form = await screen.findByRole("form", {
    name: "Change Google Calendar automation",
  });
  expect(within(form).getByLabelText("Calendar ID")).toHaveValue("primary");
});

function mockCalendarReconnect(
  workflow: WorkflowDetailResponse,
  selectedAccount: "work" | "personal" = "personal",
) {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  let healthyAccount = googleCalendarAccount({
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
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: healthyAccount.target,
          accountCount: 2,
          attentionCount:
            reconnectAccount.connectionStatus === "reconnect-required" ? 1 : 0,
          defaultConnection: healthyAccount,
        },
      ],
    });
  });
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
      const healthyRow = within(manager).getByRole("group", {
        name: "Work Calendar",
      });
      const reconnectRow = within(manager).getByRole("group", {
        name: "Personal Calendar",
      });
      expect(healthyRow).toHaveTextContent("Connected");
      expect(reconnectRow).toHaveTextContent("Reconnect required");
      expect(submittedAccounts).toStrictEqual([]);
      expect(queryButtonByText("Reconnect", healthyRow)).toBeNull();
      if (selectedAccount === "personal") {
        click(buttonByText("Reconnect", reconnectRow));
      } else {
        click(buttonByText("Account actions", healthyRow));
        const menu = await screen.findByRole("menu");
        const reconnectItem = queryAllByRoleFast("menuitem", menu).find(
          (item) => {
            return textFor(item) === "Reconnect";
          },
        );
        if (!reconnectItem) {
          throw new Error("Expected account reconnect action");
        }
        click(reconnectItem);
      }

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
          connectionId:
            selectedAccount === "personal"
              ? reconnectAccount.id
              : healthyAccount.id,
        },
      ]);
    },
    complete: () => {
      completedAttempts.set(
        oauthAttemptId,
        selectedAccount === "work" ? healthyAccount.id : reconnectAccount.id,
      );
      if (selectedAccount === "work") {
        healthyAccount = {
          ...healthyAccount,
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
      } else {
        reconnectAccount = {
          ...reconnectAccount,
          connectionStatus: "connected",
          reconnectReason: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
      }
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-calendar",
      });
    },
  };
}

test("Converge Calendar recovery after the first stale summary without another connector event", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [
      googleCalendarWorkflowAutomation({ warning: "reconnect_required" }),
    ],
  };
  const reconnect = mockCalendarReconnect(workflow);
  const firstRead = context.mocks.deferred<void>();
  const watchRecovery = context.mocks.deferred<void>();
  let oauthCompleted = false;
  let returnedStaleSummary = false;
  context.mocks.api(workflowsDetailContract.get, async ({ respond }) => {
    if (oauthCompleted && !returnedStaleSummary) {
      returnedStaleSummary = true;
      const response = respond(200, publicWorkflowDetail(workflow));
      firstRead.resolve();
      return response;
    }
    if (oauthCompleted) {
      await watchRecovery.promise;
    }
    return respond(200, publicWorkflowDetail(workflow));
  });
  await reconnect.open();
  oauthCompleted = true;
  reconnect.complete();
  await firstRead.promise;
  const recovery = await screen.findByRole("region", {
    name: "Google Calendar recovery",
  });
  expect(within(recovery).getByRole("status")).toBeVisible();
  expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("delivery paused");
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  watchRecovery.resolve();
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(screen.getByRole("switch")).toBeChecked();
  expect(reconnect.submittedAccounts).toHaveLength(1);
});

function calendarRecoveryWorkflow(): WorkflowDetailResponse {
  return {
    ...salesResearch(),
    automations: [
      googleCalendarWorkflowAutomation({ warning: "reconnect_required" }),
    ],
  };
}

interface CalendarRecoveryDeadline {
  readonly expire: () => void;
  readonly signal: AbortSignal;
}

function holdCalendarRecoveryDeadline() {
  const deadline = context.mocks.deferred<CalendarRecoveryDeadline>();
  const scheduled: CalendarRecoveryDeadline[] = [];
  const timeout = timers.timeout;
  vi.spyOn(timers, "timeout").mockImplementation((callback, ms, options) => {
    if (ms !== 30_000) {
      timeout(callback, ms, options);
      return;
    }
    const signal = options?.signal;
    if (!signal) {
      throw new Error("Expected an owned recovery deadline");
    }
    const entry = { signal, expire: callback };
    scheduled.push(entry);
    if (!deadline.settled()) {
      deadline.resolve(entry);
    }
  });
  return { ...deadline, scheduled };
}

async function expectUnconfirmedCalendarRecovery() {
  const recovery = await screen.findByRole("region", {
    name: "Google Calendar recovery",
  });
  await within(recovery).findByRole("alert");
  expect(buttonByText("Check status", recovery)).toBeEnabled();
  return recovery;
}

test("Bound a permanent Calendar warning and retry status without another OAuth", async () => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  mockNow(new Date("2026-09-08T06:00:00Z"), context.signal);
  const requestBudgetReached = context.mocks.deferred<void>();
  let oauthCompleted = false;
  let statusReads = 0;
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    if (oauthCompleted) {
      statusReads++;
      if (statusReads === 10) {
        requestBudgetReached.resolve();
      }
    }
    return respond(200, publicWorkflowDetail(workflow));
  });
  await reconnect.open();
  oauthCompleted = true;
  reconnect.complete();
  await requestBudgetReached.promise;
  const recovery = await expectUnconfirmedCalendarRecovery();
  // The request ceiling is part of the recovery contract, not a cache detail.
  expect(statusReads).toBe(10);
  expect(screen.getByRole("switch")).toBeChecked();
  expect(
    screen.getByText(
      "Google Calendar needs to be reconnected before this automation can resume.",
    ),
  ).toBeVisible();
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  click(buttonByText("Check status", recovery));
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Google Calendar recovery" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(screen.getByRole("switch")).toBeChecked();
  expect(reconnect.submittedAccounts).toHaveLength(1);
});

test("Reject Calendar recovery read at the total deadline", async () => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  const startedAt = new Date("2026-09-08T06:00:00Z").getTime();
  mockNow(startedAt, context.signal);
  let oauthCompleted = false;
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    if (oauthCompleted) {
      mockNow(startedAt + 30_000, context.signal);
    }
    return respond(200, publicWorkflowDetail(workflow));
  });
  await reconnect.open();
  oauthCompleted = true;
  reconnect.complete();
  await expectUnconfirmedCalendarRecovery();
  expect(screen.getByRole("switch")).toBeChecked();
  expect(reconnect.submittedAccounts).toHaveLength(1);
});

test("Abort a hanging Calendar summary at the recovery deadline", async () => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  const deadline = holdCalendarRecoveryDeadline();
  const requested = context.mocks.deferred<AbortSignal>();
  const response = context.mocks.deferred<void>();
  let oauthCompleted = false;
  context.mocks.api(
    workflowsDetailContract.get,
    async ({ request, respond }) => {
      if (oauthCompleted) {
        requested.resolve(request.signal);
        await response.promise;
      }
      return respond(200, publicWorkflowDetail(workflow));
    },
  );
  await reconnect.open();
  oauthCompleted = true;
  reconnect.complete();
  const requestSignal = await requested.promise;
  const scheduled = await deadline.promise;
  const recovery = await screen.findByRole("region", {
    name: "Google Calendar recovery",
  });
  expect(within(recovery).getByRole("status")).toBeVisible();
  expect(buttonByText("Check status", recovery)).toBeDisabled();
  expect(buttonByText("Reconnect Google Calendar")).toBeDisabled();
  scheduled.expire();
  await expectUnconfirmedCalendarRecovery();
  expect(requestSignal.aborted).toBeTruthy();
  expect(scheduled.signal.aborted).toBeTruthy();
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  response.resolve();
  expect(screen.getByRole("switch")).toBeChecked();
  expect(
    screen.getByText(
      "Google Calendar needs to be reconnected before this automation can resume.",
    ),
  ).toBeVisible();
});

test("An expired Calendar attempt cannot cancel or complete its replacement", async () => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  const deadline = holdCalendarRecoveryDeadline();
  const oldRequested = context.mocks.deferred<AbortSignal>();
  const newRequested = context.mocks.deferred<AbortSignal>();
  const oldResponse = context.mocks.deferred<void>();
  const newResponse = context.mocks.deferred<void>();
  let oauthCompleted = false;
  let statusReads = 0;
  context.mocks.api(
    workflowsDetailContract.get,
    async ({ request, respond }) => {
      if (oauthCompleted) {
        statusReads++;
        if (statusReads === 1) {
          oldRequested.resolve(request.signal);
          await oldResponse.promise;
        } else {
          newRequested.resolve(request.signal);
          await newResponse.promise;
        }
      }
      return respond(200, publicWorkflowDetail(workflow));
    },
  );
  await reconnect.open();
  oauthCompleted = true;
  reconnect.complete();
  const oldSignal = await oldRequested.promise;
  const oldDeadline = await deadline.promise;
  oldDeadline.expire();
  const recovery = await expectUnconfirmedCalendarRecovery();
  expect(oldSignal.aborted).toBeTruthy();

  click(buttonByText("Check status", recovery));
  const newSignal = await newRequested.promise;
  await within(recovery).findByRole("status");
  expect(buttonByText("Check status", recovery)).toBeDisabled();
  // Even a queued old deadline callback and late successful response belong
  // only to the expired attempt, while the replacement is still pending.
  oldDeadline.expire();
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  oldResponse.resolve();
  expect(newSignal.aborted).toBeFalsy();
  expect(within(recovery).getByRole("status")).toBeInTheDocument();

  newResponse.resolve();
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Google Calendar recovery" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(deadline.scheduled).toHaveLength(2);
  expect(
    deadline.scheduled.every((entry) => {
      return entry.signal.aborted;
    }),
  ).toBeTruthy();
  expect(screen.getByRole("switch")).toBeChecked();
  expect(reconnect.submittedAccounts).toHaveLength(1);
});

test("Keep the Calendar warning after a read failure and allow a status-only retry", async () => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  let failStatusRead = false;
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    if (failStatusRead) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Status unavailable" },
      });
    }
    return respond(200, publicWorkflowDetail(workflow));
  });
  await reconnect.open();
  failStatusRead = true;
  reconnect.complete();
  const recovery = await expectUnconfirmedCalendarRecovery();
  expect(screen.getByRole("switch")).toBeChecked();
  expect(
    screen.getByText(
      "Google Calendar needs to be reconnected before this automation can resume.",
    ),
  ).toBeVisible();
  failStatusRead = false;
  workflow.automations[0] = googleCalendarWorkflowAutomation();
  click(buttonByText("Check status", recovery));
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Google Calendar recovery" }),
    ).not.toBeInTheDocument();
  });
  expect(reconnect.submittedAccounts).toHaveLength(1);
});

test.each(["cancel", "navigate"] as const)(
  "Stop Calendar recovery on %s and ignore the late response",
  async (action) => {
    const workflow = calendarRecoveryWorkflow();
    const reconnect = mockCalendarReconnect(workflow);
    const deadline = holdCalendarRecoveryDeadline();
    const requested = context.mocks.deferred<AbortSignal>();
    const response = context.mocks.deferred<void>();
    let oauthCompleted = false;
    context.mocks.api(
      workflowsDetailContract.get,
      async ({ request, respond }) => {
        if (oauthCompleted) {
          requested.resolve(request.signal);
          await response.promise;
        }
        return respond(200, publicWorkflowDetail(workflow));
      },
    );
    await reconnect.open();
    oauthCompleted = true;
    reconnect.complete();
    const requestSignal = await requested.promise;
    const scheduled = await deadline.promise;
    const recovery = await screen.findByRole("region", {
      name: "Google Calendar recovery",
    });
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    if (action === "cancel") {
      click(buttonByText("Cancel", recovery));
    } else {
      click(linkByText("Workflows"));
      await screen.findByRole("heading", { name: "Workflows" });
    }
    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Google Calendar recovery" }),
      ).not.toBeInTheDocument();
      expect(requestSignal.aborted).toBeTruthy();
    });
    expect(scheduled.signal.aborted).toBeTruthy();
    workflow.automations[0] = googleCalendarWorkflowAutomation();
    response.resolve();
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return textFor(button) === "Reconnect Google Calendar";
      }),
    ).toHaveLength(action === "cancel" ? 1 : 0);
    expect(screen.queryAllByRole("switch", { checked: true })).toHaveLength(
      action === "cancel" ? 1 : 0,
    );
    expect(reconnect.submittedAccounts).toHaveLength(1);
  },
);

describe("with a reconnecting Calendar account", () => {
  async function prepareScenario() {
    const workflow = calendarRecoveryWorkflow();
    workflow.automations.unshift(
      googleCalendarWorkflowAutomation({ id: "healthy-other-calendar" }),
    );
    const reconnect = mockCalendarReconnect(workflow, "work");
    const requestBudgetReached = context.mocks.deferred<void>();
    let oauthCompleted = false;
    let statusReads = 0;
    context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
      if (oauthCompleted) {
        statusReads++;
        if (statusReads === 10) {
          requestBudgetReached.resolve();
        }
      }
      return respond(200, publicWorkflowDetail(workflow));
    });
    await reconnect.open();
    return {
      get oauthCompleted() {
        return oauthCompleted;
      },
      set oauthCompleted(next: typeof oauthCompleted) {
        oauthCompleted = next;
      },
      reconnect,
      requestBudgetReached,
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("do not recover the target Calendar automation by reconnecting another account", async () => {
    const { reconnect, requestBudgetReached } = preparedScenario;
    preparedScenario.oauthCompleted = true;
    reconnect.complete();
    await requestBudgetReached.promise;
    await expectUnconfirmedCalendarRecovery();
    expect(
      screen.getByText(
        "Google Calendar needs to be reconnected before this automation can resume.",
      ),
    ).toBeVisible();
    for (const enabled of screen.getAllByRole("switch")) {
      expect(enabled).toBeChecked();
    }
    expect(reconnect.submittedAccounts).toStrictEqual([
      {
        intent: "reconnect",
        connectionId: "10000000-0000-4000-a000-000000000020",
      },
    ]);
  });
});

test.each([
  "missing automation",
  "different event",
  "different workflow",
  "changed warning",
] as const)("Keep Calendar recovery unconfirmed for %s", async (change) => {
  const workflow = calendarRecoveryWorkflow();
  const reconnect = mockCalendarReconnect(workflow);
  await reconnect.open();
  if (change === "missing automation") {
    workflow.automations = [];
  }
  if (change === "different event") {
    workflow.automations = [
      googleCalendarUpdatedWorkflowAutomation({
        id: GOOGLE_CALENDAR_AUTOMATION_ID,
      }),
    ];
  }
  if (change === "different workflow") {
    workflow.id = OPS_WORKFLOW_ID;
  }
  if (change === "changed warning") {
    workflow.automations = [
      googleCalendarWorkflowAutomation({ warning: "calendar_not_found" }),
    ];
  }
  reconnect.complete();
  await expectUnconfirmedCalendarRecovery();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return textFor(button) === "Change calendar";
    }),
  ).toHaveLength(change === "changed warning" ? 1 : 0);
  expect(
    screen.queryAllByText(
      "This calendar is no longer available. Choose another calendar to resume this automation.",
    ),
  ).toHaveLength(change === "changed warning" ? 1 : 0);
});

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

test("Explain how to provide a valid Google Forms link", async () => {
  const guidance =
    "Please open the form's edit page and copy the link from the address bar.";
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "BAD_REQUEST", message: guidance },
    });
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
    "https://docs.google.com/forms/d/e/responder-id/viewform",
  );
  fireEvent.submit(createAutomationForm);

  await expect(screen.findByText(guidance)).resolves.toBeInTheDocument();
  expect(createAutomationForm).toBeInTheDocument();
});

test("Create a Google Meet transcript-ready automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"), {});

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Calendar", /^Google Meet transcript ready/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Google Meet transcript automation",
  });
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: {
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      },
    });
  });
});

test("Create a Notion database-item automation", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"), {});

  await waitFor(() => {
    expect(buttonByText("Add automation")).toBeInTheDocument();
  });
  click(buttonByText("Add automation"));

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  pickAutomation("Notion", /^New Notion database item/);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add Notion database item automation",
  });
  await fill(
    within(createAutomationForm).getByLabelText("Database URL"),
    "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
  );
  fireEvent.submit(createAutomationForm);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "notion-database-item-created",
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        databaseUrl:
          "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
      },
    });
  });
});

test("Keep existing Stripe automations manageable when creation is unavailable", async () => {
  const workflow = {
    ...salesResearch(),
    automations: [
      stripeInvoicePaidWorkflowAutomation(),
      stripeInvoicePaidWorkflowAutomation({
        id: "workflow-automation-stripe-invoice-paid-failed",
        eventConfig: {
          provider: "stripe",
          event: "invoice_paid",
          billingReasons: ["manual", "subscription_cycle"],
          connectorId: "00000000-0000-4000-a000-000000000412",
          stripeAccountId: "acct_failed_delivery",
          mode: "live",
        },
        health: {
          lastMatchingEventReceivedAt: "2026-08-07T08:00:00.000Z",
          lastDeliveryStatus: "failed",
          lastDeliveryStatusAt: "2026-08-07T08:01:00.000Z",
          warning: "delivery_failed",
        },
      }),
    ],
  };
  mockWorkflowApis([workflow]);
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: false,
  });

  await waitFor(() => {
    expect(screen.getAllByText("Stripe invoice paid")).toHaveLength(2);
  });
  expect(
    screen.getByText(
      "Stripe account acct_mock_stripe_invoice_paid · Live mode · Any billing reason",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Stripe account acct_failed_delivery · Live mode · Manual, Subscription cycle",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("No matching events yet")).toBeInTheDocument();
  expect(screen.getByText("No deliveries yet")).toBeInTheDocument();
  expect(screen.getByText(/Failed ·/u)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The latest terminal delivery failed. Check workflow activity before trying again.",
  );
  expect(
    screen.getAllByText(
      "The Stripe account and billing reasons are fixed. To change them, delete this automation and recreate it.",
    ),
  ).toHaveLength(2);
  expect(screen.queryByText("Webhook URL hidden")).not.toBeInTheDocument();
  expect(screen.queryByText("Edit automation")).not.toBeInTheDocument();

  click(await screen.findByText("Add automation"));
  const picker = await screen.findByRole("dialog");
  click(buttonByText("Integrations", picker));
  expect(
    within(picker).queryByText("Stripe invoice paid"),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const stripeSwitches = screen.getAllByRole("switch", {
    name: "Disable Stripe invoice paid",
  });
  const stripeSwitch = stripeSwitches[0];
  if (!stripeSwitch) {
    throw new Error("Stripe automation switch not found");
  }
  click(stripeSwitch);
  await waitFor(() => {
    expect(stripeSwitch).not.toBeChecked();
  });
  click(buttonByText("More actions"));
  expect(menuItemByText("Delete automation")).toBeInTheDocument();
  expect(screen.queryByText("Edit automation")).not.toBeInTheDocument();
});

test("Create a Stripe invoice-paid automation for selected billing reasons", async () => {
  const user = userEvent.setup();
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  const workflow = salesResearch();
  mockWorkflowApis([workflow]);
  context.mocks.api(workflowAutomationsContract.create, ({ body, respond }) => {
    createBodies.push(body);
    if (body.kind !== "event" || body.eventType !== "stripe-invoice-paid") {
      return respond(400, {
        error: { code: "BAD_REQUEST", message: "Expected Stripe" },
      });
    }
    const automation = stripeInvoicePaidWorkflowAutomation({
      eventConfig: {
        ...body.eventConfig,
        connectorId: "00000000-0000-4000-a000-000000000411",
        stripeAccountId: "acct_created_live",
        mode: "live",
      },
    });
    workflow.automations.push(automation);
    return respond(201, automation);
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true,
  });

  click(await screen.findByText("Add automation"));
  await screen.findByRole("dialog");
  pickAutomation("Integrations", /^Stripe invoice paid/u);
  const form = await screen.findByRole("form", {
    name: "Add Stripe invoice paid automation",
  });
  expect(within(form).getAllByRole("checkbox")).toHaveLength(9);
  expect(within(form).queryByRole("combobox")).not.toBeInTheDocument();
  expect(within(form).queryByRole("textbox")).not.toBeInTheDocument();
  const manual = within(form).getByRole("checkbox", { name: "Manual" });
  const subscriptionCycle = within(form).getByRole("checkbox", {
    name: "Subscription cycle",
  });
  await user.click(manual);
  await user.click(subscriptionCycle);
  expect(manual).toBeChecked();
  expect(subscriptionCycle).toBeChecked();
  fireEvent.submit(form);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig: {
        provider: "stripe",
        event: "invoice_paid",
        billingReasons: ["manual", "subscription_cycle"],
      },
    });
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("form", {
        name: "Add Stripe invoice paid automation",
      }),
    ).not.toBeInTheDocument();
  });
  await expect(
    screen.findByText(
      "Stripe account acct_created_live · Live mode · Manual, Subscription cycle",
    ),
  ).resolves.toBeInTheDocument();
});

test("Create a Stripe invoice-paid automation for any billing reason", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  mockWorkflowApis([salesResearch()]);
  mockCreateWorkflowAutomation((body) => {
    createBodies.push(body);
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true,
  });

  click(await screen.findByText("Add automation"));
  await screen.findByRole("dialog");
  pickAutomation("Integrations", /^Stripe invoice paid/u);
  const form = await screen.findByRole("form", {
    name: "Add Stripe invoice paid automation",
  });
  fireEvent.submit(form);

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig: {
        provider: "stripe",
        event: "invoice_paid",
      },
    });
  });
});

test("Recover from an unavailable Stripe connection while creating an automation", async () => {
  const serverMessage =
    "Stripe invoice-paid automations require Live mode; reconnect Stripe in Live mode";
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.create, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: serverMessage },
    });
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true,
  });

  click(await screen.findByText("Add automation"));
  await screen.findByRole("dialog");
  pickAutomation("Integrations", /^Stripe invoice paid/u);
  const form = await screen.findByRole("form", {
    name: "Add Stripe invoice paid automation",
  });
  fireEvent.submit(form);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(serverMessage);
  expect(form).toBeInTheDocument();
  expect(linkByText("Manage Stripe connection", alert)).toHaveAttribute(
    "href",
    "/connectors",
  );
});

test("Offer a Team upgrade to a Pro workspace administrator", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockWorkflowApis([salesResearch()]);
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {}, "pro");

  click(await screen.findByText("Add automation"));
  const picker = await screen.findByRole("dialog");
  click(buttonByText("Integrations", picker));
  const webhookCard = buttonByText(/^Webhook/u, picker);
  expect(within(webhookCard).getByText("Team")).toBeInTheDocument();
  click(webhookCard);

  const upgradeTitle = await screen.findByText(
    "Upgrade for webhook automations",
  );
  expect(upgradeTitle).toBeInTheDocument();
  expect(
    screen.getByText("Webhook automations require a Team or Custom workspace."),
  ).toBeInTheDocument();
  expect(buttonByText("Upgrade to Team")).toBeInTheDocument();
});

test("Allow webhook creation when the plan grants the capability", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockWorkflowApis([salesResearch()]);
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {}, "pro", {
    workflowWebhookAutomationAllowed: true,
  });

  click(await screen.findByText("Add automation"));
  const picker = await screen.findByRole("dialog");
  click(buttonByText("Integrations", picker));
  const webhookCard = buttonByText(/^Webhook/u, picker);
  expect(within(webhookCard).queryByText("Team")).not.toBeInTheDocument();
  click(webhookCard);

  await expect(
    screen.findByText("Create webhook"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Upgrade for webhook automations"),
  ).not.toBeInTheDocument();
});

test("Handle a plan restriction discovered while creating a webhook", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockWorkflowApis([salesResearch()]);
  context.mocks.api(workflowAutomationsContract.create, ({ respond }) => {
    return respond(402, {
      error: {
        code: "TEAM_REQUIRED",
        message: "Webhook automations require a Team or Custom workspace",
      },
    });
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {}, "pro", {
    workflowWebhookAutomationAllowed: true,
  });

  click(await screen.findByText("Add automation"));
  const picker = await screen.findByRole("dialog");
  click(buttonByText("Integrations", picker));
  click(buttonByText(/^Webhook/u, picker));
  await waitFor(() => {
    expect(buttonByText("Create webhook")).toBeInTheDocument();
  });
  const createButton = buttonByText("Create webhook");
  click(createButton);

  await expect(
    screen.findByText("Upgrade for webhook automations"),
  ).resolves.toBeInTheDocument();
  expect(createButton).toBeDisabled();
});

test("Direct a non-admin to request webhook access", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  mockWorkflowApis([salesResearch()]);
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {}, "pro");

  click(await screen.findByText("Add automation"));
  const picker = await screen.findByRole("dialog");
  click(buttonByText("Integrations", picker));
  click(buttonByText(/^Webhook/u, picker));

  const askAdmin = await screen.findByText("Ask a workspace admin to upgrade.");
  expect(askAdmin).toBeInTheDocument();
  expect(screen.queryByText("Upgrade to Team")).not.toBeInTheDocument();
});

test("Explain a plan restriction when enabling an existing webhook", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.data.userPreferences({ timezone: "UTC" });
  const workflow = {
    ...salesResearch(),
    automations: [
      weekdayWorkflowAutomation(),
      {
        ...webhookWorkflowAutomation(),
        enabled: false,
        disabledReason: "paid_plan_required" as const,
      },
    ],
  };
  mockWorkflowApis([workflow]);
  context.mocks.api(workflowAutomationsContract.enable, ({ respond }) => {
    return respond(402, {
      error: {
        code: "TEAM_REQUIRED",
        message: "Webhook automations require a Team or Custom workspace",
      },
    });
  });
  await setupWorkflowDetailPage(workflowDetailPath("automations"), {}, "pro");

  const enableSwitch = await screen.findByRole("switch", {
    name: "Enable Webhook",
  });
  const unrelatedSwitch = screen.getByRole("switch", {
    name: "Disable Every weekday at 9:00 AM",
  });
  click(enableSwitch);
  const upgradeTitle = await screen.findByText(
    "Upgrade for webhook automations",
  );
  expect(upgradeTitle).toBeInTheDocument();
  expect(enableSwitch).toHaveAttribute("aria-disabled", "true");
  expect(unrelatedSwitch).not.toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Disabled — paid plan required")).toBeInTheDocument();
});

test("Reveal an existing webhook secret on demand", async () => {
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
  click(await screen.findByText("Reveal secret"));

  const webhookUrlField = await screen.findByDisplayValue(
    webhookWorkflowAutomation().webhookUrl ?? "",
  );
  expect(webhookUrlField).toBeInTheDocument();
  expect(screen.getByDisplayValue("webhook-secret")).toHaveValue(
    "webhook-secret",
  );
});

test("Create a daily schedule in the user's preferred time zone", async () => {
  const createBodies: WorkflowAutomationCreateRequest[] = [];
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
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
  pickAutomation("Schedule", /^Scheduled time/u);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add schedule automation",
  });
  expect(
    within(createAutomationForm).getByText("Time (Asia/Shanghai)"),
  ).toBeInTheDocument();
  expect(within(createAutomationForm).queryByText(/Saved as/u)).toBeNull();
  click(buttonByText("Add schedule", createAutomationForm));

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      schedule: {
        type: "cron",
        cronExpression: "0 1 * * *",
        timezone: "UTC",
      },
    });
  });
});

test("Create an interval automation", async () => {
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
  pickAutomation("Schedule", /^Interval/u);

  const createAutomationForm = await screen.findByRole("form", {
    name: "Add interval automation",
  });
  selectOptionByLabel("Every", "30 minutes", createAutomationForm);
  click(buttonByText("Add interval", createAutomationForm));

  await waitFor(() => {
    expect(createBodies.at(-1)).toStrictEqual({
      schedule: {
        type: "loop",
        intervalSeconds: 1800,
      },
    });
  });
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

test("Edit a schedule in the user's preferred time zone", async () => {
  const updateBodies: {
    readonly automationId: string;
    readonly body: WorkflowAutomationUpdateRequest;
  }[] = [];
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
  const workflow = {
    ...salesResearch(),
    automations: [
      {
        ...weekdayWorkflowAutomation(),
        schedule: {
          type: "cron",
          cronExpression: "0 1 * * 1-5",
          timezone: "UTC",
        },
      } satisfies WorkflowScheduleAutomationSummary,
    ],
  };
  mockWorkflowApis([workflow]);
  mockUpdateWorkflowAutomation((automationId, body) => {
    updateBodies.push({ automationId, body });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
  });

  click(buttonByText("Edit automation"));

  const updateAutomationForm = screen.getByRole("form", {
    name: "Update schedule automation",
  });
  selectOptionByLabel("Hour", "16", updateAutomationForm);
  selectOptionByLabel("Minute", "45", updateAutomationForm);
  click(buttonByText("Save schedule", updateAutomationForm));

  await waitFor(() => {
    expect(updateBodies.at(-1)).toStrictEqual({
      automationId: "workflow-automation-weekday-brief",
      body: {
        schedule: {
          type: "cron",
          cronExpression: "45 8 * * 1-5",
          timezone: "UTC",
        },
      },
    });
  });
});

test("Edit an interval automation", async () => {
  const updateBodies: {
    readonly automationId: string;
    readonly body: WorkflowAutomationUpdateRequest;
  }[] = [];
  const workflow = {
    ...salesResearch(),
    automations: [
      {
        ...weekdayWorkflowAutomation(),
        schedule: {
          type: "loop",
          intervalSeconds: 3600,
        },
        scheduleSummary: "Every 3600s",
      } satisfies WorkflowScheduleAutomationSummary,
    ],
  };
  mockWorkflowApis([workflow]);
  mockUpdateWorkflowAutomation((automationId, body) => {
    updateBodies.push({ automationId, body });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getByText("Every 1 hour")).toBeInTheDocument();
  });

  click(buttonByText("Edit automation"));

  const updateAutomationForm = screen.getByRole("form", {
    name: "Update schedule automation",
  });
  selectOptionByLabel("Every", "30 minutes", updateAutomationForm);
  fireEvent.submit(updateAutomationForm);

  await waitFor(() => {
    expect(updateBodies.at(-1)).toStrictEqual({
      automationId: "workflow-automation-weekday-brief",
      body: {
        schedule: {
          type: "loop",
          intervalSeconds: 1800,
        },
      },
    });
  });
});

test("Edit Gmail new-message match rules", async () => {
  const updateBodies: {
    readonly automationId: string;
    readonly body: WorkflowAutomationUpdateRequest;
  }[] = [];
  const workflow = {
    ...salesResearch(),
    automations: [
      {
        ...gmailWorkflowAutomation(),
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          threadId: "gmail-thread-1",
          match: {
            from: { containsAny: ["@vip.example"] },
            subject: { doesNotContain: "newsletter" },
          },
        },
      } satisfies WorkflowGmailNewMessageAutomationSummary,
    ],
  };
  mockWorkflowApis([workflow]);
  mockUpdateWorkflowAutomation((automationId, body) => {
    updateBodies.push({ automationId, body });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(0);
  });

  click(buttonByText("Edit automation"));

  const updateAutomationForm = screen.getByRole("form", {
    name: "Update Gmail new message automation",
  });
  expect(
    within(updateAutomationForm).getByLabelText("Subject does not contain"),
  ).toHaveValue("newsletter");
  expect(
    within(updateAutomationForm).getByLabelText("From contains any"),
  ).toHaveValue("@vip.example");
  await fill(
    within(updateAutomationForm).getByLabelText("From contains any"),
    "@vip.example, @priority.example",
  );
  expect(
    within(updateAutomationForm).getByLabelText("Thread ID is"),
  ).toHaveValue("gmail-thread-1");
  expect(
    within(updateAutomationForm).getByLabelText("Condition 3 field"),
  ).toHaveTextContent("Thread ID");
  expect(
    within(updateAutomationForm).getByLabelText("Condition 3 operator"),
  ).toHaveTextContent("Is");
  await fill(
    within(updateAutomationForm).getByLabelText("Thread ID is"),
    "gmail-thread-2",
  );
  click(buttonByText("Add condition", updateAutomationForm));
  await fill(
    within(updateAutomationForm).getByLabelText("From contains"),
    "@acme.com",
  );
  click(buttonByText("Add condition", updateAutomationForm));
  selectOptionByLabel("Condition 5 field", "Body", updateAutomationForm);
  await fill(
    within(updateAutomationForm).getByLabelText("Body contains"),
    "invoice",
  );
  fireEvent.submit(updateAutomationForm);

  await waitFor(() => {
    expect(updateBodies.at(-1)).toStrictEqual({
      automationId: GMAIL_AUTOMATION_ID,
      body: {
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          threadId: "gmail-thread-2",
          match: {
            from: {
              contains: "@acme.com",
              containsAny: ["@vip.example", "@priority.example"],
            },
            subject: { doesNotContain: "newsletter" },
            body: { contains: "invoice" },
          },
        },
      },
    });
  });
});

test("Edit a Gmail label-applied automation", async () => {
  const updateBodies: {
    readonly automationId: string;
    readonly body: WorkflowAutomationUpdateRequest;
  }[] = [];
  const workflow = {
    ...salesResearch(),
    automations: [gmailLabelWorkflowAutomation()],
  };
  mockWorkflowApis([workflow]);
  mockUpdateWorkflowAutomation((automationId, body) => {
    updateBodies.push({ automationId, body });
  });

  await setupWorkflowDetailPage(workflowDetailPath("automations"));

  await waitFor(() => {
    expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
  });

  click(buttonByText("Edit automation"));

  const updateAutomationForm = screen.getByRole("form", {
    name: "Update Gmail label automation",
  });
  await fill(
    within(updateAutomationForm).getByLabelText("Label name"),
    "Escalated",
  );
  fireEvent.submit(updateAutomationForm);

  await waitFor(() => {
    expect(updateBodies.at(-1)).toStrictEqual({
      automationId: GMAIL_LABEL_AUTOMATION_ID,
      body: {
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Escalated",
        },
      },
    });
  });
});

test("Warn when a workflow slash command resolves to another workflow", async () => {
  const workflow = {
    ...salesResearch(),
    shadowedBy: {
      id: OPS_WORKFLOW_ID,
      name: "sales-research",
      displayName: "Private Sales Research",
    },
  };
  mockWorkflowApis([workflow]);

  await setupWorkflowDetailPage(workflowDetailPath("instructions"));

  await waitFor(() => {
    expect(screen.getByText(/currently resolves to/i)).toBeInTheDocument();
  });
  expect(screen.getByText("Private Sales Research")).toBeInTheDocument();
});

test("Delete a supplementary workflow file", async () => {
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
  click(menuItemByText(/config\/settings\.json/));
  click(screen.getByLabelText("Workflow files"));
  click(screen.getByLabelText("Delete config/settings.json"));

  await waitFor(() => {
    expect(updateBodies.at(-1)?.files).toStrictEqual([
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
    ]);
  });
});

test("Upload a supplementary workflow file", async () => {
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
  const input = screen.getByLabelText("Upload workflow files");
  fireEvent.change(input, {
    target: {
      files: [new File(["new notes"], "notes.md", { type: "text/markdown" })],
    },
  });

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
});

test("Load workflow authors only after a title tooltip opens and reuse on reopen", async () => {
  const user = userEvent.setup();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    24,
  );
  mockWorkflowApis([salesResearch()]);
  const response = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.api(
    workflowsDetailContract.ownerProfile,
    async ({ respond }) => {
      requests += 1;
      await response.promise;
      return respond(200, {
        displayName: "Lazy Author",
        imageUrl: "https://example.com/lazy-author.png",
      });
    },
  );
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  expect(screen.getByText("Sales Research")).toBeInTheDocument();
  expect(requests).toBe(0);
  const title = linkByAriaLabel("Open Sales Research");
  await user.hover(title);
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByText("Created by")).toBeInTheDocument();
  expect(within(tooltip).getByText("Runs as")).toBeInTheDocument();
  expect(within(tooltip).getByText("Sales Research")).toBeInTheDocument();
  expect(
    within(tooltip).getByText("Collects account context before outreach."),
  ).toBeInTheDocument();
  await expect(
    within(tooltip).findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  expect(within(tooltip).getByRole("status")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  response.resolve();
  await expect(
    within(tooltip).findByText("Lazy Author"),
  ).resolves.toBeInTheDocument();
  expect(within(tooltip).getByRole("status")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(
    within(tooltip).getByRole("img", { name: "Lazy Author" }),
  ).toHaveAttribute("src", "https://example.com/lazy-author.png");
  await user.unhover(title);
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(title);
  await expect(
    within(await screen.findByRole("tooltip")).findByText("Lazy Author"),
  ).resolves.toBeInTheDocument();
  expect(requests).toBe(1);
});

test("Load detail author on keyboard focus without delaying the detail page", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch()]);
  const response = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.api(
    workflowsDetailContract.ownerProfile,
    async ({ respond }) => {
      requests += 1;
      await response.promise;
      return respond(200, { displayName: "Keyboard Author", imageUrl: null });
    },
  );
  await setupPage({
    context,
    path: `/workflows/${SALES_WORKFLOW_ID}/automations`,
  });
  const heading = await screen.findByRole("heading", {
    name: "Sales Research",
  });
  expect(requests).toBe(0);
  expect(heading).toHaveAttribute("tabindex", "0");
  await user.keyboard("{Tab}");
  screen.getByRole("heading", { name: "Sales Research" }).focus();
  const tooltip = await screen.findByRole("tooltip");
  await expect(
    within(tooltip).findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  expect(within(tooltip).getByRole("status")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(within(tooltip).getByText("Sales Research")).toBeInTheDocument();
  expect(
    within(tooltip).getByText("Collects account context before outreach."),
  ).toBeInTheDocument();
  expect(within(tooltip).getByText("Runs as")).toBeInTheDocument();
  response.resolve();
  await expect(
    within(tooltip).findByText("Keyboard Author"),
  ).resolves.toBeInTheDocument();
  expect(within(tooltip).getByText("Runs as")).toBeInTheDocument();
  expect(requests).toBe(1);
});

test.each([404, 429, 503] as const)(
  "Recover the author row after an API %s without affecting workflow content",
  async (status) => {
    const user = userEvent.setup();
    mockWorkflowApis([salesResearch()]);
    let healthy = false;
    context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
      return healthy
        ? respond(200, { displayName: "Recovered Author", imageUrl: null })
        : respond(status, {
            error: {
              code: "NOT_AVAILABLE",
              message: "Author lookup unavailable",
            },
          });
    });
    await setupPage({ context, path: "/workflows" });
    await screen.findByText("Sales Research");
    await user.hover(linkByAriaLabel("Open Sales Research"));
    const tooltip = await screen.findByRole("tooltip");
    await expect(
      within(tooltip).findByText("Author unavailable. Reopen to retry."),
    ).resolves.toBeInTheDocument();
    expect(within(tooltip).getByText("Runs as")).toBeInTheDocument();
    healthy = true;
    await user.unhover(linkByAriaLabel("Open Sales Research"));
    await waitFor(() => {
      return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    await user.hover(linkByAriaLabel("Open Sales Research"));
    await expect(
      within(await screen.findByRole("tooltip")).findByText("Recovered Author"),
    ).resolves.toBeInTheDocument();
  },
);

test("Expire a missing author result and recover on a later open", async () => {
  const user = userEvent.setup();
  const startedAt = new Date("2026-09-14T08:00:00Z").getTime();
  mockNow(startedAt, context.signal);
  mockWorkflowApis([salesResearch()]);
  let available = false;
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, {
      displayName: available ? "Returned Author" : null,
      imageUrl: null,
    });
  });
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  const title = linkByAriaLabel("Open Sales Research");
  await user.hover(title);
  await expect(
    within(await screen.findByRole("tooltip")).findByText("Author unavailable"),
  ).resolves.toBeInTheDocument();
  available = true;
  await user.unhover(title);
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(title);
  await expect(
    within(await screen.findByRole("tooltip")).findByText("Author unavailable"),
  ).resolves.toBeInTheDocument();
  await user.unhover(title);
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  mockNow(startedAt + 60_000, context.signal);
  await user.hover(title);
  await expect(
    within(await screen.findByRole("tooltip")).findByText("Returned Author"),
  ).resolves.toBeInTheDocument();
});

test("Keep reopened consumers and out-of-order workflow author responses isolated", async () => {
  const user = userEvent.setup();
  const second = {
    ...salesResearch(),
    id: OTHER_WORKFLOW_ID,
    name: "second-workflow",
    displayName: "Second Workflow",
  };
  mockWorkflowApis([salesResearch(), second]);
  const firstResponse = context.mocks.deferred<void>();
  let firstRequests = 0;
  context.mocks.api(
    workflowsDetailContract.ownerProfile,
    async ({ params, respond }) => {
      if (params.workflowId === SALES_WORKFLOW_ID) {
        firstRequests += 1;
        await firstResponse.promise;
        return respond(200, { displayName: "First Author", imageUrl: null });
      }
      return respond(200, { displayName: "Second Author", imageUrl: null });
    },
  );
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  const firstTitle = linkByAriaLabel("Open Sales Research");
  await user.hover(firstTitle);
  await expect(
    screen.findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  await user.unhover(firstTitle);
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(firstTitle);
  await expect(
    screen.findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  await user.unhover(firstTitle);
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(linkByAriaLabel("Open Second Workflow"));
  const tooltip = await screen.findByRole("tooltip");
  await expect(
    within(tooltip).findByText("Second Author"),
  ).resolves.toBeInTheDocument();
  firstResponse.resolve();
  await user.unhover(linkByAriaLabel("Open Second Workflow"));
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(firstTitle);
  await expect(
    within(await screen.findByRole("tooltip")).findByText("First Author"),
  ).resolves.toBeInTheDocument();
  expect(firstRequests).toBe(1);
});

test("Do not request an author when a pointer pass never opens its tooltip", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch()]);
  let requests = 0;
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    requests += 1;
    return respond(200, { displayName: "Unused Author", imageUrl: null });
  });
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  const title = linkByAriaLabel("Open Sales Research");
  await user.hover(title);
  await user.unhover(title);
  await user.hover(
    within(articleByText("Sales Research")).getByLabelText("Public"),
  );
  await expect(
    screen.findByText("Public", {
      selector: '[data-slot="tooltip-content"]',
    }),
  ).resolves.toBeInTheDocument();
  expect(requests).toBe(0);
});

test("Discard cached author data on account change and abort the old account's pending request", async () => {
  const user = userEvent.setup();
  const clerk = context.mocks.clerk();
  const firstResponse = context.mocks.deferred<void>();
  const started = context.mocks.deferred<AbortSignal>();
  mockWorkflowApis([salesResearch()]);
  let changed = false;
  context.mocks.api(
    workflowsDetailContract.ownerProfile,
    async ({ request, respond }) => {
      if (!changed) {
        started.resolve(request.signal);
        await firstResponse.promise;
        return respond(200, {
          displayName: "Previous Account Author",
          imageUrl: null,
        });
      }
      return respond(200, {
        displayName: "Current Account Author",
        imageUrl: null,
      });
    },
  );
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  await user.hover(linkByAriaLabel("Open Sales Research"));
  await expect(
    screen.findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  const previousRequest = await started.promise;
  changed = true;
  act(() => {
    clerk.user(
      { id: UPDATED_USER_ID, fullName: "New Account" },
      { token: "new-session" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    return expect(previousRequest.aborted).toBeTruthy();
  });
  firstResponse.resolve();
  await user.unhover(linkByAriaLabel("Open Sales Research"));
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(linkByAriaLabel("Open Sales Research"));
  const tooltip = await screen.findByRole("tooltip");
  await expect(
    within(tooltip).findByText("Current Account Author"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Previous Account Author")).not.toBeInTheDocument();
});

test("Release author requests on workflow navigation", async () => {
  const user = userEvent.setup();
  mockWorkflowApis([salesResearch()]);
  const response = context.mocks.deferred<void>();
  const started = context.mocks.deferred<AbortSignal>();
  context.mocks.api(
    workflowsDetailContract.ownerProfile,
    async ({ request, respond }) => {
      started.resolve(request.signal);
      await response.promise;
      return respond(200, {
        displayName: "Previous Page Author",
        imageUrl: null,
      });
    },
  );
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  const title = linkByAriaLabel("Open Sales Research");
  await user.hover(title);
  await expect(
    screen.findByText("Loading author…"),
  ).resolves.toBeInTheDocument();
  const requestSignal = await started.promise;
  click(title);
  await screen.findByRole("heading", { name: "Sales Research" });
  expect(requestSignal.aborted).toBeTruthy();
  response.resolve();
  expect(screen.queryByText("Previous Page Author")).not.toBeInTheDocument();
});

describe("with a complete workflow author catalog", () => {
  async function prepareScenario() {
    const workflows = Array.from({ length: 33 }, (_, index) => {
      return {
        ...salesResearch(),
        id: `d0000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        name: `bounded-${index}`,
        displayName: `Bounded Workflow ${index}`,
        automations: [],
      };
    });
    mockWorkflowApis(workflows);
    let revision = "Initial";
    context.mocks.api(
      workflowsDetailContract.ownerProfile,
      ({ params, respond }) => {
        return respond(200, {
          displayName: `${revision} ${params.workflowId}`,
          imageUrl: null,
        });
      },
    );
    await setupPage({ context, path: "/workflows" });
    await screen.findByText("Bounded Workflow 32");
    const links = queryAllByRoleFast("link");
    return {
      links,
      workflows,
      get revision() {
        return revision;
      },
      set revision(next: typeof revision) {
        revision = next;
      },
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("bound the page's author cache while quickly moving between workflows", async () => {
    const { links, workflows } = preparedScenario;
    await act(() => {
      linkByAriaLabel("Open Bounded Workflow 0", links).focus();
    });
    await expect(
      screen.findByText(`Initial ${workflows[0]?.id}`, {
        selector: '[role="tooltip"] *',
      }),
    ).resolves.toBeInTheDocument();

    // Focus can move again before an author arrives; the page still owns each
    // request. Observe the final row before checking that capacity evicts the first.
    await act(() => {
      for (const workflow of workflows.slice(1)) {
        linkByAriaLabel(`Open ${workflow.displayName}`, links).focus();
      }
    });
    await expect(
      screen.findByText(`Initial ${workflows[32]?.id}`, {
        selector: '[role="tooltip"] *',
      }),
    ).resolves.toBeInTheDocument();

    preparedScenario.revision = "Evicted";
    await act(() => {
      linkByAriaLabel("Open Bounded Workflow 0", links).focus();
    });
    await expect(
      screen.findByText(`Evicted ${workflows[0]?.id}`, {
        selector: '[role="tooltip"] *',
      }),
    ).resolves.toBeInTheDocument();
  });
});

test("Reuse a successful author profile until its TTL expires", async () => {
  const user = userEvent.setup();
  const startedAt = new Date("2026-09-14T08:00:00Z").getTime();
  mockNow(startedAt, context.signal);
  mockWorkflowApis([salesResearch()]);
  let revision = "Initial";
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, { displayName: `${revision} Author`, imageUrl: null });
  });
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  const title = linkByAriaLabel("Open Sales Research");
  await user.hover(title);
  await expect(
    screen.findByText("Initial Author"),
  ).resolves.toBeInTheDocument();
  await user.unhover(title);
  await waitFor(() => {
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  revision = "Refreshed";
  mockNow(startedAt + 15 * 60 * 1000 - 1, context.signal);
  await user.hover(title);
  await expect(
    screen.findByText("Initial Author"),
  ).resolves.toBeInTheDocument();
  await user.unhover(title);
  await waitFor(() => {
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  mockNow(startedAt + 15 * 60 * 1000, context.signal);
  await user.hover(title);
  await expect(
    screen.findByText("Refreshed Author"),
  ).resolves.toBeInTheDocument();
});

test("Clear the author cache when the active organization changes", async () => {
  const user = userEvent.setup();
  const clerk = context.mocks.clerk();
  mockWorkflowApis([salesResearch()]);
  let organizationChanged = false;
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, {
      displayName: organizationChanged
        ? "New Organization Author"
        : "Old Organization Author",
      imageUrl: null,
    });
  });
  await setupPage({ context, path: "/workflows" });
  await screen.findByText("Sales Research");
  await user.hover(linkByAriaLabel("Open Sales Research"));
  await expect(
    screen.findByText("Old Organization Author"),
  ).resolves.toBeInTheDocument();
  organizationChanged = true;
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_profile_other", name: "Other Organization" },
      memberships: [{ id: "org_profile_other" }],
    });
    clerk.stateChanged();
  });
  await waitFor(() => {
    return expect(
      screen.queryByText("Old Organization Author"),
    ).not.toBeInTheDocument();
  });
  await user.unhover(linkByAriaLabel("Open Sales Research"));
  await waitFor(() => {
    return expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  await user.hover(linkByAriaLabel("Open Sales Research"));
  await expect(
    screen.findByText("New Organization Author"),
  ).resolves.toBeInTheDocument();
});
