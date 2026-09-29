import { githubInstallations } from "@okouai/db/schema/github-installation";
import { parseRawRows } from "../../lib/db-raw-rows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { isDeepStrictEqual } from "node:util";

import type { OfficialWorkflowParameterBinding } from "@okouai/api-contracts/contracts/official-workflow-bindings";
import {
  chatRunFinishedEventConfigSchema,
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  githubWorkflowRunCompletedEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleFormsResponseSubmittedEventConfigSchema,
  googleMeetTranscriptGeneratedEventConfigSchema,
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  stripeInvoicePaidEventConfigSchema,
  webhookReceivedEventConfigSchema,
  type ChatRunFinishedEventConfig,
  type ChatThreadWorkflowAutomation,
  type GithubAutomationEventConfig,
  type GmailAutomationEventConfig,
  type GoogleCalendarAutomationEventConfig,
  type GoogleCalendarWatchActionRequiredReason,
  type GoogleFormsResponseSubmittedEventConfig,
  type GoogleFormsResponseSubmittedEventCreateConfig,
  type GoogleMeetAutomationEventConfig,
  type NotionAutomationEventConfig,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type StripeInvoicePaidEventConfig,
  type StripeInvoicePaidEventCreateConfig,
  type StripeWorkflowAutomationHealth,
  type WebhookReceivedEventConfig,
  type WorkflowAutomationEventType,
  type WorkflowAutomationsListEntry,
  type WorkflowAutomationSummary,
  type WorkflowSchedule,
  type WorkflowWebhookSecretResponse,
} from "@okouai/api-contracts/contracts/workflows";
import { parseScheduledAtTime } from "@okouai/core/timezone";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { stripeWorkflowAutomationHealth } from "@okouai/db/schema/stripe-automation-event";
import {
  officialWorkflowAutomationIdentities,
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
  workflowWebhookAutomations,
  type WorkflowAutomationEventConfig,
  type WorkflowScheduleType,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import {
  bestEffort,
  isValidTimeZone,
  onRejection,
  safeSync,
  settle,
} from "../utils";
import {
  builtinConnectorStateLockStatement,
  lockConnectorAccountTarget,
} from "./auth-state-lock.service";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import {
  insertWorkflowAutomation,
  workflowAutomationColumns,
} from "./autonomy-budget-schema.service";
import {
  prepareGithubWebhookEventConfigForPersist,
  parseGithubWebhookAutomationConfig,
} from "./github-webhook-automation-event.service";
import { prepareGithubWorkflowRunEventConfigForPersist } from "./github-workflow-run-event.service";
import {
  readGmailAutomationConnectorId$,
  gmailSelectedAccountCondition,
  resolveGmailAutomationConnectorId,
} from "./gmail-automation-account.service";
import {
  ensureGmailWatchForUser$,
  hasEnabledGmailConsumer$,
  resolveGmailLabelForUser$,
} from "./gmail-automation-event.service";
import {
  resolveGoogleCalendarAutomationConnectorId,
  readGoogleCalendarAutomationConnectorId$,
  googleCalendarSelectedAccountCondition,
} from "./google-calendar-automation-account.service";
import {
  ensureGoogleCalendarWatchForUser$,
  hasEnabledGoogleCalendarConsumer$,
  normalizeGoogleCalendarId,
  normalizeGoogleCalendarIdForConnector$,
  reconcileGoogleCalendarWatchTarget$,
  releaseStagedGoogleCalendarWatchTarget$,
  stageGoogleCalendarWatchTargetForReconfiguration$,
  type StagedGoogleCalendarWatchTarget,
} from "./google-calendar-automation-event.service";
import { resolveGoogleFormsAutomationConnectorId } from "./google-forms-automation-account.service";
import {
  ensureGoogleFormsWatchForUser$,
  readGoogleFormsActivationAccount$,
  reprojectGoogleFormsAutomationOwnership$,
  hasEnabledGoogleFormsConsumer$,
  prepareGoogleFormsResponseEventConfigForPersist$,
} from "./google-forms-automation-event.service";
import { resolveGoogleMeetAutomationConnectorId } from "./google-meet-automation-account.service";
import {
  ensureGoogleMeetTranscriptGeneratedSubscriptionForUser,
  hasEnabledGoogleMeetConsumer,
} from "./google-meet-automation-event.service";
import { persistMorningBriefAutomationToggle$ } from "./morning-brief-automation-toggle.service";
import { officialAutomationLifecycleCondition } from "./workflow-automation-write-condition";
import {
  invalidateNotionPendingEventsForAutomation,
  notionConfigWithConnectorId,
  resolveNotionAutomationConnectorId,
} from "./notion-automation-account.service";
import {
  prepareNotionChildPageEventConfigForPersist$,
  prepareNotionDatabaseItemEventConfigForPersist$,
  prepareNotionPageContentUpdatedEventConfigForPersist$,
  validateNotionEventConfigForConnector$,
} from "./notion-automation-event.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import { readAcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";
import {
  OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
  OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
} from "./official-workflow-constants";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { stripeInvoicePaidWorkflowAutomationEnabledForOwner } from "./stripe-invoice-paid-workflow-automation-feature-switch.service";
import { resolveStripeInvoicePaidAutomationBinding } from "./stripe-invoice-paid-workflow-automation.service";
import { calculateNextRun } from "./time-automation";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "./workflow-automation-account-classification.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import {
  loadVisibleWorkflowById,
  visibleWorkflowCondition,
  workflowSummary,
  type WorkflowMember,
} from "./workflow-data.service";
import {
  ensureWorkflowUserAutomationThread,
  ensureWorkflowUserAutomationThread$,
  prepareWorkflowUserAutomationThread$,
  type WorkflowThreadPreparation,
  loadWorkflowUserAutomationThreadId,
  workflowUserAutomationThreadOwnerCondition,
  preparedWorkflowThreadValues,
} from "./workflow-user-automation-thread.service";
import { lockWorkflowWebhookAutomationTierEligibleForOrg } from "./workflow-webhook-automation-entitlement.service";
import {
  buildWorkflowWebhookSummaryFields,
  workflowWebhookSummaryFields,
  defaultWebhookReceivedEventConfig,
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
  revealWorkflowWebhookSecretFields,
} from "./workflow-webhook-automation.service";

import {
  workflowAutomationSnapshot,
  workflowAutomationSnapshotCondition,
  type WorkflowAutomationSnapshot,
} from "./workflow-automation-snapshot";

type AutomationRow = typeof workflowAutomations.$inferSelect;
type WorkflowRow = typeof workflows.$inferSelect;

class GoogleFormsAccountSelectionChangedError extends Error {
  constructor() {
    super("Google Forms account selection changed during persistence");
    this.name = "GoogleFormsAccountSelectionChangedError";
  }
}

type ChatRunFinishedAutomationEventType = Extract<
  WorkflowAutomationEventType,
  "chat-run-finished"
>;
type GmailAutomationEventType = Extract<
  WorkflowAutomationEventType,
  "gmail-new-message" | "gmail-label-applied"
>;
type GithubAutomationEventType = Extract<
  WorkflowAutomationEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
  | "github-workflow-run-completed"
>;
type GithubWebhookAutomationEventType = Extract<
  GithubAutomationEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
>;
type GoogleCalendarAutomationEventType = Extract<
  WorkflowAutomationEventType,
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled"
>;
type GoogleMeetAutomationEventType = Extract<
  WorkflowAutomationEventType,
  "google-meet-transcript-generated"
>;
type GoogleFormsAutomationEventType = Extract<
  WorkflowAutomationEventType,
  "google-forms-response-submitted"
>;
type NotionAutomationEventType = Extract<
  WorkflowAutomationEventType,
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated"
>;
type StripeInvoicePaidAutomationEventType = Extract<
  WorkflowAutomationEventType,
  "stripe-invoice-paid"
>;
/**
 * Outcome of an automation mutation, mapped to an HTTP response by the route layer.
 */
export type AutomationResult =
  | {
      readonly kind: "ok";
      readonly summary: WorkflowAutomationSummary;
    }
  | {
      readonly kind: "deleted";
    }
  | {
      readonly kind: "not-found";
    }
  | {
      readonly kind: "forbidden";
      readonly message: string;
    }
  | {
      readonly kind: "conflict";
      readonly message: string;
    }
  | {
      readonly kind: "team-required";
      readonly message: string;
    }
  | {
      readonly kind: "bad-request";
      readonly message: string;
    };

function workflowWebhookTeamRequiredResult(): {
  readonly kind: "team-required";
  readonly message: string;
} {
  return {
    kind: "team-required",
    message: "Webhook automations require a Team or Custom workspace",
  };
}

function stripeInvoicePaidWorkflowAutomationsDisabledResult(): {
  readonly kind: "bad-request";
  readonly message: string;
} {
  return {
    kind: "bad-request",
    message: "Stripe invoice-paid workflow automations are not enabled",
  };
}
type AutomationActionFailure = Exclude<
  AutomationResult,
  | {
      readonly kind: "ok";
    }
  | {
      readonly kind: "deleted";
    }
>;
type WorkflowAutomationRunNowResult =
  | {
      readonly kind: "enqueued";
      readonly chatThreadId: string;
    }
  | AutomationActionFailure;

interface CreateEventAutomationWorkflowContext {
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly workflowId: string;
  readonly agentId: string;
  readonly workflowTitle: string;
  readonly automationId?: string;
}

interface ScheduleColumns {
  readonly scheduleType: WorkflowScheduleType;
  readonly cronExpression: string | null;
  readonly intervalSeconds: number | null;
  readonly atTime: Date | null;
  readonly timezone: string;
}
function parseOnceAtTime(
  schedule: Extract<
    WorkflowSchedule,
    {
      type: "once";
    }
  >,
): Date {
  const result = parseScheduledAtTime(schedule.atTime, schedule.timezone);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.date;
}

function scheduleToColumns(schedule: WorkflowSchedule): ScheduleColumns {
  if (schedule.type === "cron") {
    return {
      scheduleType: "cron",
      cronExpression: schedule.cronExpression,
      intervalSeconds: null,
      atTime: null,
      timezone: schedule.timezone,
    };
  }
  if (schedule.type === "once") {
    return {
      scheduleType: "once",
      cronExpression: null,
      intervalSeconds: null,
      atTime: parseOnceAtTime(schedule),
      timezone: schedule.timezone,
    };
  }
  return {
    scheduleType: "loop",
    cronExpression: null,
    intervalSeconds: schedule.intervalSeconds,
    atTime: null,
    timezone: "UTC",
  };
}

/**
 * Validate the schedule against the current time. Returns an error message, or
 * null when the schedule is valid. `intervalSeconds` is already constrained to
 * a positive integer by the contract.
 */
function validateSchedule(
  schedule: WorkflowSchedule,
  now: Date,
): string | null {
  if (schedule.type === "loop") {
    return null;
  }
  if (!isValidTimeZone(schedule.timezone)) {
    return `Invalid timezone: ${schedule.timezone}`;
  }
  if (schedule.type === "once") {
    const atTime = parseScheduledAtTime(schedule.atTime, schedule.timezone);
    if (!atTime.ok) {
      return atTime.message;
    }
    if (atTime.date.getTime() <= now.getTime()) {
      return "Schedule atTime must be in the future";
    }
    return null;
  }
  const next = safeSync(() => {
    return calculateNextRun(schedule.cronExpression, schedule.timezone, now);
  });
  if ("error" in next) {
    return `Invalid cron expression: ${schedule.cronExpression}`;
  }
  if (next.ok === null) {
    return `Cron expression has no future occurrences: ${schedule.cronExpression}`;
  }
  return null;
}

/**
 * First/next fire time for a newly created or (re-)enabled automation. A disabled
 * automation is not scheduled. The poller advances cron/loop recurrence after each
 * run; this only seeds the first run.
 */
function resolveNextRunAt(
  schedule: WorkflowSchedule,
  enabled: boolean,
  now: Date,
  lastRunAt: Date | null = null,
): Date | null {
  if (!enabled) {
    return null;
  }
  if (schedule.type === "cron") {
    return calculateNextRun(schedule.cronExpression, schedule.timezone, now);
  }
  if (schedule.type === "once") {
    return parseOnceAtTime(schedule);
  }
  return resolveLoopNextRunAt(schedule.intervalSeconds, now, lastRunAt);
}

function resolveLoopNextRunAt(
  intervalSeconds: number,
  now: Date,
  lastRunAt: Date | null,
): Date {
  if (!lastRunAt) {
    return now;
  }
  const nextFromLastRun = new Date(
    lastRunAt.getTime() + intervalSeconds * 1000,
  );
  return nextFromLastRun.getTime() > now.getTime() ? nextFromLastRun : now;
}

function summarizeSchedule(schedule: WorkflowSchedule): string {
  if (schedule.type === "cron") {
    return `${schedule.cronExpression} (${schedule.timezone})`;
  }
  if (schedule.type === "loop") {
    return `Every ${schedule.intervalSeconds}s`;
  }
  return `Once at ${schedule.atTime}`;
}

function requiredScheduleColumn<T>(
  row: AutomationRow,
  field: "cronExpression" | "intervalSeconds" | "atTime",
  value: T | null,
): T {
  if (value === null) {
    throw new Error(
      `Workflow automation ${row.id} has a ${row.scheduleType} schedule without ${field}`,
    );
  }
  return value;
}

function rowToSchedule(row: AutomationRow): WorkflowSchedule {
  if (row.kind !== "schedule" || row.scheduleType === null) {
    throw new Error(
      `Workflow automation is not a schedule automation: ${row.id}`,
    );
  }
  if (row.scheduleType === "cron") {
    return {
      type: "cron",
      cronExpression: requiredScheduleColumn(
        row,
        "cronExpression",
        row.cronExpression,
      ),
      timezone: row.timezone,
    };
  }
  if (row.scheduleType === "loop") {
    return {
      type: "loop",
      intervalSeconds: requiredScheduleColumn(
        row,
        "intervalSeconds",
        row.intervalSeconds,
      ),
    };
  }
  return {
    type: "once",
    atTime: requiredScheduleColumn(row, "atTime", row.atTime).toISOString(),
    timezone: row.timezone,
  };
}

function supportedAutomationEventType(
  eventType: string | null,
): eventType is WorkflowAutomationEventType {
  return (
    eventType === "chat-run-finished" ||
    eventType === "gmail-new-message" ||
    eventType === "gmail-label-applied" ||
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed" ||
    eventType === "github-workflow-run-completed" ||
    eventType === "google-calendar-event-created" ||
    eventType === "google-calendar-event-updated" ||
    eventType === "google-calendar-event-cancelled" ||
    eventType === "google-forms-response-submitted" ||
    eventType === "google-meet-transcript-generated" ||
    eventType === "notion-child-page-created" ||
    eventType === "notion-database-item-created" ||
    eventType === "notion-page-content-updated" ||
    eventType === "stripe-invoice-paid" ||
    eventType === "webhook-received"
  );
}

function supportedChatRunFinishedEventType(
  eventType: string | null,
): eventType is ChatRunFinishedAutomationEventType {
  return eventType === "chat-run-finished";
}

function supportedGmailEventType(
  eventType: string | null,
): eventType is GmailAutomationEventType {
  return (
    eventType === "gmail-new-message" || eventType === "gmail-label-applied"
  );
}

function supportedGithubEventType(
  eventType: string | null,
): eventType is GithubAutomationEventType {
  return (
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed" ||
    eventType === "github-workflow-run-completed"
  );
}

function supportedGithubWebhookEventType(
  eventType: string | null,
): eventType is GithubWebhookAutomationEventType {
  return (
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed"
  );
}

function supportedGoogleCalendarEventType(
  eventType: string | null,
): eventType is GoogleCalendarAutomationEventType {
  return (
    eventType === "google-calendar-event-created" ||
    eventType === "google-calendar-event-updated" ||
    eventType === "google-calendar-event-cancelled"
  );
}

function supportedGoogleMeetEventType(
  eventType: string | null,
): eventType is GoogleMeetAutomationEventType {
  return eventType === "google-meet-transcript-generated";
}

function supportedGoogleFormsEventType(
  eventType: string | null,
): eventType is GoogleFormsAutomationEventType {
  return eventType === "google-forms-response-submitted";
}

function supportedNotionEventType(
  eventType: string | null,
): eventType is NotionAutomationEventType {
  return (
    eventType === "notion-child-page-created" ||
    eventType === "notion-database-item-created" ||
    eventType === "notion-page-content-updated"
  );
}

function supportedStripeInvoicePaidEventType(
  eventType: string | null,
): eventType is StripeInvoicePaidAutomationEventType {
  return eventType === "stripe-invoice-paid";
}

function rowSummaryBase(row: AutomationRow, chatThreadId: string | null) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    chatThreadId,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    official:
      row.officialBlueprintKey === null ||
      row.officialAppliedFingerprint === null ||
      row.officialReconciliationStatus === null ||
      row.officialParameterBindings === null ||
      row.officialIntendedEnabled === null
        ? null
        : {
            blueprintKey: row.officialBlueprintKey,
            appliedFingerprint: row.officialAppliedFingerprint,
            reconciliationStatus: row.officialReconciliationStatus,
            intendedEnabled: row.officialIntendedEnabled,
            parameterBindings: row.officialParameterBindings,
          },
  };
}

type RowToSummaryOptions = {
  readonly chatThreadId?: string | null;
  readonly warning?: string;
} & (
  | {
      readonly webhookToken: string;
      readonly webhookSecret: string;
    }
  | {
      readonly webhookToken?: undefined;
      readonly webhookSecret?: undefined;
    }
);

async function resolveAutomationChatThreadId(
  db: ReadonlyDb,
  row: AutomationRow,
  options: RowToSummaryOptions,
): Promise<string | null> {
  if ("chatThreadId" in options) {
    return options.chatThreadId ?? null;
  }
  return await loadWorkflowUserAutomationThreadId(db, {
    orgId: row.orgId,
    userId: row.ownerUserId,
    workflowId: row.workflowId,
  });
}

function notionChildPageRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): WorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: notionChildPageCreatedEventConfigSchema.parse(row.eventConfig),
    schedule: null,
    scheduleSummary: null,
  };
}

function notionDatabaseItemRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): WorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: notionDatabaseItemCreatedEventConfigSchema.parse(
      row.eventConfig,
    ),
    schedule: null,
    scheduleSummary: null,
  };
}

function notionPageContentUpdatedRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): WorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: notionPageContentUpdatedEventConfigSchema.parse(
      row.eventConfig,
    ),
    schedule: null,
    scheduleSummary: null,
  };
}

function githubEventRowToSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): WorkflowAutomationSummary | null {
  const summaryBase = {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event" as const,
    schedule: null,
    scheduleSummary: null,
  };
  switch (row.eventType) {
    case "github-pull-request": {
      return {
        ...summaryBase,
        eventType: "github-pull-request",
        eventConfig: githubPullRequestEventConfigSchema.parse(row.eventConfig),
      };
    }
    case "github-workflow-run-completed": {
      return {
        ...summaryBase,
        eventType: "github-workflow-run-completed",
        eventConfig: githubWorkflowRunCompletedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-workflow-job-completed": {
      return {
        ...summaryBase,
        eventType: "github-workflow-job-completed",
        eventConfig: githubWorkflowJobCompletedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-pull-request-review-submitted": {
      return {
        ...summaryBase,
        eventType: "github-pull-request-review-submitted",
        eventConfig: githubPullRequestReviewSubmittedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-deployment-status-created": {
      return {
        ...summaryBase,
        eventType: "github-deployment-status-created",
        eventConfig: githubDeploymentStatusCreatedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-issue-comment-created": {
      return {
        ...summaryBase,
        eventType: "github-issue-comment-created",
        eventConfig: githubIssueCommentCreatedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    default: {
      return null;
    }
  }
}

function stripeInvoicePaidRowToSummary(
  row: AutomationRow,
  chatThreadId: string | null,
  health: StripeWorkflowAutomationHealth,
): WorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "stripe-invoice-paid",
    eventConfig: stripeInvoicePaidEventConfigSchema.parse(row.eventConfig),
    schedule: null,
    scheduleSummary: null,
    health,
  };
}

function stripeAutomationHealthSummary(
  health:
    | {
        readonly lastMatchingEventReceivedAt: Date | null;
        readonly lastDeliveryStatus: StripeWorkflowAutomationHealth["lastDeliveryStatus"];
        readonly lastDeliveryStatusAt: Date | null;
      }
    | undefined,
): StripeWorkflowAutomationHealth {
  return {
    lastMatchingEventReceivedAt:
      health?.lastMatchingEventReceivedAt?.toISOString() ?? null,
    lastDeliveryStatus: health?.lastDeliveryStatus ?? null,
    lastDeliveryStatusAt: health?.lastDeliveryStatusAt?.toISOString() ?? null,
    warning: health?.lastDeliveryStatus === "failed" ? "delivery_failed" : null,
  };
}

async function loadStripeWorkflowAutomationHealth(
  db: ReadonlyDb,
  automationId: string,
): Promise<StripeWorkflowAutomationHealth> {
  const [health] = await db
    .select({
      lastMatchingEventReceivedAt:
        stripeWorkflowAutomationHealth.lastMatchingEventReceivedAt,
      lastDeliveryStatus: stripeWorkflowAutomationHealth.latestDeliveryStatus,
      lastDeliveryStatusAt:
        stripeWorkflowAutomationHealth.latestDeliveryStatusAt,
    })
    .from(stripeWorkflowAutomationHealth)
    .where(eq(stripeWorkflowAutomationHealth.automationId, automationId))
    .limit(1);
  return stripeAutomationHealthSummary(health);
}

interface EventSummaryWarnings {
  readonly googleCalendar?: GoogleCalendarWatchActionRequiredReason;
  readonly googleForms?: string;
}

function eventRowToSummary(
  row: AutomationRow,
  chatThreadId: string | null,
  warnings: EventSummaryWarnings = {},
): WorkflowAutomationSummary | null {
  if (row.eventType === "chat-run-finished") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "chat-run-finished",
      eventConfig: chatRunFinishedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "gmail-new-message") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: gmailNewMessageEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "gmail-label-applied") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: gmailLabelAppliedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  const githubSummary = githubEventRowToSummary(row, chatThreadId);
  if (githubSummary) {
    return githubSummary;
  }
  if (row.eventType === "google-calendar-event-created") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: googleCalendarEventCreatedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
      ...(warnings.googleCalendar === undefined
        ? {}
        : { warning: warnings.googleCalendar }),
    };
  }
  if (row.eventType === "google-calendar-event-updated") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: googleCalendarEventUpdatedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
      ...(warnings.googleCalendar === undefined
        ? {}
        : { warning: warnings.googleCalendar }),
    };
  }
  if (row.eventType === "google-calendar-event-cancelled") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-cancelled",
      eventConfig: googleCalendarEventCancelledEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
      ...(warnings.googleCalendar === undefined
        ? {}
        : { warning: warnings.googleCalendar }),
    };
  }
  if (row.eventType === "google-forms-response-submitted") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-forms-response-submitted",
      eventConfig: googleFormsResponseSubmittedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
      ...(warnings.googleForms === undefined
        ? {}
        : { warning: warnings.googleForms }),
    };
  }
  if (row.eventType === "google-meet-transcript-generated") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: googleMeetTranscriptGeneratedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "notion-child-page-created") {
    return notionChildPageRowSummary(row, chatThreadId);
  }
  if (row.eventType === "notion-database-item-created") {
    return notionDatabaseItemRowSummary(row, chatThreadId);
  }
  if (row.eventType === "notion-page-content-updated") {
    return notionPageContentUpdatedRowSummary(row, chatThreadId);
  }
  return null;
}

function googleCalendarIdFromAutomationRow(row: AutomationRow): string | null {
  if (row.eventType === "google-calendar-event-created") {
    return googleCalendarEventCreatedEventConfigSchema.parse(row.eventConfig)
      .calendarId;
  }
  if (row.eventType === "google-calendar-event-updated") {
    return googleCalendarEventUpdatedEventConfigSchema.parse(row.eventConfig)
      .calendarId;
  }
  if (row.eventType === "google-calendar-event-cancelled") {
    return googleCalendarEventCancelledEventConfigSchema.parse(row.eventConfig)
      .calendarId;
  }
  return null;
}

function googleCalendarWarningFromState(
  state:
    | {
        readonly reason: GoogleCalendarWatchActionRequiredReason | null;
        readonly startedAt: Date | null;
      }
    | undefined,
): GoogleCalendarWatchActionRequiredReason | undefined {
  if (state && (state.reason === null) !== (state.startedAt === null)) {
    throw new Error("Incomplete Google Calendar action-required episode");
  }
  return state?.reason ?? undefined;
}

async function loadGoogleCalendarAutomationWarning(
  db: ReadonlyDb,
  row: AutomationRow,
): Promise<GoogleCalendarWatchActionRequiredReason | undefined> {
  const calendarId = googleCalendarIdFromAutomationRow(row);
  if (calendarId === null || row.eventConnectorId === null) {
    return undefined;
  }
  const [state] = await db
    .select({
      reason: googleCalendarWatchStates.actionRequiredReason,
      startedAt: googleCalendarWatchStates.actionRequiredAt,
    })
    .from(googleCalendarWatchStates)
    .where(
      and(
        eq(googleCalendarWatchStates.orgId, row.orgId),
        eq(googleCalendarWatchStates.userId, row.ownerUserId),
        eq(googleCalendarWatchStates.connectorId, row.eventConnectorId),
        eq(googleCalendarWatchStates.calendarId, calendarId),
      ),
    )
    .limit(1);
  return googleCalendarWarningFromState(state);
}

async function rowToSummary(
  db: ReadonlyDb,
  row: AutomationRow,
  options: RowToSummaryOptions = {},
): Promise<WorkflowAutomationSummary> {
  const chatThreadId = await resolveAutomationChatThreadId(db, row, options);
  if (row.kind === "event") {
    if (row.eventType === "stripe-invoice-paid") {
      return stripeInvoicePaidRowToSummary(
        row,
        chatThreadId,
        await loadStripeWorkflowAutomationHealth(db, row.id),
      );
    }
    if (row.eventType === "webhook-received") {
      return {
        ...rowSummaryBase(row, chatThreadId),
        kind: "event",
        eventType: "webhook-received",
        eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
        schedule: null,
        scheduleSummary: null,
        ...(await buildWorkflowWebhookSummaryFields(db, {
          automation: row,
          ...options,
        })),
      };
    }
    const eventSummary = eventRowToSummary(row, chatThreadId, {
      googleCalendar: await loadGoogleCalendarAutomationWarning(db, row),
      googleForms: options.warning,
    });
    if (eventSummary) {
      return eventSummary;
    }
  }
  const schedule = rowToSchedule(row);
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "schedule",
    schedule,
    scheduleSummary: summarizeSchedule(schedule),
  };
}
async function rowToPublicSummary(
  db: ReadonlyDb,
  row: AutomationRow,
  options: {
    readonly chatThreadId?: string | null;
  } = {},
): Promise<WorkflowAutomationSummary | null> {
  if (row.kind === "event" && !supportedAutomationEventType(row.eventType)) {
    return null;
  }
  return await rowToSummary(db, row, options);
}

interface UsableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}
async function loadAgent(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<UsableAgent | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
    .limit(1);
  return agent ?? null;
}

/**
 * An automation run executes as its owner, so the owner must be able to run the
 * workflow's owning agent: public agents are runnable by any member, private
 * agents only by their owner. This is a "use" gate, not the agent "manage" gate.
 */
function canUseAgent(agent: UsableAgent, member: WorkflowMember): boolean {
  return agent.visibility === "public" || agent.owner === member.userId;
}
async function loadAutomationWorkflowRunTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly workflowId: string;
  },
): Promise<{
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowTitle: string;
} | null> {
  const [workflow] = await db
    .select({
      agentId: workflows.agentId,
      workflowName: workflows.name,
      workflowDisplayName: workflows.displayName,
    })
    .from(workflows)
    .where(
      and(eq(workflows.orgId, args.orgId), eq(workflows.id, args.workflowId)),
    )
    .limit(1);
  if (!workflow) {
    return null;
  }
  return {
    agentId: workflow.agentId,
    workflowName: workflow.workflowName,
    workflowTitle: workflow.workflowDisplayName ?? workflow.workflowName,
  };
}
async function loadAutomationRow(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly automationId: string;
  },
): Promise<AutomationRow | null> {
  const [row] = await db
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.id, args.automationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadAutomationOwnerTimezone(
  db: ReadonlyDb,
  automation: AutomationRow,
): Promise<string | null> {
  const [row] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, automation.orgId),
        eq(orgMembersMetadata.userId, automation.ownerUserId),
      ),
    )
    .limit(1);
  return row?.timezone ?? null;
}

/**
 * List the caller's own workflow automations under a workflow. Detail pages show
 * only the automations the caller owns, so this filters by `ownerUserId`.
 * Visibility of the workflow itself is the caller's responsibility (the workflow
 * must already be resolved as visible).
 */
export async function loadWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly workflowId: string;
    readonly userId: string;
  },
): Promise<readonly WorkflowAutomationSummary[]> {
  const rows = await db
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.workflowId, args.workflowId),
        eq(workflowAutomations.ownerUserId, args.userId),
      ),
    )
    .orderBy(asc(workflowAutomations.createdAt));
  const chatThreadId = await loadWorkflowUserAutomationThreadId(db, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
  });
  const summaries = await Promise.all(
    rows.map((row) => {
      return rowToPublicSummary(db, row, { chatThreadId });
    }),
  );
  return summaries.flatMap((summary) => {
    return summary ? [summary] : [];
  });
}

/**
 * List the caller's workflow automations across every visible workflow in one
 * lightweight projection. This deliberately avoids workflow detail loading, so
 * it does not read workflow volume files from R2.
 */
export async function listWorkspaceWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
  },
): Promise<readonly WorkflowAutomationsListEntry[]> {
  const rows = await db
    .select({
      automation: workflowAutomationColumns(),
      workflow: workflows,
      agent: {
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
        name: agents.name,
        displayName: agents.displayName,
      },
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .innerJoin(agents, eq(agents.id, workflows.agentId))
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
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.member.userId),
        visibleWorkflowCondition(args.member),
      ),
    )
    .orderBy(asc(workflowAutomations.createdAt), asc(workflowAutomations.id));

  const hasOfficialWorkflow = rows.some((row) => {
    return row.workflow.officialDefinitionName !== null;
  });
  const acceptedCatalog = hasOfficialWorkflow
    ? await readAcceptedOfficialWorkflowCatalog(db)
    : null;
  const officialLifecycleByName = new Map(
    acceptedCatalog?.payload.definitions.map((definition) => {
      return [definition.name, definition.lifecycle] as const;
    }) ?? [],
  );

  const entries = await Promise.all(
    rows.map(async (row): Promise<WorkflowAutomationsListEntry | null> => {
      const automation = await rowToPublicSummary(db, row.automation, {
        chatThreadId: row.chatThreadId ?? null,
      });
      if (!automation) {
        return null;
      }
      return {
        workflow: workflowSummary({
          workflow: row.workflow,
          agent: row.agent,
          member: args.member,
          officialDefinitionLifecycle: row.workflow.officialDefinitionName
            ? (officialLifecycleByName.get(
                row.workflow.officialDefinitionName,
              ) ?? "unavailable")
            : undefined,
        }),
        automation,
      };
    }),
  );
  return entries.flatMap((entry) => {
    return entry ? [entry] : [];
  });
}

function chatThreadAutomationFromSummary(args: {
  readonly workflow: WorkflowRow;
  readonly summary: WorkflowAutomationSummary | null;
  readonly chatThreadId: string | null;
}): readonly ChatThreadWorkflowAutomation[] {
  const { workflow, summary, chatThreadId } = args;
  if (!summary || chatThreadId === null) {
    return [];
  }
  return [
    {
      ...summary,
      chatThreadId,
      workflow: {
        id: workflow.id,
        agentId: workflow.agentId,
        name: workflow.name,
        displayName: workflow.displayName,
        description: workflow.description,
      },
    },
  ];
}

/**
 * List workflow automations the caller owns that are bound to a chat thread,
 * joined with the workflow identity needed by the chat sidebar.
 */
export async function listThreadBoundWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<readonly ChatThreadWorkflowAutomation[]> {
  const rows = await db
    .select({
      automation: workflowAutomationColumns(),
      workflow: workflows,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(workflowAutomations)
    .innerJoin(
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
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowUserAutomationThreads.chatThreadId, args.threadId),
        or(
          isNull(workflows.officialDefinitionName),
          eq(workflows.officialInstallationState, "installed"),
        ),
      ),
    )
    .orderBy(asc(workflowAutomations.createdAt));

  const summaries = await Promise.all(
    rows.map(async ({ automation, workflow, chatThreadId }) => {
      const summary = await rowToPublicSummary(db, automation, {
        chatThreadId,
      });
      return { workflow, summary, chatThreadId };
    }),
  );

  return summaries.flatMap((summary) => {
    return chatThreadAutomationFromSummary(summary);
  });
}

/**
 * Load a single automation if its workflow is visible to the caller. Read-only;
 * does not require ownership.
 */
export async function getWorkflowAutomation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<WorkflowAutomationSummary | null> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (!automation) {
    return null;
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return null;
  }
  return await rowToPublicSummary(db, automation);
}

export async function revealWorkflowWebhookSecret(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<WorkflowWebhookSecretResponse | null> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (
    !automation ||
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received" ||
    automation.ownerUserId !== args.member.userId
  ) {
    return null;
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return null;
  }
  return await revealWorkflowWebhookSecretFields(db, { automation });
}

interface CreateScheduleAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly schedule: WorkflowSchedule;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateGmailEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GmailAutomationEventType;
  readonly eventConfig: GmailAutomationEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateGithubEventAutomationInputBase {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}
type CreateGithubEventAutomationInput =
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-pull-request";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "pull_request";
        }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-workflow-run-completed";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "workflow_run_completed";
        }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-workflow-job-completed";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "workflow_job_completed";
        }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-pull-request-review-submitted";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "pull_request_review_submitted";
        }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-deployment-status-created";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "deployment_status_created";
        }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-issue-comment-created";
      readonly eventConfig: Extract<
        GithubAutomationEventConfig,
        {
          readonly event: "issue_comment_created";
        }
      >;
    });

interface CreateChatRunFinishedEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: ChatRunFinishedAutomationEventType;
  readonly eventConfig: ChatRunFinishedEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateGoogleCalendarEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GoogleCalendarAutomationEventType;
  readonly eventConfig: GoogleCalendarAutomationEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateGoogleFormsEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GoogleFormsAutomationEventType;
  readonly eventConfig:
    | GoogleFormsResponseSubmittedEventCreateConfig
    | GoogleFormsResponseSubmittedEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateGoogleMeetEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GoogleMeetAutomationEventType;
  readonly eventConfig: GoogleMeetAutomationEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateNotionEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: NotionAutomationEventType;
  readonly eventConfig:
    | NotionChildPageCreatedEventCreateConfig
    | NotionChildPageCreatedEventConfig
    | NotionDatabaseItemCreatedEventCreateConfig
    | NotionDatabaseItemCreatedEventConfig
    | NotionPageContentUpdatedEventCreateConfig
    | NotionPageContentUpdatedEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateStripeInvoicePaidEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: StripeInvoicePaidAutomationEventType;
  readonly eventConfig: StripeInvoicePaidEventCreateConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
}

interface CreateWebhookEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: "webhook-received";
  readonly eventConfig?: WebhookReceivedEventConfig;
  readonly enabled: boolean;
  readonly autonomyBudget?: number;
  readonly officialInstallation?: OfficialAutomationCreationMetadata;
}

export interface OfficialAutomationCreationMetadata {
  readonly definitionName: string;
  readonly blueprintKey: string;
  readonly appliedFingerprint: string;
  readonly parameterBindings: readonly OfficialWorkflowParameterBinding[];
  readonly resultEmailEnabled: boolean;
  readonly automationId?: string;
  readonly installationState?: "installing" | "installed";
  readonly intendedEnabled?: boolean;
  readonly stagedMaterialization?: boolean;
}

export type CreateAutomationInput = (
  | CreateScheduleAutomationInput
  | CreateChatRunFinishedEventAutomationInput
  | CreateGmailEventAutomationInput
  | CreateGithubEventAutomationInput
  | CreateGoogleCalendarEventAutomationInput
  | CreateGoogleFormsEventAutomationInput
  | CreateGoogleMeetEventAutomationInput
  | CreateNotionEventAutomationInput
  | CreateStripeInvoicePaidEventAutomationInput
  | CreateWebhookEventAutomationInput
) & {
  readonly officialInstallation?: OfficialAutomationCreationMetadata;
};
type CreateEventAutomationInput = Exclude<
  CreateAutomationInput,
  CreateScheduleAutomationInput
>;

function automationCreateInputIsSchedule(
  args: CreateAutomationInput,
): args is CreateScheduleAutomationInput {
  return "schedule" in args;
}

function automationCreateInputIsChatRunFinished(
  args: CreateEventAutomationInput,
): args is CreateChatRunFinishedEventAutomationInput {
  return supportedChatRunFinishedEventType(args.eventType);
}

function automationCreateInputIsGmail(
  args: CreateEventAutomationInput,
): args is CreateGmailEventAutomationInput {
  return supportedGmailEventType(args.eventType);
}
function automationCreateInputIsGithubWebhook(
  args: CreateEventAutomationInput,
): args is Extract<
  CreateGithubEventAutomationInput,
  {
    readonly eventType: GithubWebhookAutomationEventType;
  }
> {
  return supportedGithubWebhookEventType(args.eventType);
}

function automationCreateInputIsGithub(
  args: CreateEventAutomationInput,
): args is CreateGithubEventAutomationInput {
  return supportedGithubEventType(args.eventType);
}

function automationCreateInputIsGoogleCalendar(
  args: CreateEventAutomationInput,
): args is CreateGoogleCalendarEventAutomationInput {
  return supportedGoogleCalendarEventType(args.eventType);
}

function automationCreateInputIsGoogleForms(
  args: CreateEventAutomationInput,
): args is CreateGoogleFormsEventAutomationInput {
  return supportedGoogleFormsEventType(args.eventType);
}

function automationCreateInputIsGoogleMeet(
  args: CreateEventAutomationInput,
): args is CreateGoogleMeetEventAutomationInput {
  return supportedGoogleMeetEventType(args.eventType);
}

function automationCreateInputIsNotion(
  args: CreateEventAutomationInput,
): args is CreateNotionEventAutomationInput {
  return supportedNotionEventType(args.eventType);
}

function automationCreateInputIsStripeInvoicePaid(
  args: CreateEventAutomationInput,
): args is CreateStripeInvoicePaidEventAutomationInput {
  return supportedStripeInvoicePaidEventType(args.eventType);
}

type InsertEventAutomationArgs = {
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly input:
    | CreateChatRunFinishedEventAutomationInput
    | CreateGmailEventAutomationInput
    | CreateGithubEventAutomationInput
    | CreateGoogleCalendarEventAutomationInput
    | (CreateGoogleFormsEventAutomationInput & {
        readonly eventConfig: GoogleFormsResponseSubmittedEventConfig;
      })
    | CreateGoogleMeetEventAutomationInput
    | (CreateStripeInvoicePaidEventAutomationInput & {
        readonly eventConfig: StripeInvoicePaidEventConfig;
      })
    | (CreateNotionEventAutomationInput & {
        readonly eventConfig: NotionAutomationEventConfig;
      });
  readonly workflowId: string;
  readonly agentId: string;
  readonly workflowTitle: string;
  readonly automationId?: string;
  readonly currentTime: Date;
};
function eventAutomationConnectorSlug(
  input: InsertEventAutomationArgs["input"],
) {
  return automationCreateInputIsGmail(input)
    ? "gmail"
    : automationCreateInputIsGoogleCalendar(input)
      ? "google-calendar"
      : automationCreateInputIsNotion(input)
        ? "notion"
        : automationCreateInputIsGoogleForms(input)
          ? "google-forms"
          : automationCreateInputIsGoogleMeet(input)
            ? "google-meet"
            : null;
}

const readEventAutomationConnectorId$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly connectorSlug: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const [selected] = parseRawRows(
      z.object({ connectorId: z.string().nullable() }),
      await db.execute(workflowAutomationConnectorSelectionSql(args)),
    );
    signal.throwIfAborted();
    return selected?.connectorId ?? null;
  },
);

function preparedEventAutomationValues(
  args: InsertEventAutomationArgs,
  eventConnectorId: string | null,
) {
  return {
    id: args.automationId,
    orgId: args.input.orgId,
    workflowId: args.workflowId,
    ownerUserId: args.input.member.userId,
    kind: "event" as const,
    eventType: args.input.eventType,
    eventConfig: args.input.eventConfig,
    eventConnectorId,
    scheduleType: null,
    cronExpression: null,
    intervalSeconds: null,
    atTime: null,
    timezone: "UTC",
    enabled: args.input.enabled,
    nextRunAt: null,
    ...(args.input.autonomyBudget === undefined
      ? {}
      : { autonomyBudget: args.input.autonomyBudget }),
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

function workflowThreadCreatedEventValues(
  owner: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
  values: ReturnType<typeof preparedWorkflowThreadValues>,
) {
  return {
    ...owner,
    kind: "created" as const,
    chatThreadId: values.id,
    title: values.title,
    selectedModel: values.selectedModel,
    modelSettings: values.modelSettings,
    cloudBrowserEnabled: values.cloudBrowserEnabled,
    serviceTier:
      values.codexServiceTier === "fast" ? ("priority" as const) : null,
    createdAt: values.createdAt,
  };
}

interface CreatedEventAutomation {
  readonly summary: WorkflowAutomationSummary;
  readonly snapshot: WorkflowAutomationSnapshot;
}

function requireCreatedEventAutomation(
  result: CreatedEventAutomation | null,
): CreatedEventAutomation {
  if (!result) {
    throw new Error(
      "Workflow automation account changed without an expected account guard",
    );
  }
  return result;
}

function eventAutomationThreadOwner(args: InsertEventAutomationArgs) {
  return {
    orgId: args.input.orgId,
    userId: args.input.member.userId,
    workflowId: args.workflowId,
    agentId: args.agentId,
    workflowTitle: args.workflowTitle,
    currentTime: args.currentTime,
  };
}

function workflowAutomationThreadParentLocksSql(
  owner: ReturnType<typeof eventAutomationThreadOwner>,
) {
  return [
    sql`SELECT ${agents.id} FROM ${agents}
      WHERE ${agents.orgId} = ${owner.orgId} AND ${agents.id} = ${owner.agentId}::uuid
      FOR KEY SHARE`,
    sql`SELECT ${workflows.id} FROM ${workflows}
      WHERE ${workflows.orgId} = ${owner.orgId} AND ${workflows.id} = ${owner.workflowId}::uuid
        AND ${workflows.agentId} = ${owner.agentId}::uuid
      FOR KEY SHARE`,
  ];
}

// Return the committed receipt before propagating cancellation: watch owners
// must observe that receipt to finish their existing compensation handoff.
const insertEventAutomation$ = command(
  async (
    { set },
    args: InsertEventAutomationArgs & {
      readonly expectedEventConnectorId?: string;
    },
  ): Promise<CreatedEventAutomation | null> => {
    const db = set(writeDb$);
    const owner = eventAutomationThreadOwner(args);
    const connectorSlug = eventAutomationConnectorSlug(args.input);
    return await db.transaction(async (tx) => {
      let eventConnectorId: string | null = null;
      if (connectorSlug !== null) {
        await tx.execute(
          builtinConnectorStateLockStatement({ ...owner, connectorSlug }),
        );
        const [selected] = parseRawRows(
          z.object({ connectorId: z.string().nullable() }),
          await tx.execute(
            workflowAutomationConnectorSelectionSql({
              ...owner,
              connectorSlug,
            }),
          ),
        );
        eventConnectorId = selected?.connectorId ?? null;
      }
      if (
        args.expectedEventConnectorId !== undefined &&
        eventConnectorId !== args.expectedEventConnectorId
      ) {
        return null;
      }
      for (const statement of workflowAutomationThreadParentLocksSql(owner)) {
        await tx.execute(statement);
      }
      await tx
        .insert(workflowUserAutomationThreads)
        .values({
          orgId: owner.orgId,
          userId: owner.userId,
          workflowId: owner.workflowId,
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .onConflictDoNothing({
          target: [
            workflowUserAutomationThreads.orgId,
            workflowUserAutomationThreads.userId,
            workflowUserAutomationThreads.workflowId,
          ],
        });
      const [binding] = await tx
        .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
        .from(workflowUserAutomationThreads)
        .where(workflowUserAutomationThreadOwnerCondition(owner))
        .limit(1)
        .for("update");
      let chatThreadId = binding?.chatThreadId;
      if (!chatThreadId) {
        const values = preparedWorkflowThreadValues(
          owner,
          args.threadPreparation,
          randomUUID(),
        );
        await tx.insert(chatThreads).values(values);
        await tx.execute(
          chatThreadEventInsertSql(
            workflowThreadCreatedEventValues(owner, values),
          ),
        );
        const [updated] = await tx
          .update(workflowUserAutomationThreads)
          .set({ chatThreadId: values.id, updatedAt: args.currentTime })
          .where(workflowUserAutomationThreadOwnerCondition(owner))
          .returning({
            chatThreadId: workflowUserAutomationThreads.chatThreadId,
          });
        if (!updated?.chatThreadId) {
          throw new Error("Failed to persist workflow automation chat thread");
        }
        chatThreadId = updated.chatThreadId;
      }
      if (
        automationCreateInputIsGoogleForms(args.input) &&
        eventConnectorId !== args.input.eventConfig.connectorId
      ) {
        throw new GoogleFormsAccountSelectionChangedError();
      }
      const [row] = await tx
        .insert(workflowAutomations)
        .values(preparedEventAutomationValues(args, eventConnectorId))
        .returning(workflowAutomationColumns());
      if (!row) {
        throw new Error("Failed to create workflow automation");
      }
      const calendarId = googleCalendarIdFromAutomationRow(row);
      let warning: GoogleCalendarWatchActionRequiredReason | undefined;
      if (calendarId !== null && row.eventConnectorId !== null) {
        const [state] = await tx
          .select({
            reason: googleCalendarWatchStates.actionRequiredReason,
            startedAt: googleCalendarWatchStates.actionRequiredAt,
          })
          .from(googleCalendarWatchStates)
          .where(
            and(
              eq(googleCalendarWatchStates.orgId, row.orgId),
              eq(googleCalendarWatchStates.userId, row.ownerUserId),
              eq(googleCalendarWatchStates.connectorId, row.eventConnectorId),
              eq(googleCalendarWatchStates.calendarId, calendarId),
            ),
          )
          .limit(1);
        warning = googleCalendarWarningFromState(state);
      }
      const summary = eventRowToSummary(row, chatThreadId, {
        googleCalendar: warning,
      });
      if (!summary) {
        throw new Error("Unsupported created workflow automation event");
      }
      return {
        summary,
        snapshot: {
          observedUpdatedAt: row.observedUpdatedAt,
          observedXmin: row.observedXmin,
        },
      };
    });
  },
);

type PreparedWebhookCredentials = Pick<
  typeof workflowWebhookAutomations.$inferInsert,
  "tokenHash" | "encryptedToken" | "encryptedSecret" | "secretLastFour"
>;
async function prepareWebhookCredentials(
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly token: string;
  readonly secret: string;
  readonly row: PreparedWebhookCredentials;
}> {
  const token = mintWorkflowWebhookToken();
  const secret = mintWorkflowWebhookSecret();
  const encryptedToken = await encryptWorkflowWebhookToken(token, args);
  signal.throwIfAborted();
  const encryptedSecret = await encryptWorkflowWebhookSecret(secret, args);
  signal.throwIfAborted();
  return {
    token,
    secret,
    row: {
      tokenHash: hashWorkflowWebhookToken(token),
      encryptedToken,
      encryptedSecret,
      secretLastFour: secret.slice(-4),
    },
  };
}

async function insertWebhookEventAutomation(
  db: Db,
  args: {
    readonly threadPreparation: WorkflowThreadPreparation;
    readonly input: CreateWebhookEventAutomationInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly automationId?: string;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<AutomationResult> {
  const capabilities = await loadOrgPlanCapabilities(db, args.input.orgId);
  signal.throwIfAborted();
  if (capabilities?.workflowWebhookAutomationAllowed !== true) {
    return workflowWebhookTeamRequiredResult();
  }
  // KMS can stall independently of PostgreSQL. Prepare both ciphertexts before
  // taking the entitlement, workflow binding, or shared chat sequence locks.
  const credentials = await prepareWebhookCredentials(
    { orgId: args.input.orgId, userId: args.input.member.userId },
    signal,
  );
  signal.throwIfAborted();
  return await db.transaction(async (tx) => {
    // A downgrade may have committed while credentials were being prepared.
    const tierEligible = await lockWorkflowWebhookAutomationTierEligibleForOrg(
      tx,
      { orgId: args.input.orgId },
      signal,
    );
    if (!tierEligible) {
      return workflowWebhookTeamRequiredResult();
    }
    const access = await lockWebhookAutomationCreationAccess(tx, args);
    signal.throwIfAborted();
    if (access.kind !== "ok") {
      return access;
    }

    const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: access.workflow.displayName ?? access.workflow.name,
      preparation: args.threadPreparation,
      currentTime: args.currentTime,
    });

    const row = await insertWorkflowAutomation(tx, {
      id: args.automationId,
      orgId: args.input.orgId,
      workflowId: args.workflowId,
      ownerUserId: args.input.member.userId,
      kind: "event",
      eventType: args.input.eventType,
      eventConfig:
        args.input.eventConfig ?? defaultWebhookReceivedEventConfig(),
      scheduleType: null,
      cronExpression: null,
      intervalSeconds: null,
      atTime: null,
      timezone: "UTC",
      enabled: args.input.enabled,
      nextRunAt: null,
      ...(args.input.autonomyBudget === undefined
        ? {}
        : { autonomyBudget: args.input.autonomyBudget }),
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    });
    if (!row) {
      throw new Error("Failed to create workflow automation");
    }

    await tx.insert(workflowWebhookAutomations).values({
      automationId: row.id,
      ...credentials.row,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    });

    return {
      kind: "ok",
      summary: await rowToSummary(tx, row, {
        chatThreadId,
        webhookToken: credentials.token,
        webhookSecret: credentials.secret,
      }),
    };
  });
}
async function lockWebhookAutomationCreationAccess(
  tx: Tx,
  args: {
    readonly input: CreateWebhookEventAutomationInput;
    readonly workflowId: string;
    readonly agentId: string;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly workflow: WorkflowRow;
    }
  | AutomationActionFailure
> {
  // Freeze the source permissions in agent -> workflow order. Access may have
  // been revoked while KMS prepared the credentials outside this transaction.
  const [agent] = await tx
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.input.orgId)))
    .for("share");
  const [workflow] = await tx
    .select({ agentId: workflows.agentId })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, args.workflowId),
        eq(workflows.orgId, args.input.orgId),
      ),
    )
    .for("share");
  if (!agent || workflow?.agentId !== agent.id) {
    return { kind: "not-found" };
  }
  const visible = await loadVisibleWorkflowById(tx, {
    orgId: args.input.orgId,
    member: args.input.member,
    workflowId: args.workflowId,
    includeInstallingOfficial: args.input.officialInstallation !== undefined,
  });
  if (!visible) {
    return { kind: "not-found" };
  }
  const official = args.input.officialInstallation;
  if (
    official !== undefined &&
    (visible.workflow.officialDefinitionName !== official.definitionName ||
      visible.workflow.officialInstallationState !==
        (official.installationState ?? "installing") ||
      visible.workflow.ownerUserId !== args.input.member.userId)
  ) {
    return { kind: "not-found" };
  }
  if (
    visible.workflow.officialDefinitionName !== null &&
    official === undefined
  ) {
    return {
      kind: "conflict",
      message: OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
    };
  }
  if (!canUseAgent(agent, args.input.member)) {
    return {
      kind: "forbidden",
      message: "You do not have access to the workflow's agent",
    };
  }
  return { kind: "ok", workflow: visible.workflow };
}
const prepareGmailEventConfigForPersist$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly eventType: WorkflowAutomationEventType;
      readonly eventConfig: GmailAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly eventConfig: GmailAutomationEventConfig;
      }
    | {
        readonly kind: "bad-request";
        readonly message: string;
      }
  > => {
    if (args.eventType === "gmail-new-message") {
      if (args.eventConfig.event !== "new_message") {
        return {
          kind: "bad-request",
          message: "eventConfig must be a Gmail new message config",
        };
      }
      return { kind: "ok", eventConfig: args.eventConfig };
    }
    if (args.eventConfig.event !== "label_applied") {
      return {
        kind: "bad-request",
        message: "eventConfig must be a Gmail label applied config",
      };
    }
    const label = await set(
      resolveGmailLabelForUser$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        labelName: args.eventConfig.labelName,
      },
      signal,
    );
    signal.throwIfAborted();
    if (label.kind !== "ok") {
      return { kind: "bad-request", message: label.message };
    }
    return {
      kind: "ok",
      eventConfig: {
        ...args.eventConfig,
        labelName: label.labelName,
        resolvedLabelId: label.labelId,
      },
    };
  },
);
const validateCreatedGmailAutomationAccount$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly input: CreateGmailEventAutomationInput;
      readonly eventConfig: GmailAutomationEventConfig;
      readonly expectedConnectorId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly connectorId: string;
      }
    | {
        readonly kind: "bad-request";
        readonly message: string;
      }
  > => {
    const db = set(writeDb$);
    const [persistedAccount] = await db
      .select({ connectorId: workflowAutomations.eventConnectorId })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automationId))
      .limit(1);
    signal.throwIfAborted();
    const connectorId = persistedAccount?.connectorId ?? null;
    if (connectorId === args.expectedConnectorId) {
      return { kind: "ok", connectorId };
    }
    // eslint-disable-next-line api/signal-check-await -- Finish the paired watch cleanup after deleting the local automation.
    await db
      .delete(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automationId));
    await bestEffort(
      set(
        reconcileAutomationEventWatches$,
        {
          automations: [
            {
              orgId: args.input.orgId,
              ownerUserId: args.input.member.userId,
              eventType: args.input.eventType,
              eventConfig: args.eventConfig,
              eventConnectorId: connectorId,
            },
          ],
        },
        signal,
      ),
      signal,
    );
    return connectorId === null
      ? {
          kind: "bad-request",
          message: "Connect Gmail before adding a Gmail event automation",
        }
      : {
          kind: "bad-request",
          message:
            "Gmail account selection changed; retry adding the automation",
        };
  },
);
const deleteFailedEventAutomation$ = command(
  async ({ set }, automationId: string): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(workflowAutomations)
      .where(eq(workflowAutomations.id, automationId));
  },
);

const createGmailEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateGmailEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const eventConnectorId = await set(
      readGmailAutomationConnectorId$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message: "Connect Gmail before adding a Gmail event automation",
      };
    }
    const preparedConfig = await set(
      prepareGmailEventConfigForPersist$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        connectorId: eventConnectorId,
        eventType: args.input.eventType,
        eventConfig: args.input.eventConfig,
      },
      signal,
    );
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }
    const hadConsumer = args.input.enabled
      ? await set(
          hasEnabledGmailConsumer$,
          {
            orgId: args.input.orgId,
            userId: args.input.member.userId,
            connectorId: eventConnectorId,
          },
          signal,
        )
      : false;
    // eslint-disable-next-line api/signal-check-await -- Complete the committed automation handoff and its watch compensation before propagating cancellation.
    const created = await set(insertEventAutomation$, {
      input: { ...args.input, eventConfig: preparedConfig.eventConfig },
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
    });
    const { summary } = requireCreatedEventAutomation(created);
    const persistedAccount = await set(
      validateCreatedGmailAutomationAccount$,
      {
        automationId: summary.id,
        input: args.input,
        eventConfig: preparedConfig.eventConfig,
        expectedConnectorId: eventConnectorId,
      },
      signal,
    );
    if (persistedAccount.kind !== "ok") {
      return persistedAccount;
    }
    const persistedConnectorId = persistedAccount.connectorId;
    if (!args.input.enabled) {
      signal.throwIfAborted();
      return { kind: "ok", summary };
    }
    signal.throwIfAborted();
    const watchResult = await onRejection(
      set(
        ensureGmailWatchForUser$,
        {
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          connectorId: persistedConnectorId,
          forceRefresh: !hadConsumer,
        },
        signal,
      ),
      async () => {
        await set(deleteFailedEventAutomation$, summary.id);
      },
    );
    signal.throwIfAborted();
    if (watchResult.kind === "ok") {
      return { kind: "ok", summary };
    }
    // eslint-disable-next-line api/signal-check-await -- Finish the paired watch cleanup after deleting the local automation.
    await set(deleteFailedEventAutomation$, summary.id);
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: [
          {
            orgId: args.input.orgId,
            ownerUserId: args.input.member.userId,
            eventType: args.input.eventType,
            eventConfig: preparedConfig.eventConfig,
            eventConnectorId: persistedConnectorId,
          },
        ],
      },
      signal,
    );
    return { kind: "bad-request", message: watchResult.message };
  },
);

const insertScheduleAutomation$ = command(
  async (
    { set },
    args: {
      readonly input: CreateScheduleAutomationInput;
      readonly workflowId: string;
      readonly automationId?: string;
      readonly columns: ScheduleColumns;
      readonly nextRunAt: Date | null;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const db = set(writeDb$);
    const summary = await db.transaction(async (tx) => {
      // Preserve and lock an existing workflow-user binding without materializing
      // an empty thread. The first scheduled or manual run creates one if absent.
      const [binding] = await tx
        .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
        .from(workflowUserAutomationThreads)
        .where(
          and(
            eq(workflowUserAutomationThreads.orgId, args.input.orgId),
            eq(workflowUserAutomationThreads.userId, args.input.member.userId),
            eq(workflowUserAutomationThreads.workflowId, args.workflowId),
          ),
        )
        .limit(1)
        .for("update");
      const chatThreadId = binding?.chatThreadId ?? null;

      const [row] = await tx
        .insert(workflowAutomations)
        .values({
          id: args.automationId,
          orgId: args.input.orgId,
          workflowId: args.workflowId,
          ownerUserId: args.input.member.userId,
          kind: "schedule",
          eventType: null,
          eventConfig: null,
          scheduleType: args.columns.scheduleType,
          cronExpression: args.columns.cronExpression,
          intervalSeconds: args.columns.intervalSeconds,
          atTime: args.columns.atTime,
          timezone: args.columns.timezone,
          enabled: args.input.enabled,
          nextRunAt: args.nextRunAt,
          ...(args.input.autonomyBudget === undefined
            ? {}
            : { autonomyBudget: args.input.autonomyBudget }),
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .returning(workflowAutomationColumns());
      if (!row) {
        throw new Error("Failed to create workflow automation");
      }
      const schedule = rowToSchedule(row);
      return {
        ...rowSummaryBase(row, chatThreadId),
        kind: "schedule" as const,
        schedule,
        scheduleSummary: summarizeSchedule(schedule),
      };
    });
    signal.throwIfAborted();
    return summary;
  },
);

const createWebhookEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateWebhookEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const result = await insertWebhookEventAutomation(
      db,
      {
        input: args.input,
        threadPreparation: args.context.threadPreparation,
        workflowId: args.context.workflowId,
        agentId: args.context.agentId,
        automationId: args.context.automationId,
        currentTime: nowDate(),
      },
      signal,
    );
    signal.throwIfAborted();
    return result;
  },
);

const createGithubWorkflowRunEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: Extract<
        CreateGithubEventAutomationInput,
        {
          readonly eventType: "github-workflow-run-completed";
        }
      >;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.input.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return {
        kind: "bad-request",
        message:
          "Install GitHub before creating GitHub workflow run automations",
      };
    }
    const eventConfig = githubWorkflowRunCompletedEventConfigSchema.parse(
      args.input.eventConfig,
    );
    const created = await set(insertEventAutomation$, {
      input: { ...args.input, eventConfig },
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    const { summary } = requireCreatedEventAutomation(created);
    return { kind: "ok", summary };
  },
);

const createGithubWebhookEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: Extract<
        CreateGithubEventAutomationInput,
        {
          readonly eventType: GithubWebhookAutomationEventType;
        }
      >;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.input.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return {
        kind: "bad-request",
        message: "Install GitHub before creating GitHub webhook automations",
      };
    }
    if (
      !parseGithubWebhookAutomationConfig(
        args.input.eventType,
        args.input.eventConfig,
      )
    ) {
      return {
        kind: "bad-request",
        message: "eventConfig must match the GitHub automation type",
      };
    }
    const created = await set(insertEventAutomation$, {
      input: args.input,
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    const { summary } = requireCreatedEventAutomation(created);
    return { kind: "ok", summary };
  },
);

function parseGoogleCalendarEventConfig(
  eventType: GoogleCalendarAutomationEventType,
  eventConfig: unknown,
): GoogleCalendarAutomationEventConfig {
  if (eventType === "google-calendar-event-created") {
    return googleCalendarEventCreatedEventConfigSchema.parse(eventConfig);
  }
  if (eventType === "google-calendar-event-updated") {
    return googleCalendarEventUpdatedEventConfigSchema.parse(eventConfig);
  }
  return googleCalendarEventCancelledEventConfigSchema.parse(eventConfig);
}

function safeParseGoogleCalendarEventConfig(
  eventType: GoogleCalendarAutomationEventType,
  eventConfig: unknown,
): GoogleCalendarAutomationEventConfig | null {
  const result =
    eventType === "google-calendar-event-created"
      ? googleCalendarEventCreatedEventConfigSchema.safeParse(eventConfig)
      : eventType === "google-calendar-event-updated"
        ? googleCalendarEventUpdatedEventConfigSchema.safeParse(eventConfig)
        : googleCalendarEventCancelledEventConfigSchema.safeParse(eventConfig);
  return result.success ? result.data : null;
}
const createGoogleCalendarEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateGoogleCalendarEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const eventConnectorId = await set(
      readGoogleCalendarAutomationConnectorId$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
      },
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Calendar before adding a Google Calendar event automation",
      };
    }
    const parsedConfig = parseGoogleCalendarEventConfig(
      args.input.eventType,
      args.input.eventConfig,
    );
    const calendarId = await set(
      normalizeGoogleCalendarIdForConnector$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        connectorId: eventConnectorId,
        calendarId: parsedConfig.calendarId,
      },
      signal,
    );
    signal.throwIfAborted();
    const preparedConfig = { ...parsedConfig, calendarId };
    const hadConsumer = args.input.enabled
      ? await set(
          hasEnabledGoogleCalendarConsumer$,
          {
            orgId: args.input.orgId,
            userId: args.input.member.userId,
            connectorId: eventConnectorId,
            calendarId: preparedConfig.calendarId,
          },
          signal,
        )
      : false;
    // eslint-disable-next-line api/signal-check-await -- Complete the committed automation handoff and its watch compensation before propagating cancellation.
    const created = await set(insertEventAutomation$, {
      input: { ...args.input, eventConfig: preparedConfig },
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
      expectedEventConnectorId: eventConnectorId,
    });
    const summary = created?.summary ?? null;
    if (summary === null) {
      return {
        kind: "bad-request",
        message:
          "Google Calendar account selection changed; retry adding the automation",
      };
    }
    if (!args.input.enabled) {
      signal.throwIfAborted();
      return { kind: "ok", summary };
    }
    signal.throwIfAborted();
    const watchResult = await onRejection(
      set(
        ensureGoogleCalendarWatchForUser$,
        {
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          connectorId: eventConnectorId,
          calendarId: preparedConfig.calendarId,
          forceRefresh: !hadConsumer,
        },
        signal,
      ),
      async () => {
        await set(deleteFailedEventAutomation$, summary.id);
      },
    );
    signal.throwIfAborted();
    if (watchResult.kind !== "ok") {
      // eslint-disable-next-line api/signal-check-await -- Finish the paired watch cleanup after deleting the local automation.
      await set(deleteFailedEventAutomation$, summary.id);
      await set(
        reconcileAutomationEventWatches$,
        {
          automations: [
            {
              orgId: args.input.orgId,
              ownerUserId: args.input.member.userId,
              eventType: args.input.eventType,
              eventConfig: preparedConfig,
              eventConnectorId,
            },
          ],
        },
        signal,
      );
      return { kind: "bad-request", message: watchResult.message };
    }
    return { kind: "ok", summary };
  },
);

function googleFormsSummaryWithWarning(
  summary: WorkflowAutomationSummary,
  warning: string | undefined,
): WorkflowAutomationSummary {
  if (
    summary.kind !== "event" ||
    summary.eventType !== "google-forms-response-submitted"
  ) {
    throw new Error("Expected Google Forms workflow automation summary");
  }
  return warning === undefined ? summary : { ...summary, warning };
}
const deleteUnpublishedGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly snapshot: WorkflowAutomationSnapshot;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          workflowAutomationSnapshotCondition(args.snapshot),
        ),
      );
  },
);
const cleanFailedGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly snapshot: WorkflowAutomationSnapshot;
      readonly hadConsumer: boolean;
      readonly orgId: string;
      readonly userId: string;
      readonly eventConfig: GoogleFormsResponseSubmittedEventConfig;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(deleteUnpublishedGoogleFormsAutomation$, args);
    signal.throwIfAborted();
    if (!args.hadConsumer) {
      await set(
        reconcileAutomationEventWatches$,
        {
          automations: [
            {
              orgId: args.orgId,
              ownerUserId: args.userId,
              eventType: "google-forms-response-submitted",
              eventConfig: args.eventConfig,
              eventConnectorId: args.eventConfig.connectorId,
            },
          ],
        },
        signal,
      );
    }
  },
);
const missingGoogleFormsUrlResult = {
  kind: "bad-request",
  message: "formUrl is required for Google Forms response automations",
} as const;

const createGoogleFormsEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateGoogleFormsEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    if (!("formUrl" in args.input.eventConfig)) {
      return missingGoogleFormsUrlResult;
    }
    const connectorId = await set(
      readGoogleFormsActivationAccount$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Forms before adding a Google Forms response automation",
      };
    }
    const prepared = await set(
      prepareGoogleFormsResponseEventConfigForPersist$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        connectorId,
        eventConfig: args.input.eventConfig,
      },
      signal,
    );
    signal.throwIfAborted();
    if (prepared.kind !== "ok") {
      return prepared;
    }
    const hadConsumer = args.input.enabled
      ? await set(
          hasEnabledGoogleFormsConsumer$,
          {
            orgId: args.input.orgId,
            userId: args.input.member.userId,
            connectorId: prepared.eventConfig.connectorId,
            formId: prepared.eventConfig.form.id,
          },
          signal,
        )
      : false;
    const inserted = await settle(
      set(insertEventAutomation$, {
        input: { ...args.input, eventConfig: prepared.eventConfig },
        workflowId: args.context.workflowId,
        agentId: args.context.agentId,
        workflowTitle: args.context.workflowTitle,
        threadPreparation: args.context.threadPreparation,
        automationId: args.context.automationId,
        currentTime: nowDate(),
      }),
      signal,
    );
    if (!inserted.ok) {
      if (inserted.error instanceof GoogleFormsAccountSelectionChangedError) {
        return {
          kind: "bad-request",
          message: "Google Forms account selection changed; retry the request",
        };
      }
      throw inserted.error;
    }
    const { summary, snapshot } = requireCreatedEventAutomation(inserted.value);
    const resultSummary = googleFormsSummaryWithWarning(
      summary,
      prepared.warning,
    );
    if (!args.input.enabled) {
      return { kind: "ok", summary: resultSummary };
    }
    const watchResult = await onRejection(
      set(
        ensureGoogleFormsWatchForUser$,
        {
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          formId: prepared.eventConfig.form.id,
          connectorId: prepared.eventConfig.connectorId,
          resetAutomationId: summary.id,
          automationSnapshot: snapshot,
          seedCursor: prepared.seedCursor,
        },
        signal,
      ),
      async () => {
        await set(deleteUnpublishedGoogleFormsAutomation$, {
          automationId: summary.id,
          snapshot,
        });
      },
    );
    signal.throwIfAborted();
    if (watchResult.kind === "ok") {
      return { kind: "ok", summary: resultSummary };
    }
    if (watchResult.kind === "superseded") {
      return { kind: "conflict", message: watchResult.message };
    }
    await set(
      cleanFailedGoogleFormsAutomation$,
      {
        automationId: summary.id,
        snapshot,
        hadConsumer,
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        eventConfig: prepared.eventConfig,
      },
      signal,
    );
    return { kind: "bad-request", message: watchResult.message };
  },
);
const createGoogleMeetEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateGoogleMeetEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const preparedConfig = googleMeetTranscriptGeneratedEventConfigSchema.parse(
      args.input.eventConfig,
    );
    const connectorId = await resolveGoogleMeetAutomationConnectorId(db, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.context.workflowId,
    });
    signal.throwIfAborted();
    if (args.input.enabled && connectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Meet before adding a Google Meet event automation",
      };
    }
    // eslint-disable-next-line api/signal-check-await -- Complete the committed automation handoff and its watch compensation before propagating cancellation.
    const created = await set(insertEventAutomation$, {
      input: { ...args.input, eventConfig: preparedConfig },
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
      ...(args.input.enabled && connectorId !== null
        ? { expectedEventConnectorId: connectorId }
        : {}),
    });
    const summary = created?.summary ?? null;
    if (summary === null) {
      return {
        kind: "bad-request",
        message: "Google Meet account selection changed; retry the request",
      };
    }
    if (!args.input.enabled) {
      return { kind: "ok", summary };
    }
    if (connectorId === null) {
      throw new Error("Enabled Google Meet automation lost account projection");
    }
    const rollback = async (): Promise<void> => {
      const cleanupSignal = new AbortController().signal;
      await set(deleteFailedEventAutomation$, summary.id);
      await set(
        reconcileAutomationEventWatches$,
        {
          automations: [
            {
              orgId: args.input.orgId,
              ownerUserId: args.input.member.userId,
              eventType: args.input.eventType,
              eventConfig: preparedConfig,
              eventConnectorId: connectorId,
            },
          ],
        },
        cleanupSignal,
      );
    };
    // eslint-disable-next-line api/signal-check-await -- Observe provider failure and finish the owned rollback before propagating cancellation.
    const subscriptionResult = await onRejection(
      ensureGoogleMeetTranscriptGeneratedSubscriptionForUser(
        {
          db: db,
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          connectorId,
        },
        signal,
      ),
      rollback,
    );
    if (subscriptionResult.kind !== "ok") {
      await rollback();
      signal.throwIfAborted();
      return { kind: "bad-request", message: subscriptionResult.message };
    }
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);
type NotionEventConfigPreparationResult =
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionAutomationEventConfig;
    }
  | {
      readonly kind: "bad-request";
      readonly message: string;
    };

const createNotionEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateNotionEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const account = await set(
      resolveNotionAutomationAccountForCreation$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
      },
      signal,
    );
    if (account.kind !== "ok") {
      return account;
    }
    const eventConnectorId = account.connectorId;
    const eventConfig = args.input.eventConfig;
    let preparedConfig: NotionEventConfigPreparationResult;
    if (args.input.eventType === "notion-child-page-created") {
      preparedConfig =
        eventConfig.event === "child_page_created"
          ? await set(
              prepareNotionChildPageEventConfigForPersist$,
              {
                orgId: args.input.orgId,
                userId: args.input.member.userId,
                connectorId: eventConnectorId,
                eventConfig:
                  "parentPageUrl" in eventConfig
                    ? eventConfig
                    : {
                        provider: "notion",
                        event: "child_page_created",
                        parentPageUrl:
                          eventConfig.parentPage.rawUrl ??
                          eventConfig.parentPage.url,
                      },
              },
              signal,
            )
          : {
              kind: "bad-request",
              message: "Unsupported Notion automation event config",
            };
    } else if (args.input.eventType === "notion-database-item-created") {
      preparedConfig =
        eventConfig.event === "database_item_created"
          ? await set(
              prepareNotionDatabaseItemEventConfigForPersist$,
              {
                orgId: args.input.orgId,
                userId: args.input.member.userId,
                connectorId: eventConnectorId,
                eventConfig:
                  "databaseUrl" in eventConfig
                    ? eventConfig
                    : {
                        provider: "notion",
                        event: "database_item_created",
                        databaseUrl:
                          eventConfig.dataSource.rawUrl ??
                          eventConfig.dataSource.url,
                      },
              },
              signal,
            )
          : {
              kind: "bad-request",
              message: "Unsupported Notion automation event config",
            };
    } else {
      preparedConfig =
        eventConfig.event === "page_content_updated"
          ? await set(
              prepareNotionPageContentUpdatedEventConfigForPersist$,
              {
                orgId: args.input.orgId,
                userId: args.input.member.userId,
                connectorId: eventConnectorId,
                eventConfig:
                  "scope" in eventConfig
                    ? eventConfig.scope.type === "page"
                      ? {
                          provider: "notion",
                          event: "page_content_updated",
                          pageUrl:
                            eventConfig.scope.page.rawUrl ??
                            eventConfig.scope.page.url,
                        }
                      : {
                          provider: "notion",
                          event: "page_content_updated",
                          databaseUrl:
                            eventConfig.scope.dataSource.rawUrl ??
                            eventConfig.scope.dataSource.url,
                        }
                    : eventConfig,
              },
              signal,
            )
          : {
              kind: "bad-request",
              message: "Unsupported Notion automation event config",
            };
    }
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }

    return await set(
      persistCreatedNotionAutomation$,
      {
        ...args,
        eventConfig: preparedConfig.eventConfig,
        eventConnectorId,
      },
      signal,
    );
  },
);
const resolveNotionAutomationAccountForCreation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly connectorId: string;
      }
    | AutomationActionFailure
  > => {
    const connectorId = await set(
      readEventAutomationConnectorId$,
      { ...args, connectorSlug: "notion" },
      signal,
    );
    signal.throwIfAborted();
    return connectorId === null
      ? {
          kind: "bad-request",
          message: "Connect Notion before adding a Notion event automation",
        }
      : { kind: "ok", connectorId };
  },
);

const persistCreatedNotionAutomation$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateNotionEventAutomationInput;
      readonly eventConfig: NotionAutomationEventConfig;
      readonly eventConnectorId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const created = await set(insertEventAutomation$, {
      input: { ...args.input, eventConfig: args.eventConfig },
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
      expectedEventConnectorId: args.eventConnectorId,
    });
    signal.throwIfAborted();
    const summary = created?.summary ?? null;
    return summary === null
      ? {
          kind: "bad-request",
          message:
            "Notion account selection changed; retry adding the automation",
        }
      : { kind: "ok", summary };
  },
);

const createStripeInvoicePaidEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateStripeInvoicePaidEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const result = await db.transaction(async (tx) => {
      await lockConnectorAccountTarget(tx, {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        target: { kind: "builtin", connectorSlug: "stripe" },
      });
      const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
        agentId: args.context.agentId,
        workflowTitle: args.context.workflowTitle,
        preparation: args.context.threadPreparation,
        currentTime,
      });
      const readiness = await resolveStripeInvoicePaidAutomationBinding(
        {
          db: tx,
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          workflowId: args.context.workflowId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (readiness.kind === "bad_request") {
        return { kind: "bad-request" as const, message: readiness.message };
      }
      const eventConfig = stripeInvoicePaidEventConfigSchema.parse({
        ...args.input.eventConfig,
        ...readiness.binding,
      });
      const row = await insertWorkflowAutomation(tx, {
        id: args.context.automationId,
        orgId: args.input.orgId,
        workflowId: args.context.workflowId,
        ownerUserId: args.input.member.userId,
        kind: "event",
        eventType: args.input.eventType,
        eventConfig,
        eventConnectorId: readiness.binding.connectorId,
        scheduleType: null,
        cronExpression: null,
        intervalSeconds: null,
        atTime: null,
        timezone: "UTC",
        enabled: args.input.enabled,
        nextRunAt: null,
        ...(args.input.autonomyBudget === undefined
          ? {}
          : { autonomyBudget: args.input.autonomyBudget }),
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      if (!row) {
        throw new Error("Failed to create Stripe workflow automation");
      }
      return {
        kind: "ok" as const,
        summary: await rowToSummary(tx, row, { chatThreadId }),
      };
    });
    signal.throwIfAborted();
    return result;
  },
);

const createStripeInvoicePaidEventAutomation$ = command(
  async (
    { get, set },
    args: {
      readonly context: CreateEventAutomationWorkflowContext;
      readonly input: CreateStripeInvoicePaidEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const featureEnabled = await get(
      stripeInvoicePaidWorkflowAutomationEnabledForOwner(
        args.input.orgId,
        args.input.member.userId,
      ),
    );
    signal.throwIfAborted();
    if (!featureEnabled) {
      return stripeInvoicePaidWorkflowAutomationsDisabledResult();
    }
    return await set(
      createStripeInvoicePaidEventAutomationForWorkflow$,
      {
        ...args,
      },
      signal,
    );
  },
);
const createChatRunFinishedEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly context: {
        readonly threadPreparation: WorkflowThreadPreparation;
        readonly workflowId: string;
        readonly agentId: string;
        readonly workflowTitle: string;
        readonly automationId?: string;
      };
      readonly input: CreateChatRunFinishedEventAutomationInput;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    // The watched thread must belong to the automation owner: the run's final
    // output is surfaced to the workflow run, so cross-user watching would leak
    // another user's conversation.
    const [thread] = await db
      .select({ userId: chatThreads.userId })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.input.eventConfig.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!thread || thread.userId !== args.input.member.userId) {
      return {
        kind: "bad-request",
        message: `Chat thread not found: ${args.input.eventConfig.chatThreadId}`,
      };
    }
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        workflowUserAutomationThreadOwnerCondition({
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          workflowId: args.context.workflowId,
        }),
      )
      .limit(1);
    signal.throwIfAborted();
    const automationThreadId = binding?.chatThreadId ?? null;
    if (automationThreadId === args.input.eventConfig.chatThreadId) {
      return {
        kind: "bad-request",
        message:
          "A workflow cannot watch run-finished events from its own chat thread",
      };
    }
    const created = await set(insertEventAutomation$, {
      input: args.input,
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      threadPreparation: args.context.threadPreparation,
      automationId: args.context.automationId,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    const { summary } = requireCreatedEventAutomation(created);
    return { kind: "ok", summary };
  },
);
const createEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly input: CreateEventAutomationInput;
      readonly workflowId: string;
      readonly agentId: string;
      readonly workflowTitle: string;
      readonly automationId?: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const { input } = args;
    const threadPreparation = await set(
      prepareWorkflowUserAutomationThread$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: args.workflowId,
        workflowTitle: args.workflowTitle,
      },
      signal,
    );
    const context = { ...args, threadPreparation };
    if (automationCreateInputIsChatRunFinished(input)) {
      return await set(
        createChatRunFinishedEventAutomationForWorkflow$,
        {
          context,
          input,
        },
        signal,
      );
    }
    if (input.eventType === "webhook-received") {
      const createArgs = { context, input };
      return await set(
        createWebhookEventAutomationForWorkflow$,
        createArgs,
        signal,
      );
    }
    if (input.eventType === "github-workflow-run-completed") {
      const createArgs = { context, input };
      return await set(
        createGithubWorkflowRunEventAutomationForWorkflow$,
        createArgs,
        signal,
      );
    }
    if (automationCreateInputIsGithubWebhook(input)) {
      return await set(
        createGithubWebhookEventAutomationForWorkflow$,
        {
          context,
          input,
        },
        signal,
      );
    }
    if (automationCreateInputIsGoogleCalendar(input)) {
      const createArgs = { context, input };
      return await set(
        createGoogleCalendarEventAutomationForWorkflow$,
        {
          context,
          input: createArgs.input,
        },
        signal,
      );
    }
    if (automationCreateInputIsGoogleForms(input)) {
      return await set(
        createGoogleFormsEventAutomationForWorkflow$,
        {
          context,
          input,
        },
        signal,
      );
    }
    if (automationCreateInputIsGoogleMeet(input)) {
      const createArgs = { context, input };
      return await set(
        createGoogleMeetEventAutomationForWorkflow$,
        {
          context,
          input: createArgs.input,
        },
        signal,
      );
    }
    if (automationCreateInputIsNotion(input)) {
      return await set(
        createNotionEventAutomationForWorkflow$,
        {
          context,
          input,
        },
        signal,
      );
    }
    if (automationCreateInputIsStripeInvoicePaid(input)) {
      const result = await set(
        createStripeInvoicePaidEventAutomation$,
        { context, input },
        signal,
      );
      signal.throwIfAborted();
      return result;
    }
    if (automationCreateInputIsGmail(input)) {
      return await set(
        createGmailEventAutomationForWorkflow$,
        {
          context,
          input,
        },
        signal,
      );
    }
    return {
      kind: "bad-request",
      message: "Unsupported event automation type",
    };
  },
);

function plainOfficialAutomationWhere(automationId: string) {
  return and(
    eq(workflowAutomations.id, automationId),
    isNull(workflowAutomations.officialBlueprintKey),
    isNull(workflowAutomations.officialAppliedFingerprint),
    isNull(workflowAutomations.officialReconciliationStatus),
    isNull(workflowAutomations.officialParameterBindings),
    isNull(workflowAutomations.officialIntendedEnabled),
    isNull(workflowAutomations.officialResultEmailEnabled),
  );
}

function officialAutomationMetadataValues(
  metadata: OfficialAutomationCreationMetadata,
  at: Date,
) {
  return {
    officialBlueprintKey: metadata.blueprintKey,
    officialAppliedFingerprint: metadata.appliedFingerprint,
    officialReconciliationStatus:
      metadata.stagedMaterialization === true
        ? ("reconciling" as const)
        : ("current" as const),
    officialParameterBindings: [...metadata.parameterBindings],
    officialIntendedEnabled: metadata.intendedEnabled ?? true,
    officialResultEmailEnabled: metadata.resultEmailEnabled,
    updatedAt: at,
  };
}

function activeOfficialAutomationIdentityValues(
  automation: AutomationRow,
  metadata: OfficialAutomationCreationMetadata,
  at: Date,
) {
  return {
    id: automation.id,
    workflowId: automation.workflowId,
    automationId: automation.id,
    blueprintKey: metadata.blueprintKey,
    state: "active" as const,
    retainedParameterBindings: null,
    retainedIntendedEnabled: null,
    retainedAppliedFingerprint: null,
    createdAt: at,
    updatedAt: at,
  };
}

const persistOfficialAutomationMetadata$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly metadata: OfficialAutomationCreationMetadata;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { automationId, metadata } = args;
    const result = await db.transaction(async (tx) => {
      const [plain] = await tx
        .select()
        .from(workflowAutomations)
        .where(plainOfficialAutomationWhere(automationId))
        .for("update")
        .limit(1);
      if (!plain) {
        throw new Error("Failed to lock new Official Workflow automation");
      }
      if (metadata.stagedMaterialization === true) {
        if (
          metadata.automationId === undefined ||
          metadata.automationId !== automationId ||
          plain.enabled
        ) {
          throw new Error("Official materialization identity is incomplete");
        }
        const [reservation] = await tx
          .select({
            retainedAppliedFingerprint:
              officialWorkflowAutomationIdentities.retainedAppliedFingerprint,
            retainedParameterBindings:
              officialWorkflowAutomationIdentities.retainedParameterBindings,
            retainedIntendedEnabled:
              officialWorkflowAutomationIdentities.retainedIntendedEnabled,
          })
          .from(officialWorkflowAutomationIdentities)
          .where(
            and(
              eq(
                officialWorkflowAutomationIdentities.id,
                metadata.automationId,
              ),
              eq(
                officialWorkflowAutomationIdentities.blueprintKey,
                metadata.blueprintKey,
              ),
              eq(
                officialWorkflowAutomationIdentities.workflowId,
                plain.workflowId,
              ),
              eq(officialWorkflowAutomationIdentities.state, "reconciling"),
              isNull(officialWorkflowAutomationIdentities.automationId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          reservation?.retainedAppliedFingerprint !==
            metadata.appliedFingerprint ||
          !isDeepStrictEqual(
            reservation.retainedParameterBindings,
            metadata.parameterBindings,
          ) ||
          reservation.retainedIntendedEnabled !==
            (metadata.intendedEnabled ?? true)
        ) {
          return { kind: "reservation-lost" as const };
        }
      }
      const at = nowDate();
      const [updated] = await tx
        .update(workflowAutomations)
        .set(officialAutomationMetadataValues(metadata, at))
        .where(
          and(
            plainOfficialAutomationWhere(automationId),
            eq(workflowAutomations.updatedAt, plain.updatedAt),
          ),
        )
        .returning(workflowAutomationColumns());
      if (!updated) {
        throw new Error("Failed to mark Official Workflow automation");
      }
      if (metadata.stagedMaterialization !== true) {
        await tx
          .insert(officialWorkflowAutomationIdentities)
          .values(activeOfficialAutomationIdentityValues(updated, metadata, at))
          .onConflictDoUpdate({
            target: [
              officialWorkflowAutomationIdentities.workflowId,
              officialWorkflowAutomationIdentities.blueprintKey,
            ],
            set: {
              automationId: updated.id,
              state: "active",
              retainedParameterBindings: null,
              retainedIntendedEnabled: null,
              retainedAppliedFingerprint: null,
              updatedAt: at,
            },
          });
      }
      return { kind: "attached" as const, row: updated };
    });
    signal.throwIfAborted();
    return result;
  },
);

const loadCommittedAutomationSummary$ = command(
  async (
    { set },
    args: { readonly row: AutomationRow; readonly chatThreadId: string | null },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const db = set(writeDb$);
    const { row, chatThreadId } = args;
    if (row.kind === "event") {
      if (row.eventType === "stripe-invoice-paid") {
        const [health] = await db
          .select({
            lastMatchingEventReceivedAt:
              stripeWorkflowAutomationHealth.lastMatchingEventReceivedAt,
            lastDeliveryStatus:
              stripeWorkflowAutomationHealth.latestDeliveryStatus,
            lastDeliveryStatusAt:
              stripeWorkflowAutomationHealth.latestDeliveryStatusAt,
          })
          .from(stripeWorkflowAutomationHealth)
          .where(eq(stripeWorkflowAutomationHealth.automationId, row.id))
          .limit(1);
        signal.throwIfAborted();
        return stripeInvoicePaidRowToSummary(
          row,
          chatThreadId,
          stripeAutomationHealthSummary(health),
        );
      }
      if (row.eventType === "webhook-received") {
        const [webhook] = await db
          .select()
          .from(workflowWebhookAutomations)
          .where(eq(workflowWebhookAutomations.automationId, row.id))
          .limit(1);
        signal.throwIfAborted();
        if (!webhook) {
          throw new Error(
            `Workflow webhook automation config missing: ${row.id}`,
          );
        }
        return {
          ...rowSummaryBase(row, chatThreadId),
          kind: "event",
          eventType: "webhook-received",
          eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
          schedule: null,
          scheduleSummary: null,
          ...workflowWebhookSummaryFields(webhook, {}),
        };
      }
      let warning: GoogleCalendarWatchActionRequiredReason | undefined;
      const calendarId = googleCalendarIdFromAutomationRow(row);
      if (calendarId !== null && row.eventConnectorId !== null) {
        const [state] = await db
          .select({
            reason: googleCalendarWatchStates.actionRequiredReason,
            startedAt: googleCalendarWatchStates.actionRequiredAt,
          })
          .from(googleCalendarWatchStates)
          .where(
            and(
              eq(googleCalendarWatchStates.orgId, row.orgId),
              eq(googleCalendarWatchStates.userId, row.ownerUserId),
              eq(googleCalendarWatchStates.connectorId, row.eventConnectorId),
              eq(googleCalendarWatchStates.calendarId, calendarId),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        warning = googleCalendarWarningFromState(state);
      }
      const summary = eventRowToSummary(row, chatThreadId, {
        googleCalendar: warning,
      });
      if (summary) {
        return summary;
      }
    }
    const schedule = rowToSchedule(row);
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "schedule",
      schedule,
      scheduleSummary: summarizeSchedule(schedule),
    };
  },
);

const attachOfficialAutomationMetadata$ = command(
  async (
    { set },
    args: {
      readonly result: AutomationResult;
      readonly metadata: OfficialAutomationCreationMetadata | undefined;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const { result, metadata } = args;
    if (result.kind !== "ok" || metadata === undefined) {
      return result;
    }
    const attached = await set(
      persistOfficialAutomationMetadata$,
      { automationId: result.summary.id, metadata },
      signal,
    );
    if (attached.kind === "reservation-lost") {
      const db = set(writeDb$);
      await db
        .delete(workflowAutomations)
        .where(
          and(
            plainOfficialAutomationWhere(result.summary.id),
            eq(workflowAutomations.enabled, false),
          ),
        );
      signal.throwIfAborted();
      return {
        kind: "conflict",
        message: "Official Workflow reconciliation was superseded",
      };
    }
    const summary = await set(
      loadCommittedAutomationSummary$,
      {
        row: attached.row,
        chatThreadId: result.summary.chatThreadId,
      },
      signal,
    );
    return { kind: "ok", summary };
  },
);
export const createWorkflowAutomation$ = command(
  async (
    { set },
    args: CreateAutomationInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: args.orgId,
      member: args.member,
      workflowId: args.workflowId,
      includeInstallingOfficial: args.officialInstallation !== undefined,
    });
    signal.throwIfAborted();
    if (!visible) {
      return { kind: "not-found" };
    }
    const { workflow } = visible;
    if (
      args.officialInstallation !== undefined &&
      (workflow.officialDefinitionName !==
        args.officialInstallation.definitionName ||
        workflow.officialInstallationState !==
          (args.officialInstallation.installationState ?? "installing") ||
        workflow.ownerUserId !== args.member.userId)
    ) {
      return { kind: "not-found" };
    }
    if (
      workflow.officialDefinitionName !== null &&
      args.officialInstallation === undefined
    ) {
      return {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
      };
    }
    // The owning agent is derived from the workflow row (hard 1:N). The automation
    // owner must be able to run that agent for the scheduled run to fire.
    const agent = await loadAgent(writeDb, {
      orgId: args.orgId,
      agentId: workflow.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "bad-request",
        message: `Agent not found: ${workflow.agentId}`,
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }
    const workflowTitle = workflow.displayName ?? workflow.name;
    if (!automationCreateInputIsSchedule(args)) {
      const created = await set(
        createEventAutomationForWorkflow$,
        {
          input: args,
          workflowId: workflow.id,
          agentId: agent.id,
          workflowTitle,
          automationId: args.officialInstallation?.automationId,
        },
        signal,
      );
      signal.throwIfAborted();
      const result = await set(
        attachOfficialAutomationMetadata$,
        {
          result: created,
          metadata: args.officialInstallation,
        },
        signal,
      );
      if (result.kind === "ok") {
        await publishThreadBoundWorkflowAutomationChanged(
          result.summary.ownerUserId,
          result.summary.chatThreadId,
        );
        signal.throwIfAborted();
      }
      return result;
    }
    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }
    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(args.schedule, args.enabled, now);
    const summary = await set(
      insertScheduleAutomation$,
      {
        input: args,
        workflowId: workflow.id,
        automationId: args.officialInstallation?.automationId,
        columns: cols,
        nextRunAt,
        currentTime: now,
      },
      signal,
    );
    signal.throwIfAborted();
    const attached = await set(
      attachOfficialAutomationMetadata$,
      {
        result: { kind: "ok", summary },
        metadata: args.officialInstallation,
      },
      signal,
    );
    if (attached.kind !== "ok") {
      throw new Error("Failed to create Official Workflow automation");
    }
    await publishThreadBoundWorkflowAutomationChanged(
      attached.summary.ownerUserId,
      attached.summary.chatThreadId,
    );
    signal.throwIfAborted();
    return attached;
  },
);

export interface OfficialAutomationEventPreparation {
  readonly eventConfig: WorkflowAutomationEventConfig;
  readonly eventConnectorId?: string;
  readonly googleFormsSeedCursor?: string;
  readonly webhookCredentials?: PreparedWebhookCredentials;
}

type OfficialAutomationSubtypeTransitionAutomation = Pick<
  AutomationRow,
  "id" | "orgId" | "ownerUserId" | "eventType" | "enabled"
>;

/**
 * Brings durable provider-specific rows into line with a structurally new
 * Official Automation configuration. The caller owns the surrounding
 * catalog/workflow/Automation locks and transaction.
 */
export async function syncOfficialAutomationSubtypeRows(
  db: Db,
  args: {
    readonly current: OfficialAutomationSubtypeTransitionAutomation;
    readonly preparation: OfficialAutomationEventPreparation | undefined;
    readonly webhookTierEligible: boolean;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<AutomationActionFailure | null> {
  const [webhook] = await db
    .select({ automationId: workflowWebhookAutomations.automationId })
    .from(workflowWebhookAutomations)
    .where(eq(workflowWebhookAutomations.automationId, args.current.id))
    .limit(1);
  signal.throwIfAborted();
  if (args.current.eventType === "webhook-received") {
    if (!args.webhookTierEligible) {
      return workflowWebhookTeamRequiredResult();
    }
    if (!webhook) {
      const credentials = args.preparation?.webhookCredentials;
      if (!credentials) {
        throw new Error("Missing prepared Official webhook credentials");
      }
      await db.insert(workflowWebhookAutomations).values({
        automationId: args.current.id,
        ...credentials,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      });
    } else {
      await db
        .update(workflowWebhookAutomations)
        .set({ disabledReason: null, updatedAt: args.currentTime })
        .where(eq(workflowWebhookAutomations.automationId, args.current.id));
    }
  } else if (webhook) {
    await db
      .delete(workflowWebhookAutomations)
      .where(eq(workflowWebhookAutomations.automationId, args.current.id));
  }

  signal.throwIfAborted();
  return null;
}

export type OfficialAutomationEventPreparationResult =
  | {
      readonly kind: "ok";
      readonly preparation: OfficialAutomationEventPreparation;
    }
  | AutomationActionFailure;

interface PrepareOfficialAutomationReconfigurationInput {
  readonly automationId: string;
  readonly input: CreateAutomationInput;
}

function preparedOfficialEvent(
  eventConfig: WorkflowAutomationEventConfig,
  extra?: Omit<OfficialAutomationEventPreparation, "eventConfig">,
): OfficialAutomationEventPreparationResult {
  return {
    kind: "ok",
    preparation: { eventConfig, ...extra },
  };
}

async function prepareOfficialChatRunFinishedEvent(
  db: Db,
  input: CreateChatRunFinishedEventAutomationInput,
  signal: AbortSignal,
): Promise<OfficialAutomationEventPreparationResult> {
  const [thread] = await db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, input.eventConfig.chatThreadId))
    .limit(1);
  signal.throwIfAborted();
  if (!thread || thread.userId !== input.member.userId) {
    return {
      kind: "bad-request",
      message: `Chat thread not found: ${input.eventConfig.chatThreadId}`,
    };
  }
  const automationThreadId = await loadWorkflowUserAutomationThreadId(db, {
    orgId: input.orgId,
    userId: input.member.userId,
    workflowId: input.workflowId,
  });
  signal.throwIfAborted();
  if (automationThreadId === input.eventConfig.chatThreadId) {
    return {
      kind: "bad-request",
      message:
        "A workflow cannot watch run-finished events from its own chat thread",
    };
  }
  return preparedOfficialEvent(input.eventConfig);
}

const prepareOfficialNotionEvent$ = command(
  async (
    { set },
    input: CreateNotionEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const eventConnectorId = await set(
      readEventAutomationConnectorId$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: input.workflowId,
        connectorSlug: "notion",
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message: "Connect Notion before adding a Notion event automation",
      };
    }
    const config = input.eventConfig;
    if (input.eventType === "notion-child-page-created") {
      if (config.event !== "child_page_created") {
        return {
          kind: "bad-request",
          message: "Unsupported Notion automation event config",
        };
      }
      const prepared = await set(
        prepareNotionChildPageEventConfigForPersist$,
        {
          orgId: input.orgId,
          userId: input.member.userId,
          connectorId: eventConnectorId,
          eventConfig:
            "parentPageUrl" in config
              ? config
              : {
                  provider: "notion",
                  event: "child_page_created",
                  parentPageUrl:
                    config.parentPage.rawUrl ?? config.parentPage.url,
                },
        },
        signal,
      );
      return prepared.kind === "ok"
        ? preparedOfficialEvent(prepared.eventConfig, { eventConnectorId })
        : prepared;
    }
    if (input.eventType === "notion-database-item-created") {
      if (config.event !== "database_item_created") {
        return {
          kind: "bad-request",
          message: "Unsupported Notion automation event config",
        };
      }
      const prepared = await set(
        prepareNotionDatabaseItemEventConfigForPersist$,
        {
          orgId: input.orgId,
          userId: input.member.userId,
          connectorId: eventConnectorId,
          eventConfig:
            "databaseUrl" in config
              ? config
              : {
                  provider: "notion",
                  event: "database_item_created",
                  databaseUrl:
                    config.dataSource.rawUrl ?? config.dataSource.url,
                },
        },
        signal,
      );
      return prepared.kind === "ok"
        ? preparedOfficialEvent(prepared.eventConfig, { eventConnectorId })
        : prepared;
    }
    if (config.event !== "page_content_updated") {
      return {
        kind: "bad-request",
        message: "Unsupported Notion automation event config",
      };
    }
    const eventConfig =
      "scope" in config
        ? config.scope.type === "page"
          ? {
              provider: "notion" as const,
              event: "page_content_updated" as const,
              pageUrl: config.scope.page.rawUrl ?? config.scope.page.url,
            }
          : {
              provider: "notion" as const,
              event: "page_content_updated" as const,
              databaseUrl:
                config.scope.dataSource.rawUrl ?? config.scope.dataSource.url,
            }
        : config;
    const prepared = await set(
      prepareNotionPageContentUpdatedEventConfigForPersist$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        connectorId: eventConnectorId,
        eventConfig,
      },
      signal,
    );
    return prepared.kind === "ok"
      ? preparedOfficialEvent(prepared.eventConfig, { eventConnectorId })
      : prepared;
  },
);

const prepareOfficialGmailEvent$ = command(
  async (
    { set },
    input: CreateGmailEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const eventConnectorId = await set(
      readGmailAutomationConnectorId$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: input.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message: "Connect Gmail before adding a Gmail event automation",
      };
    }
    const prepared = await set(
      prepareGmailEventConfigForPersist$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        connectorId: eventConnectorId,
        eventType: input.eventType,
        eventConfig: input.eventConfig,
      },
      signal,
    );
    return prepared.kind === "ok"
      ? preparedOfficialEvent(prepared.eventConfig, { eventConnectorId })
      : prepared;
  },
);
const prepareOfficialGoogleCalendarEvent$ = command(
  async (
    { set },
    input: CreateGoogleCalendarEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const eventConnectorId = await set(
      readGoogleCalendarAutomationConnectorId$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: input.workflowId,
      },
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Calendar before adding a Google Calendar event automation",
      };
    }
    const parsedConfig = parseGoogleCalendarEventConfig(
      input.eventType,
      input.eventConfig,
    );
    const calendarId = await set(
      normalizeGoogleCalendarIdForConnector$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        connectorId: eventConnectorId,
        calendarId: parsedConfig.calendarId,
      },
      signal,
    );
    signal.throwIfAborted();
    return preparedOfficialEvent(
      { ...parsedConfig, calendarId },
      { eventConnectorId },
    );
  },
);
async function prepareOfficialGithubEvent(
  db: Db,
  input: CreateGithubEventAutomationInput,
  signal: AbortSignal,
): Promise<OfficialAutomationEventPreparationResult> {
  const prepared = await prepareGithubAutomationEventConfig(db, {
    orgId: input.orgId,
    eventType: input.eventType,
    eventConfig: input.eventConfig,
  });
  signal.throwIfAborted();
  return prepared.kind === "ok"
    ? preparedOfficialEvent(prepared.eventConfig)
    : prepared;
}

const prepareOfficialGoogleFormsEvent$ = command(
  async (
    { set },
    input: CreateGoogleFormsEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    if (!("formUrl" in input.eventConfig)) {
      return missingGoogleFormsUrlResult;
    }
    const connectorId = await set(
      readGoogleFormsActivationAccount$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: input.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Forms before using Google Forms response automations",
      };
    }
    const prepared = await set(
      prepareGoogleFormsResponseEventConfigForPersist$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        connectorId,
        eventConfig: input.eventConfig,
      },
      signal,
    );
    signal.throwIfAborted();
    return prepared.kind === "ok"
      ? preparedOfficialEvent(prepared.eventConfig, {
          eventConnectorId: connectorId,
          googleFormsSeedCursor: prepared.seedCursor,
        })
      : prepared;
  },
);

async function prepareOfficialGoogleMeetEvent(
  db: Db,
  input: CreateGoogleMeetEventAutomationInput,
  signal: AbortSignal,
): Promise<OfficialAutomationEventPreparationResult> {
  const eventConnectorId = await resolveGoogleMeetAutomationConnectorId(db, {
    orgId: input.orgId,
    userId: input.member.userId,
    workflowId: input.workflowId,
  });
  signal.throwIfAborted();
  if (eventConnectorId === null) {
    return {
      kind: "bad-request",
      message: "Connect Google Meet before using Google Meet event automations",
    };
  }
  const eventConfig = googleMeetTranscriptGeneratedEventConfigSchema.parse(
    input.eventConfig,
  );
  return preparedOfficialEvent(eventConfig, { eventConnectorId });
}

async function prepareOfficialStripeEvent(
  db: Db,
  input: CreateStripeInvoicePaidEventAutomationInput,
  signal: AbortSignal,
): Promise<OfficialAutomationEventPreparationResult> {
  const readiness = await resolveStripeInvoicePaidAutomationBinding(
    {
      db,
      orgId: input.orgId,
      userId: input.member.userId,
      workflowId: input.workflowId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (readiness.kind === "bad_request") {
    return { kind: "bad-request", message: readiness.message };
  }
  return preparedOfficialEvent(
    stripeInvoicePaidEventConfigSchema.parse({
      ...input.eventConfig,
      ...readiness.binding,
    }),
    { eventConnectorId: readiness.binding.connectorId },
  );
}

export const prepareOfficialAutomationReconfiguration$ = command(
  async (
    { get, set },
    args: PrepareOfficialAutomationReconfigurationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const db = set(writeDb$);
    const owned = await loadOwnedAutomation(db, {
      orgId: args.input.orgId,
      member: args.input.member,
      automationId: args.automationId,
    });
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const input = args.input;
    const automation = owned.automation;
    if (
      automationCreateInputIsSchedule(input) ||
      automation.officialBlueprintKey === null ||
      automation.workflowId !== input.workflowId
    ) {
      return {
        kind: "conflict",
        message: "Official Workflow Blueprint structure changed",
      };
    }
    if (automationCreateInputIsChatRunFinished(input)) {
      return await prepareOfficialChatRunFinishedEvent(db, input, signal);
    }
    if (automationCreateInputIsGmail(input)) {
      return await set(prepareOfficialGmailEvent$, input, signal);
    }
    if (automationCreateInputIsGithub(input)) {
      return await prepareOfficialGithubEvent(db, input, signal);
    }
    if (automationCreateInputIsGoogleCalendar(input)) {
      return await set(prepareOfficialGoogleCalendarEvent$, input, signal);
    }
    if (automationCreateInputIsGoogleForms(input)) {
      return await set(prepareOfficialGoogleFormsEvent$, input, signal);
    }
    if (automationCreateInputIsGoogleMeet(input)) {
      return await prepareOfficialGoogleMeetEvent(db, input, signal);
    }
    if (automationCreateInputIsNotion(input)) {
      return await set(prepareOfficialNotionEvent$, input, signal);
    }
    if (automationCreateInputIsStripeInvoicePaid(input)) {
      const enabled = await get(
        stripeInvoicePaidWorkflowAutomationEnabledForOwner(
          input.orgId,
          input.member.userId,
        ),
      );
      signal.throwIfAborted();
      return enabled
        ? await prepareOfficialStripeEvent(db, input, signal)
        : stripeInvoicePaidWorkflowAutomationsDisabledResult();
    }
    if (input.eventType === "webhook-received") {
      const [webhook] = await db
        .select({ automationId: workflowWebhookAutomations.automationId })
        .from(workflowWebhookAutomations)
        .where(eq(workflowWebhookAutomations.automationId, automation.id))
        .limit(1);
      signal.throwIfAborted();
      // Finalization keeps its existing catalog, entitlement, identity, and
      // updatedAt guards. It only consumes prepared ciphertext under locks.
      const credentials = webhook
        ? undefined
        : await prepareWebhookCredentials(
            { orgId: input.orgId, userId: input.member.userId },
            signal,
          );
      signal.throwIfAborted();
      return preparedOfficialEvent(
        input.eventConfig ?? defaultWebhookReceivedEventConfig(),
        credentials ? { webhookCredentials: credentials.row } : undefined,
      );
    }
    return { kind: "not-found" };
  },
);

interface OwnedAutomation {
  readonly automation: AutomationRow;
}

async function publishThreadBoundWorkflowAutomationChanged(
  userId: string,
  chatThreadId: string | null,
): Promise<void> {
  if (chatThreadId === null) {
    return;
  }
  await publishChatThreadAutomationsChangedSafely(userId, chatThreadId);
}

async function loadOwnedAutomation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<OwnedAutomation | AutomationActionFailure> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (!automation) {
    return { kind: "not-found" };
  }
  if (
    automation.kind === "event" &&
    !supportedAutomationEventType(automation.eventType)
  ) {
    return { kind: "not-found" };
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return { kind: "not-found" };
  }
  if (automation.ownerUserId !== args.member.userId) {
    return {
      kind: "forbidden",
      message: "Only the automation owner can manage this automation",
    };
  }
  return { automation };
}

interface UpdateAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automationId: string;
  readonly schedule?: WorkflowSchedule;
  readonly eventConfig?:
    | GmailAutomationEventConfig
    | GithubAutomationEventConfig
    | GoogleCalendarAutomationEventConfig;
}

async function updateAutomationEventConfig(
  db: Db,
  args: {
    readonly automationId: string;
    readonly eventConfig:
      | GmailAutomationEventConfig
      | GithubAutomationEventConfig
      | GoogleCalendarAutomationEventConfig;
    readonly eventConnectorId?: string;
  },
  signal: AbortSignal,
): Promise<WorkflowAutomationSummary> {
  const [row] = await db
    .update(workflowAutomations)
    .set({
      eventConfig: args.eventConfig,
      ...(args.eventConnectorId === undefined
        ? {}
        : { eventConnectorId: args.eventConnectorId }),
      updatedAt: nowDate(),
    })
    .where(eq(workflowAutomations.id, args.automationId))
    .returning(workflowAutomationColumns());
  signal.throwIfAborted();
  if (!row) {
    throw new Error("Failed to update workflow automation");
  }
  return await rowToSummary(db, row);
}

function parseGithubAutomationEventConfig(
  eventType: GithubAutomationEventType,
  eventConfig: unknown,
): GithubAutomationEventConfig | null {
  const result =
    eventType === "github-pull-request"
      ? githubPullRequestEventConfigSchema.safeParse(eventConfig)
      : eventType === "github-workflow-run-completed"
        ? githubWorkflowRunCompletedEventConfigSchema.safeParse(eventConfig)
        : eventType === "github-workflow-job-completed"
          ? githubWorkflowJobCompletedEventConfigSchema.safeParse(eventConfig)
          : eventType === "github-pull-request-review-submitted"
            ? githubPullRequestReviewSubmittedEventConfigSchema.safeParse(
                eventConfig,
              )
            : eventType === "github-deployment-status-created"
              ? githubDeploymentStatusCreatedEventConfigSchema.safeParse(
                  eventConfig,
                )
              : githubIssueCommentCreatedEventConfigSchema.safeParse(
                  eventConfig,
                );
  return result.success ? result.data : null;
}

async function prepareGithubAutomationEventConfig(
  db: Db,
  args: {
    readonly orgId: string;
    readonly eventType: GithubAutomationEventType;
    readonly eventConfig: unknown;
  },
) {
  const parsed = parseGithubAutomationEventConfig(
    args.eventType,
    args.eventConfig,
  );
  if (!parsed) {
    return {
      kind: "bad-request" as const,
      message: "eventConfig must match the GitHub automation type",
    };
  }
  if (args.eventType === "github-workflow-run-completed") {
    return await prepareGithubWorkflowRunEventConfigForPersist(db, {
      orgId: args.orgId,
      eventConfig: githubWorkflowRunCompletedEventConfigSchema.parse(parsed),
    });
  }

  const eventConfig =
    args.eventType === "github-pull-request"
      ? githubPullRequestEventConfigSchema.parse(parsed)
      : args.eventType === "github-workflow-job-completed"
        ? githubWorkflowJobCompletedEventConfigSchema.parse(parsed)
        : args.eventType === "github-pull-request-review-submitted"
          ? githubPullRequestReviewSubmittedEventConfigSchema.parse(parsed)
          : args.eventType === "github-deployment-status-created"
            ? githubDeploymentStatusCreatedEventConfigSchema.parse(parsed)
            : githubIssueCommentCreatedEventConfigSchema.parse(parsed);
  return await prepareGithubWebhookEventConfigForPersist(db, {
    orgId: args.orgId,
    eventType: args.eventType,
    eventConfig,
  });
}
const persistGmailEventConfiguration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly automationId: string;
      readonly connectorId: string;
      readonly eventConfig: GmailAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary | null> => {
    const db = set(writeDb$);
    const row = await db.transaction(async (tx) => {
      await tx.execute(
        builtinConnectorStateLockStatement({ ...args, connectorSlug: "gmail" }),
      );
      const [updated] = await tx
        .update(workflowAutomations)
        .set({
          eventConfig: args.eventConfig,
          eventConnectorId: args.connectorId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(workflowAutomations.id, args.automationId),
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.ownerUserId, args.userId),
            gmailSelectedAccountCondition(args),
          ),
        )
        .returning(workflowAutomationColumns());
      signal.throwIfAborted();
      return updated ?? null;
    });
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, args.orgId),
          eq(workflowUserAutomationThreads.userId, args.userId),
          eq(workflowUserAutomationThreads.workflowId, args.workflowId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return eventRowToSummary(row, binding?.chatThreadId ?? null);
  },
);

const updateGmailEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automation: AutomationRow & {
        readonly eventType: GmailAutomationEventType;
      };
      readonly eventConfig:
        | GmailAutomationEventConfig
        | GithubAutomationEventConfig
        | GoogleCalendarAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const parsedConfig =
      args.automation.eventType === "gmail-label-applied"
        ? gmailLabelAppliedEventConfigSchema.safeParse(args.eventConfig)
        : gmailNewMessageEventConfigSchema.safeParse(args.eventConfig);
    if (!parsedConfig.success) {
      return {
        kind: "bad-request",
        message: "eventConfig must be a Gmail event config",
      };
    }
    const eventConnectorId = await set(
      readGmailAutomationConnectorId$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message: "Connect Gmail before using Gmail event automations",
      };
    }
    const preparedConfig = await set(
      prepareGmailEventConfigForPersist$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        connectorId: eventConnectorId,
        eventType: args.automation.eventType,
        eventConfig: parsedConfig.data,
      },
      signal,
    );
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }
    const summary = await set(
      persistGmailEventConfiguration$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.automation.workflowId,
        automationId: args.automation.id,
        connectorId: eventConnectorId,
        eventConfig: preparedConfig.eventConfig,
      },
      signal,
    );
    if (summary === null) {
      return {
        kind: "bad-request",
        message: "Gmail account selection changed; retry the update",
      };
    }
    if (args.automation.enabled) {
      await bestEffort(
        set(
          reconcileAutomationEventWatches$,
          {
            automations: [
              {
                orgId: args.orgId,
                ownerUserId: args.member.userId,
                eventType: args.automation.eventType,
                eventConfig: preparedConfig.eventConfig,
                eventConnectorId,
              },
            ],
          },
          signal,
        ),
        signal,
      );
    }
    return { kind: "ok", summary };
  },
);
type GoogleCalendarReconfigurationPersistenceResult =
  | {
      readonly kind: "ok";
      readonly summary: WorkflowAutomationSummary;
    }
  | {
      readonly kind: "account-changed";
    }
  | {
      readonly kind: "watch-changed";
    }
  | {
      readonly kind: "automation-changed";
    };

type GoogleCalendarAutomationUpdateEventConfig =
  | GmailAutomationEventConfig
  | GithubAutomationEventConfig
  | GoogleCalendarAutomationEventConfig;

interface GoogleCalendarAutomationUpdateArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automation: AutomationRow & {
    readonly eventType: GoogleCalendarAutomationEventType;
  };
  readonly eventConfig: GoogleCalendarAutomationUpdateEventConfig;
}
type GoogleCalendarReconfigurationPreparationResult =
  | {
      readonly kind: "ok";
      readonly eventConnectorId: string;
      readonly eventConfig: GoogleCalendarAutomationEventConfig;
      readonly requestedCalendarId: string;
      readonly previousTarget: StagedGoogleCalendarWatchTarget | null;
      readonly targetChanged: boolean;
    }
  | {
      readonly kind: "bad-request";
      readonly message: string;
    };

function googleCalendarAutomationMatchesReconfigurationSource(
  current: AutomationRow,
  source: AutomationRow & {
    readonly eventType: GoogleCalendarAutomationEventType;
  },
): boolean {
  return (
    current.orgId === source.orgId &&
    current.workflowId === source.workflowId &&
    current.ownerUserId === source.ownerUserId &&
    current.kind === "event" &&
    current.eventType === source.eventType &&
    current.enabled === source.enabled &&
    current.eventConnectorId === source.eventConnectorId &&
    current.officialBlueprintKey === null &&
    isDeepStrictEqual(current.eventConfig, source.eventConfig)
  );
}
const readCommittedGoogleCalendarSummary$ = command(
  async (
    { set },
    args: { readonly row: AutomationRow },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const db = set(writeDb$);
    const [thread] = await db
      .select({ id: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, args.row.orgId),
          eq(workflowUserAutomationThreads.userId, args.row.ownerUserId),
          eq(workflowUserAutomationThreads.workflowId, args.row.workflowId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const [watch] = await db
      .select({ reason: googleCalendarWatchStates.actionRequiredReason })
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.orgId, args.row.orgId),
          eq(googleCalendarWatchStates.userId, args.row.ownerUserId),
          eq(googleCalendarWatchStates.connectorId, args.row.eventConnectorId!),
          eq(
            googleCalendarWatchStates.calendarId,
            googleCalendarIdFromAutomationRow(args.row)!,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const summary = eventRowToSummary(args.row, thread?.id ?? null, {
      googleCalendar: watch?.reason ?? undefined,
    });
    if (!summary) {
      throw new Error("Expected a Google Calendar automation summary");
    }
    signal.throwIfAborted();
    return summary;
  },
);

const persistGoogleCalendarAutomationReconfiguration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly source: AutomationRow & {
        readonly eventType: GoogleCalendarAutomationEventType;
      };
      readonly eventConnectorId: string;
      readonly eventConfig: GoogleCalendarAutomationEventConfig;
      readonly requestedCalendarId: string;
      readonly requireReadyWatch: boolean;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarReconfigurationPersistenceResult> => {
    const db = set(writeDb$);
    const committed = await db.transaction(async (tx) => {
      await tx.execute(
        builtinConnectorStateLockStatement({
          orgId: args.orgId,
          userId: args.member.userId,
          connectorSlug: "google-calendar",
        }),
      );
      const [account] = await tx
        .select({
          id: connectors.id,
          isDefault: connectors.isDefault,
          email: connectors.externalEmail,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.id, args.eventConnectorId),
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.member.userId),
            eq(connectors.connectorSlug, "google-calendar"),
            eq(connectors.needsReconnect, false),
            googleCalendarSelectedAccountCondition({
              orgId: args.orgId,
              userId: args.member.userId,
              workflowId: args.source.workflowId,
              connectorId: args.eventConnectorId,
            }),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !account ||
        normalizeGoogleCalendarId(args.requestedCalendarId, account.email) !==
          args.eventConfig.calendarId
      ) {
        return { kind: "account-changed" } as const;
      }
      if (args.requireReadyWatch) {
        const [watch] = await tx
          .select({ id: googleCalendarWatchStates.id })
          .from(googleCalendarWatchStates)
          .where(
            and(
              eq(googleCalendarWatchStates.orgId, args.orgId),
              eq(googleCalendarWatchStates.userId, args.member.userId),
              eq(googleCalendarWatchStates.connectorId, account.id),
              eq(
                googleCalendarWatchStates.calendarId,
                args.eventConfig.calendarId,
              ),
              eq(googleCalendarWatchStates.needsRewatch, false),
              isNotNull(googleCalendarWatchStates.syncToken),
              isNull(googleCalendarWatchStates.actionRequiredReason),
              gt(googleCalendarWatchStates.watchExpirationAt, nowDate()),
            ),
          )
          .for("share")
          .limit(1);
        if (!watch) {
          return { kind: "watch-changed" } as const;
        }
      }
      const [current] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.id, args.source.id),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !current ||
        !googleCalendarAutomationMatchesReconfigurationSource(
          current,
          args.source,
        )
      ) {
        return { kind: "automation-changed" } as const;
      }
      const [row] = await tx
        .update(workflowAutomations)
        .set({
          eventConfig: args.eventConfig,
          eventConnectorId: args.eventConnectorId,
          updatedAt: nowDate(),
        })
        .where(eq(workflowAutomations.id, args.source.id))
        .returning(workflowAutomationColumns());
      if (!row) {
        throw new Error("Failed to update Google Calendar automation target");
      }
      signal.throwIfAborted();
      return { kind: "ok", row } as const;
    });
    signal.throwIfAborted();
    if (committed.kind !== "ok") {
      return committed;
    }
    const summary = await set(
      readCommittedGoogleCalendarSummary$,
      { row: committed.row },
      signal,
    );
    return { kind: "ok", summary };
  },
);

const prepareGoogleCalendarAutomationReconfiguration$ = command(
  async (
    { set },
    args: GoogleCalendarAutomationUpdateArgs,
    signal: AbortSignal,
  ): Promise<GoogleCalendarReconfigurationPreparationResult> => {
    const parsedConfig = safeParseGoogleCalendarEventConfig(
      args.automation.eventType,
      args.eventConfig,
    );
    if (parsedConfig === null) {
      return {
        kind: "bad-request",
        message: "eventConfig must match the Google Calendar automation type",
      };
    }
    const eventConnectorId = await set(
      readGoogleCalendarAutomationConnectorId$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: args.automation.workflowId,
      },
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Calendar before using Google Calendar event automations",
      };
    }
    const calendarId = await set(
      normalizeGoogleCalendarIdForConnector$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        connectorId: eventConnectorId,
        calendarId: parsedConfig.calendarId,
      },
      signal,
    );
    signal.throwIfAborted();
    const eventConfig = { ...parsedConfig, calendarId };
    const previousConfig = parseGoogleCalendarEventConfig(
      args.automation.eventType,
      args.automation.eventConfig,
    );
    const previousTarget =
      args.automation.eventConnectorId === null
        ? null
        : {
            connectorId: args.automation.eventConnectorId,
            calendarId: previousConfig.calendarId,
          };
    return {
      kind: "ok",
      eventConnectorId,
      eventConfig,
      requestedCalendarId: parsedConfig.calendarId,
      previousTarget,
      targetChanged:
        previousTarget === null ||
        previousTarget.connectorId !== eventConnectorId ||
        previousTarget.calendarId !== eventConfig.calendarId,
    };
  },
);
const releaseOwnedGoogleCalendarStagedTarget$ = command(
  async (
    { set },
    stagedTarget: StagedGoogleCalendarWatchTarget | null,
  ): Promise<void> => {
    if (stagedTarget === null) {
      return;
    }
    await bestEffort(
      set(
        releaseStagedGoogleCalendarWatchTarget$,
        { stagedTarget },
        new AbortController().signal,
      ),
    );
  },
);
const updateGoogleCalendarEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: GoogleCalendarAutomationUpdateArgs,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const prepared = await set(
      prepareGoogleCalendarAutomationReconfiguration$,
      args,
      signal,
    );
    if (prepared.kind !== "ok") {
      return prepared;
    }
    let stagedTarget: StagedGoogleCalendarWatchTarget | null = null;
    if (args.automation.enabled && prepared.targetChanged) {
      const staged = await set(
        stageGoogleCalendarWatchTargetForReconfiguration$,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          connectorId: prepared.eventConnectorId,
          calendarId: prepared.eventConfig.calendarId,
        },
        signal,
      );
      if (staged.kind !== "ok") {
        signal.throwIfAborted();
        return { kind: "bad-request", message: staged.message };
      }
      stagedTarget = staged.stagedTarget;
      if (signal.aborted) {
        await set(releaseOwnedGoogleCalendarStagedTarget$, stagedTarget);
        signal.throwIfAborted();
      }
    }
    const releaseStagedTarget = async (): Promise<void> => {
      await set(releaseOwnedGoogleCalendarStagedTarget$, stagedTarget);
    };
    const persistence = set(
      persistGoogleCalendarAutomationReconfiguration$,
      {
        orgId: args.orgId,
        member: args.member,
        source: args.automation,
        eventConnectorId: prepared.eventConnectorId,
        eventConfig: prepared.eventConfig,
        requestedCalendarId: prepared.requestedCalendarId,
        requireReadyWatch: args.automation.enabled && prepared.targetChanged,
      },
      signal,
    );
    const persisted =
      stagedTarget === null
        ? await persistence
        : await onRejection(persistence, releaseStagedTarget);
    if (persisted.kind !== "ok") {
      await releaseStagedTarget();
      signal.throwIfAborted();
      return {
        kind: "bad-request",
        message:
          persisted.kind === "account-changed"
            ? "Google Calendar account selection changed; retry the update"
            : persisted.kind === "watch-changed"
              ? "Google Calendar watch target changed; retry the update"
              : "Google Calendar automation changed; retry the update",
      };
    }
    if (prepared.targetChanged && prepared.previousTarget !== null) {
      const cleanupSignal = new AbortController().signal;
      await bestEffort(
        set(
          reconcileGoogleCalendarWatchTarget$,
          { ...prepared.previousTarget },
          cleanupSignal,
        ),
      );
    }
    return { kind: "ok", summary: persisted.summary };
  },
);
const updateEventAutomationForWorkflow$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automation: AutomationRow;
      readonly eventConfig?:
        | GmailAutomationEventConfig
        | GithubAutomationEventConfig
        | GoogleCalendarAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    if (args.automation.eventType === "webhook-received") {
      return {
        kind: "bad-request",
        message: "Webhook event automations cannot be updated",
      };
    }
    if (args.automation.eventType === "stripe-invoice-paid") {
      return {
        kind: "bad-request",
        message: "Stripe invoice-paid event automations cannot be updated",
      };
    }
    if (supportedGoogleFormsEventType(args.automation.eventType)) {
      return {
        kind: "bad-request",
        message:
          "this trigger has no updatable fields; delete it and create a new one",
      };
    }
    if (supportedGoogleMeetEventType(args.automation.eventType)) {
      return {
        kind: "bad-request",
        message: "Google Meet event automations cannot be updated",
      };
    }
    if (args.eventConfig === undefined) {
      return {
        kind: "bad-request",
        message: "eventConfig is required for event automations",
      };
    }
    if (supportedGoogleCalendarEventType(args.automation.eventType)) {
      return await set(
        updateGoogleCalendarEventAutomationForWorkflow$,
        {
          ...args,
          automation: {
            ...args.automation,
            eventType: args.automation.eventType,
          },
          eventConfig: args.eventConfig,
        },
        signal,
      );
    }
    if (supportedGithubEventType(args.automation.eventType)) {
      const eventConfig = await prepareGithubAutomationEventConfig(args.db, {
        orgId: args.orgId,
        eventType: args.automation.eventType,
        eventConfig: args.eventConfig,
      });
      signal.throwIfAborted();
      if (eventConfig.kind !== "ok") {
        return eventConfig;
      }
      return {
        kind: "ok",
        summary: await updateAutomationEventConfig(
          args.db,
          {
            automationId: args.automation.id,
            eventConfig: eventConfig.eventConfig,
          },
          signal,
        ),
      };
    }
    if (!supportedGmailEventType(args.automation.eventType)) {
      return { kind: "not-found" };
    }
    return await set(
      updateGmailEventAutomationForWorkflow$,
      {
        ...args,
        automation: {
          ...args.automation,
          eventType: args.automation.eventType,
        },
        eventConfig: args.eventConfig,
      },
      signal,
    );
  },
);

export const updateWorkflowAutomation$ = command(
  async (
    { set },
    args: UpdateAutomationInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, {
      orgId: args.orgId,
      member: args.member,
      automationId: args.automationId,
    });
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    if (automation.officialBlueprintKey !== null) {
      return {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
      };
    }

    if (automation.kind === "event") {
      return await set(
        updateEventAutomationForWorkflow$,
        {
          db: writeDb,
          orgId: args.orgId,
          member: args.member,
          automation,
          eventConfig: args.eventConfig,
        },
        signal,
      );
    }

    if (args.schedule === undefined) {
      return {
        kind: "bad-request",
        message: "schedule is required for schedule automations",
      };
    }
    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }
    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(
      args.schedule,
      automation.enabled,
      now,
      automation.lastRunAt,
    );

    const row = await writeDb.transaction(async (tx) => {
      const [updated] = await tx
        .update(workflowAutomations)
        .set({
          scheduleType: cols.scheduleType,
          cronExpression: cols.cronExpression,
          intervalSeconds: cols.intervalSeconds,
          atTime: cols.atTime,
          timezone: cols.timezone,
          nextRunAt,
          updatedAt: now,
        })
        .where(eq(workflowAutomations.id, automation.id))
        .returning(workflowAutomationColumns());
      if (!updated) {
        throw new Error("Failed to update workflow automation");
      }
      return updated;
    });
    signal.throwIfAborted();
    return { kind: "ok", summary: await rowToSummary(writeDb, row) };
  },
);

interface AutomationActionInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automationId: string;
  readonly sourceRunId?: string;
  readonly inheritedAutonomyBudget?: number;
  readonly allowReservedOfficialMaterialization?: boolean;
}

/**
 * Repeated "Run now" clicks are otherwise indistinguishable, so the request time
 * is this run's unique identifier.
 */
function manualTriggerContext(args: {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly requestedAt: Date;
  readonly sourceRunId?: string;
}): WorkflowAutomationContext {
  const requestedAt = args.requestedAt.toISOString();
  return {
    workflowName: args.workflowName,
    eventType: "manual",
    trigger: `manual run requested at ${requestedAt}.`,
    event: {
      automationId: args.automation.id,
      trigger: "manual",
      requestedAt,
      ...(args.sourceRunId === undefined
        ? {}
        : { sourceRunId: args.sourceRunId }),
    },
  };
}

export const runOwnedWorkflowAutomationNow$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<WorkflowAutomationRunNowResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    const target = await loadAutomationWorkflowRunTarget(writeDb, {
      orgId: args.orgId,
      workflowId: automation.workflowId,
    });
    signal.throwIfAborted();
    if (!target) {
      return { kind: "not-found" };
    }
    const agent = await loadAgent(writeDb, {
      orgId: args.orgId,
      agentId: target.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "conflict",
        message: "Cannot run: the workflow's agent no longer exists.",
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }

    const currentTime = nowDate();
    const ownerTimezone = await loadAutomationOwnerTimezone(
      writeDb,
      automation,
    );
    signal.throwIfAborted();
    const chatThreadId = await set(
      ensureWorkflowUserAutomationThread$,
      {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        workflowId: automation.workflowId,
        agentId: target.agentId,
        workflowTitle: target.workflowTitle,
        currentTime,
      },
      signal,
    );
    signal.throwIfAborted();

    const manualContext = manualTriggerContext({
      automation,
      workflowName: target.workflowName,
      requestedAt: currentTime,
      ...(args.sourceRunId === undefined
        ? {}
        : { sourceRunId: args.sourceRunId }),
    });
    await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation,
          agentId: target.agentId,
          chatThreadId,
        },
        automationContext: manualContext,
        apiStartTime: currentTime.getTime(),
        triggerSource: manualTriggerSource(automation),
        triggerBrief:
          buildWorkflowScheduleAutomationBrief({
            createdAt: currentTime,
            scheduleType: automation.scheduleType,
            cronExpression: automation.cronExpression,
            intervalSeconds: automation.intervalSeconds,
            atTime: automation.atTime,
            automationTimezone: automation.timezone,
            userTimezone: ownerTimezone,
          }) ?? undefined,
        replacePendingScheduleTick: false,
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "enqueued", chatThreadId };
  },
);
export const deleteWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    if (owned.automation.officialBlueprintKey !== null) {
      return {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
      };
    }
    const chatThreadId = await loadWorkflowUserAutomationThreadId(writeDb, {
      orgId: owned.automation.orgId,
      userId: owned.automation.ownerUserId,
      workflowId: owned.automation.workflowId,
    });
    signal.throwIfAborted();
    // Delete the automation row only; the bound chat thread is kept.
    await writeDb
      .delete(workflowAutomations)
      .where(eq(workflowAutomations.id, owned.automation.id));
    signal.throwIfAborted();
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: [owned.automation],
      },
      signal,
    );
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "deleted" };
  },
);

const ensureEventAutomationCanBeEnabled$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automation: AutomationRow;
    },
    signal: AbortSignal,
  ): Promise<AutomationActionFailure | null> => {
    if (supportedGithubEventType(args.automation.eventType)) {
      const preparedConfig = await prepareGithubAutomationEventConfig(
        set(writeDb$),
        {
          orgId: args.orgId,
          eventType: args.automation.eventType,
          eventConfig: args.automation.eventConfig,
        },
      );
      signal.throwIfAborted();
      return preparedConfig.kind === "ok" ? null : preparedConfig;
    }

    return null;
  },
);

const enabledWatchHadConsumer$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    if (supportedGmailEventType(args.automation.eventType)) {
      if (args.automation.eventConnectorId === null) {
        return false;
      }
      return await set(
        hasEnabledGmailConsumer$,
        {
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          connectorId: args.automation.eventConnectorId,
        },
        signal,
      );
    }
    if (supportedGoogleMeetEventType(args.automation.eventType)) {
      if (args.automation.eventConnectorId === null) {
        return false;
      }
      return await hasEnabledGoogleMeetConsumer(
        {
          db: db,
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          connectorId: args.automation.eventConnectorId,
        },
        signal,
      );
    }
    if (supportedGoogleFormsEventType(args.automation.eventType)) {
      const config = googleFormsResponseSubmittedEventConfigSchema.parse(
        args.automation.eventConfig,
      );
      return await set(
        hasEnabledGoogleFormsConsumer$,
        {
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          connectorId: config.connectorId,
          formId: config.form.id,
        },
        signal,
      );
    }
    if (!supportedGoogleCalendarEventType(args.automation.eventType)) {
      return false;
    }
    if (args.automation.eventConnectorId === null) {
      return false;
    }
    const config = parseGoogleCalendarEventConfig(
      args.automation.eventType,
      args.automation.eventConfig,
    );
    return await set(
      hasEnabledGoogleCalendarConsumer$,
      {
        orgId: args.automation.orgId,
        userId: args.automation.ownerUserId,
        connectorId: args.automation.eventConnectorId,
        calendarId: config.calendarId,
      },
      signal,
    );
  },
);

const ensureEnabledAutomationEventWatch$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly hadConsumer: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationActionFailure | null> => {
    const db = set(writeDb$);
    if (supportedGmailEventType(args.automation.eventType)) {
      if (args.automation.eventConnectorId === null) {
        return {
          kind: "bad-request",
          message: "Connect Gmail before using Gmail event automations",
        };
      }
      const result = await set(
        ensureGmailWatchForUser$,
        {
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          connectorId: args.automation.eventConnectorId,
          forceRefresh: !args.hadConsumer,
        },
        signal,
      );
      return result.kind === "ok"
        ? null
        : { kind: "bad-request", message: result.message };
    }
    if (supportedGoogleMeetEventType(args.automation.eventType)) {
      if (args.automation.eventConnectorId === null) {
        return {
          kind: "bad-request",
          message:
            "Connect Google Meet before using Google Meet event automations",
        };
      }
      const result =
        await ensureGoogleMeetTranscriptGeneratedSubscriptionForUser(
          {
            db: db,
            orgId: args.automation.orgId,
            userId: args.automation.ownerUserId,
            connectorId: args.automation.eventConnectorId,
          },
          signal,
        );
      return result.kind === "ok"
        ? null
        : { kind: "bad-request", message: result.message };
    }
    if (supportedGoogleFormsEventType(args.automation.eventType)) {
      const config = googleFormsResponseSubmittedEventConfigSchema.parse(
        args.automation.eventConfig,
      );
      const result = await set(
        ensureGoogleFormsWatchForUser$,
        {
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          formId: config.form.id,
          connectorId: config.connectorId,
          resetAutomationId: args.automation.id,
          automationSnapshot: workflowAutomationSnapshot(args.automation),
        },
        signal,
      );
      return result.kind === "ok"
        ? null
        : {
            kind: result.kind === "superseded" ? "conflict" : "bad-request",
            message: result.message,
          };
    }
    if (!supportedGoogleCalendarEventType(args.automation.eventType)) {
      return null;
    }
    if (args.automation.eventConnectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Calendar before using Google Calendar event automations",
      };
    }
    const config = parseGoogleCalendarEventConfig(
      args.automation.eventType,
      args.automation.eventConfig,
    );
    const result = await set(
      ensureGoogleCalendarWatchForUser$,
      {
        orgId: args.automation.orgId,
        userId: args.automation.ownerUserId,
        connectorId: args.automation.eventConnectorId,
        calendarId: config.calendarId,
        forceRefresh: !args.hadConsumer,
      },
      signal,
    );
    return result.kind === "ok"
      ? null
      : { kind: "bad-request", message: result.message };
  },
);

function orphanedEnableCompensationCondition(
  previous: AutomationRow,
  enabled: AutomationRow,
) {
  const observation = workflowAutomationSnapshot(enabled);
  if (
    previous.enabled ||
    previous.officialBlueprintKey !== null ||
    enabled.eventConnectorId === null ||
    enabled.eventType === null ||
    observation === undefined
  ) {
    return sql`false`;
  }
  // Connector deletion changes xmin through FK SET NULL, without publishing a
  // new automation intent. A failed first enable must still return this exact
  // orphaned source to disabled. A rebound account or changed source is excluded.
  return and(
    eq(workflowAutomations.id, enabled.id),
    eq(workflowAutomations.orgId, enabled.orgId),
    eq(workflowAutomations.ownerUserId, enabled.ownerUserId),
    eq(workflowAutomations.workflowId, enabled.workflowId),
    eq(workflowAutomations.kind, "event"),
    eq(workflowAutomations.eventType, enabled.eventType),
    eq(workflowAutomations.enabled, true),
    isNull(workflowAutomations.officialBlueprintKey),
    isNull(workflowAutomations.eventConnectorId),
    sql`${workflowAutomations.updatedAt} = ${observation.observedUpdatedAt}::timestamptz`,
    sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${enabled.eventConfig === null ? null : JSON.stringify(enabled.eventConfig)}::jsonb`,
    sql`NOT EXISTS (SELECT 1 FROM ${connectors} WHERE ${connectors.id} = ${enabled.eventConnectorId}::uuid)`,
  );
}

const restoreDisabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly previousAutomation: AutomationRow;
      readonly enabledAutomation: AutomationRow;
    },
  ): Promise<void> => {
    const { previousAutomation, enabledAutomation } = args;
    const snapshot = workflowAutomationSnapshot(enabledAutomation);
    if (snapshot === undefined) {
      throw new Error(
        "Automation enable compensation requires its committed snapshot",
      );
    }
    const officialReconciliationStatus =
      previousAutomation.officialBlueprintKey === null
        ? null
        : previousAutomation.officialReconciliationStatus;
    if (
      previousAutomation.officialBlueprintKey !== null &&
      officialReconciliationStatus === null
    ) {
      throw new Error("Official Workflow automation state is incomplete");
    }
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const [restored] = await tx
        .update(workflowAutomations)
        .set({
          enabled: previousAutomation.enabled,
          nextRunAt: previousAutomation.nextRunAt,
          ...(officialReconciliationStatus === null
            ? {}
            : {
                officialIntendedEnabled:
                  previousAutomation.officialIntendedEnabled,
                officialReconciliationStatus,
              }),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(workflowAutomations.id, previousAutomation.id),
            or(
              workflowAutomationSnapshotCondition(snapshot),
              orphanedEnableCompensationCondition(
                previousAutomation,
                enabledAutomation,
              ),
            ),
          ),
        )
        .returning({ id: workflowAutomations.id });
      if (
        restored &&
        previousAutomation.eventType === "google-forms-response-submitted" &&
        !previousAutomation.enabled
      ) {
        await tx
          .delete(googleFormsAutomationCursors)
          .where(eq(googleFormsAutomationCursors.automationId, restored.id));
      }
    });
  },
);

function officialAutomationReconfigurationFailure(
  automation: AutomationRow,
): AutomationActionFailure | null {
  return automation.officialBlueprintKey !== null &&
    automation.officialReconciliationStatus === "reconciling"
    ? {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
      }
    : null;
}

async function finalizeEnabledOfficialAutomation(
  db: Db,
  previousAutomation: AutomationRow,
  enabledAutomation: AutomationRow,
  signal: AbortSignal,
): Promise<AutomationRow> {
  if (
    previousAutomation.officialBlueprintKey === null ||
    enabledAutomation.kind !== "event"
  ) {
    return enabledAutomation;
  }
  if (previousAutomation.officialReconciliationStatus === null) {
    throw new Error("Official Workflow automation state is incomplete");
  }
  const [finalized] = await db
    .update(workflowAutomations)
    .set({
      officialReconciliationStatus:
        previousAutomation.officialReconciliationStatus,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(workflowAutomations.id, enabledAutomation.id),
        eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
        workflowAutomationSnapshotCondition(
          workflowAutomationSnapshot(enabledAutomation),
        ),
      ),
    )
    .returning(workflowAutomationColumns());
  signal.throwIfAborted();
  if (!finalized) {
    throw new Error(
      "Official Workflow lifecycle reconciliation lost ownership",
    );
  }
  return finalized;
}
const ensureEnabledAutomationEventWatchWithRollback$ = command(
  async (
    { set },
    args: {
      readonly previousAutomation: AutomationRow;
      readonly enabledAutomation: AutomationRow;
      readonly hadConsumer: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationActionFailure | null> => {
    const db = set(writeDb$);
    const rollback = async (): Promise<void> => {
      const cleanupSignal = new AbortController().signal;
      await onRejection(
        (async () => {
          await set(restoreDisabledWorkflowAutomation$, {
            previousAutomation: args.previousAutomation,
            enabledAutomation: args.enabledAutomation,
          });
          await set(
            reconcileAutomationEventWatches$,
            {
              automations: [args.enabledAutomation],
            },
            cleanupSignal,
          );
        })(),
        async () => {
          if (args.previousAutomation.officialBlueprintKey === null) {
            return;
          }
          await db
            .update(workflowAutomations)
            .set({
              officialReconciliationStatus: "failed",
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(workflowAutomations.id, args.previousAutomation.id),
                isNotNull(workflowAutomations.officialBlueprintKey),
                workflowAutomationSnapshotCondition(
                  workflowAutomationSnapshot(args.enabledAutomation),
                ),
              ),
            );
        },
      );
    };
    return await onRejection(
      (async () => {
        const failure = await set(
          ensureEnabledAutomationEventWatch$,
          {
            automation: args.enabledAutomation,
            hadConsumer: args.hadConsumer,
          },
          signal,
        );
        if (failure && failure.kind !== "conflict") {
          await rollback();
        }
        signal.throwIfAborted();
        return failure;
      })(),
      rollback,
    );
  },
);
type EnabledAutomationAccountProjection =
  | {
      readonly status: "gmail-unavailable";
    }
  | {
      readonly status: "google-calendar-unavailable";
    }
  | {
      readonly status: "google-forms-unavailable";
    }
  | {
      readonly status: "google-meet-unavailable";
    }
  | {
      readonly status: "notion-unavailable";
    }
  | {
      readonly status: "notion-account-changed";
    }
  | {
      readonly status: "stripe-unavailable";
      readonly message: string;
    }
  | {
      readonly status: "ok";
      readonly required: false;
    }
  | {
      readonly status: "ok";
      readonly required: true;
      readonly eventConnectorId: string;
      readonly eventConfig: WorkflowAutomationEventConfig;
    };

async function projectGoogleFormsEnabledEventConfig(
  db: Db,
  automation: AutomationRow,
  eventConnectorId: string,
): Promise<GoogleFormsResponseSubmittedEventConfig> {
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    automation.eventConfig,
  );
  if (
    config.connectorId !== eventConnectorId ||
    (automation.eventConnectorId !== null &&
      automation.eventConnectorId !== eventConnectorId)
  ) {
    await db
      .delete(googleFormsAutomationCursors)
      .where(eq(googleFormsAutomationCursors.automationId, automation.id));
  }
  return { ...config, connectorId: eventConnectorId };
}

async function resolveEnabledAutomationConnectorId(
  db: Db,
  provider: Exclude<WorkflowAutomationAccountConnectorSlug, "stripe">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  switch (provider) {
    case "gmail": {
      return await resolveGmailAutomationConnectorId(db, args);
    }
    case "google-calendar": {
      return await resolveGoogleCalendarAutomationConnectorId(db, args);
    }
    case "google-forms": {
      return await resolveGoogleFormsAutomationConnectorId(db, args);
    }
    case "google-meet": {
      return await resolveGoogleMeetAutomationConnectorId(db, args);
    }
    case "notion": {
      return await resolveNotionAutomationConnectorId(db, args);
    }
  }
}

function unavailableEnabledAutomationProjection(
  provider: Exclude<WorkflowAutomationAccountConnectorSlug, "stripe">,
): EnabledAutomationAccountProjection {
  switch (provider) {
    case "gmail": {
      return { status: "gmail-unavailable" };
    }
    case "google-calendar": {
      return { status: "google-calendar-unavailable" };
    }
    case "google-forms": {
      return { status: "google-forms-unavailable" };
    }
    case "google-meet": {
      return { status: "google-meet-unavailable" };
    }
    case "notion": {
      return { status: "notion-unavailable" };
    }
  }
}

function enabledAutomationUnavailableMessage(
  provider: Exclude<WorkflowAutomationAccountConnectorSlug, "stripe">,
): string {
  switch (provider) {
    case "gmail": {
      return "Connect Gmail before using Gmail event automations";
    }
    case "google-calendar": {
      return "Connect Google Calendar before using Google Calendar event automations";
    }
    case "google-forms": {
      return "Connect Google Forms before using Google Forms response automations";
    }
    case "google-meet": {
      return "Connect Google Meet before using Google Meet event automations";
    }
    case "notion": {
      return "Connect Notion before using Notion event automations";
    }
  }
}

async function lockEnabledAutomationAccountProjection(
  db: Db,
  automation: AutomationRow,
  signal: AbortSignal,
): Promise<EnabledAutomationAccountProjection> {
  const provider = workflowAutomationAccountConnectorSlug(automation.eventType);
  if (provider === null) {
    return { status: "ok", required: false };
  }
  await lockConnectorAccountTarget(db, {
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    target: {
      kind: "builtin",
      connectorSlug: provider,
    },
  });
  const connectorArgs = {
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    workflowId: automation.workflowId,
  };
  if (provider === "stripe") {
    const readiness = await resolveStripeInvoicePaidAutomationBinding(
      { db, ...connectorArgs },
      signal,
    );
    if (readiness.kind === "bad_request") {
      return {
        status: "stripe-unavailable",
        message: readiness.message,
      };
    }
    return {
      status: "ok",
      required: true,
      eventConnectorId: readiness.binding.connectorId,
      eventConfig: {
        ...stripeInvoicePaidEventConfigSchema.parse(automation.eventConfig),
        ...readiness.binding,
      },
    };
  }
  const eventConnectorId = await resolveEnabledAutomationConnectorId(
    db,
    provider,
    connectorArgs,
  );
  if (eventConnectorId === null) {
    return unavailableEnabledAutomationProjection(provider);
  }
  if (
    provider === "notion" &&
    automation.eventConnectorId !== eventConnectorId
  ) {
    return { status: "notion-account-changed" };
  }
  let eventConfig: WorkflowAutomationEventConfig | null =
    automation.eventConfig;
  if (provider === "notion") {
    eventConfig = notionConfigWithConnectorId(
      automation.eventType,
      automation.eventConfig,
      eventConnectorId,
    );
  } else if (provider === "google-calendar") {
    if (!supportedGoogleCalendarEventType(automation.eventType)) {
      throw new Error("Expected a Google Calendar event automation");
    }
    const parsedConfig = parseGoogleCalendarEventConfig(
      automation.eventType,
      automation.eventConfig,
    );
    const [calendarAccount] = await db
      .select({ externalEmail: connectors.externalEmail })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, eventConnectorId),
          eq(connectors.orgId, automation.orgId),
          eq(connectors.userId, automation.ownerUserId),
        ),
      )
      .limit(1);
    const calendarId = normalizeGoogleCalendarId(
      parsedConfig.calendarId,
      calendarAccount?.externalEmail ?? null,
    );
    signal.throwIfAborted();
    eventConfig = { ...parsedConfig, calendarId };
  } else if (provider === "google-forms") {
    eventConfig = await projectGoogleFormsEnabledEventConfig(
      db,
      automation,
      eventConnectorId,
    );
  }
  if (eventConfig === null) {
    throw new Error("Enabled connector automation config is incomplete");
  }
  return {
    status: "ok",
    required: true,
    eventConnectorId,
    eventConfig,
  };
}
async function persistEnabledWorkflowAutomation(
  db: Db,
  args: {
    readonly automation: AutomationRow;
    readonly orgId: string;
    readonly nextRunAt: Date | null;
    readonly now: Date;
    readonly inheritedAutonomyBudget?: number;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly status: "team-required";
    }
  | {
      readonly status: "conflict";
    }
  | {
      readonly status: "gmail-unavailable";
    }
  | {
      readonly status: "google-calendar-unavailable";
    }
  | {
      readonly status: "notion-unavailable";
    }
  | {
      readonly status: "notion-account-changed";
    }
  | {
      readonly status: "stripe-unavailable";
      readonly message: string;
    }
  | {
      readonly status: "google-forms-unavailable";
    }
  | {
      readonly status: "google-meet-unavailable";
    }
  | {
      readonly status: "ok";
      readonly row: AutomationRow | undefined;
    }
> {
  return await db.transaction(async (tx) => {
    const accountProjection = await lockEnabledAutomationAccountProjection(
      tx,
      args.automation,
      signal,
    );
    if (accountProjection.status !== "ok") {
      return accountProjection;
    }
    if (
      args.automation.kind === "event" &&
      args.automation.eventType === "webhook-received"
    ) {
      const tierEligible =
        await lockWorkflowWebhookAutomationTierEligibleForOrg(
          tx,
          {
            orgId: args.orgId,
          },
          signal,
        );
      if (!tierEligible) {
        return { status: "team-required" };
      }
    }
    const [enabledRow] = await tx
      .update(workflowAutomations)
      .set({
        enabled: true,
        ...(accountProjection.required
          ? {
              eventConnectorId: accountProjection.eventConnectorId,
              eventConfig: accountProjection.eventConfig,
            }
          : {}),
        nextRunAt: args.nextRunAt,
        consecutiveFailures: 0,
        updatedAt: args.now,
        ...(args.automation.officialBlueprintKey !== null
          ? {
              officialIntendedEnabled: true,
              ...(args.automation.kind === "event"
                ? { officialReconciliationStatus: "reconciling" as const }
                : {}),
            }
          : args.inheritedAutonomyBudget === undefined
            ? {}
            : { autonomyBudget: args.inheritedAutonomyBudget }),
      })
      .where(officialAutomationLifecycleCondition(args.automation))
      .returning(workflowAutomationColumns());
    if (
      enabledRow &&
      args.automation.kind === "event" &&
      args.automation.eventType === "webhook-received"
    ) {
      await tx
        .update(workflowWebhookAutomations)
        .set({ disabledReason: null, updatedAt: args.now })
        .where(eq(workflowWebhookAutomations.automationId, args.automation.id));
    }
    return !enabledRow && args.automation.officialBlueprintKey !== null
      ? { status: "conflict" }
      : { status: "ok", row: enabledRow };
  });
}
const prepareEnabledAutomationAccountProjection$ = command(
  async (
    { set },
    automation: AutomationRow,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly eventConnectorId: string | null;
      }
    | AutomationActionFailure
  > => {
    const provider = workflowAutomationAccountConnectorSlug(
      automation.eventType,
    );
    if (provider === null || provider === "stripe") {
      return { kind: "ok", eventConnectorId: automation.eventConnectorId };
    }
    const connectorArgs = {
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      workflowId: automation.workflowId,
    };
    const eventConnectorId = await set(
      readEventAutomationConnectorId$,
      { ...connectorArgs, connectorSlug: provider },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message: enabledAutomationUnavailableMessage(provider),
      };
    }
    if (provider !== "notion") {
      return { kind: "ok", eventConnectorId };
    }
    if (!supportedNotionEventType(automation.eventType)) {
      throw new Error("Notion automation account projection is incomplete");
    }
    const eventType = automation.eventType;
    const validation = await set(
      validateNotionEventConfigForConnector$,
      {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        connectorId: eventConnectorId,
        eventType,
        eventConfig: notionConfigWithConnectorId(
          eventType,
          automation.eventConfig,
          eventConnectorId,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    return validation.kind === "ok"
      ? { kind: "ok", eventConnectorId }
      : validation;
  },
);

function enabledAutomationWithAccountProjection(
  automation: AutomationRow,
  eventConnectorId: string | null,
): AutomationRow {
  if (!supportedGoogleFormsEventType(automation.eventType)) {
    return { ...automation, eventConnectorId };
  }
  if (eventConnectorId === null) {
    throw new Error("Google Forms account projection is unavailable");
  }
  return {
    ...automation,
    eventConnectorId,
    eventConfig: {
      ...googleFormsResponseSubmittedEventConfigSchema.parse(
        automation.eventConfig,
      ),
      connectorId: eventConnectorId,
    },
  };
}

async function finalizeAndPublishEnabledWorkflowAutomation(
  db: Db,
  args: {
    readonly previousAutomation: AutomationRow;
    readonly enabledAutomation: AutomationRow;
    readonly memberUserId: string;
  },
  signal: AbortSignal,
): Promise<AutomationResult> {
  const row = await finalizeEnabledOfficialAutomation(
    db,
    args.previousAutomation,
    args.enabledAutomation,
    signal,
  );
  const chatThreadId = await loadWorkflowUserAutomationThreadId(db, {
    orgId: row.orgId,
    userId: row.ownerUserId,
    workflowId: row.workflowId,
  });
  signal.throwIfAborted();
  await publishThreadBoundWorkflowAutomationChanged(
    args.memberUserId,
    chatThreadId,
  );
  signal.throwIfAborted();
  const summary = await rowToSummary(db, row, { chatThreadId });
  signal.throwIfAborted();
  return { kind: "ok", summary };
}
const publishEnabledGoogleFormsSummary$ = command(
  async (
    { set },
    args: {
      readonly row: AutomationRow;
      readonly memberUserId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const { row } = args;
    const db = set(writeDb$);
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, row.orgId),
          eq(workflowUserAutomationThreads.userId, row.ownerUserId),
          eq(workflowUserAutomationThreads.workflowId, row.workflowId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const chatThreadId = binding?.chatThreadId ?? null;
    await publishThreadBoundWorkflowAutomationChanged(
      args.memberUserId,
      chatThreadId,
    );
    signal.throwIfAborted();
    const summary = eventRowToSummary(row, chatThreadId);
    if (!summary) {
      throw new Error(
        "Google Forms activation returned an invalid event source",
      );
    }
    return { kind: "ok", summary };
  },
);

const activateInactiveGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly previousAutomation: AutomationRow;
      readonly memberUserId: string;
      readonly nextRunAt: Date | null;
      readonly inheritedAutonomyBudget?: number;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const connectorId = await set(
      readGoogleFormsActivationAccount$,
      {
        orgId: args.previousAutomation.orgId,
        userId: args.previousAutomation.ownerUserId,
        workflowId: args.previousAutomation.workflowId,
      },
      signal,
    );
    if (connectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Forms before using Google Forms response automations",
      };
    }
    const eventConfig = {
      ...googleFormsResponseSubmittedEventConfigSchema.parse(
        args.previousAutomation.eventConfig,
      ),
      connectorId,
    };
    const prepared = await set(
      ensureGoogleFormsWatchForUser$,
      {
        orgId: args.previousAutomation.orgId,
        userId: args.previousAutomation.ownerUserId,
        formId: eventConfig.form.id,
        connectorId: eventConfig.connectorId,
        resetAutomationId: args.previousAutomation.id,
        automationSnapshot: workflowAutomationSnapshot(args.previousAutomation),
        activation: {
          automationId: args.previousAutomation.id,
          workflowId: args.previousAutomation.workflowId,
          eventConfig,
          nextRunAt: args.nextRunAt,
          inheritedAutonomyBudget: args.inheritedAutonomyBudget,
        },
      },
      signal,
    );
    if (prepared.kind !== "ok") {
      return {
        kind: prepared.kind === "superseded" ? "conflict" : "bad-request",
        message: prepared.message,
      };
    }
    if (!prepared.enabledAutomation) {
      throw new Error(
        "Google Forms activation did not commit an enabled automation",
      );
    }
    return await set(
      publishEnabledGoogleFormsSummary$,
      { row: prepared.enabledAutomation, memberUserId: args.memberUserId },
      signal,
    );
  },
);

const refreshEnabledGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly memberUserId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const owner = {
      orgId: args.automation.orgId,
      userId: args.automation.ownerUserId,
    };
    await set(reprojectGoogleFormsAutomationOwnership$, owner, signal);
    const db = set(writeDb$);
    const [current] = await db
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, args.automation.id),
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventType, "google-forms-response-submitted"),
          isNull(workflowAutomations.officialBlueprintKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return {
        kind: "conflict",
        message: "Google Forms automation changed; retry the request",
      };
    }
    const connectorId = await set(
      readGoogleFormsActivationAccount$,
      {
        ...owner,
        workflowId: current.workflowId,
      },
      signal,
    );
    if (connectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Forms before using Google Forms response automations",
      };
    }
    const eventConfig = {
      ...googleFormsResponseSubmittedEventConfigSchema.parse(
        current.eventConfig,
      ),
      connectorId,
    };
    const prepared = await set(
      ensureGoogleFormsWatchForUser$,
      {
        ...owner,
        connectorId,
        formId: eventConfig.form.id,
        resetAutomationId: current.id,
        automationSnapshot: workflowAutomationSnapshot(current),
      },
      signal,
    );
    if (prepared.kind !== "ok") {
      return {
        kind: prepared.kind === "superseded" ? "conflict" : "bad-request",
        message: prepared.message,
      };
    }
    return await set(
      publishEnabledGoogleFormsSummary$,
      {
        row: prepared.enabledAutomation ?? current,
        memberUserId: args.memberUserId,
      },
      signal,
    );
  },
);

function enabledWorkflowAutomationFailure(
  enabled: Awaited<ReturnType<typeof persistEnabledWorkflowAutomation>>,
): AutomationActionFailure | null {
  if (enabled.status === "team-required") {
    return workflowWebhookTeamRequiredResult();
  }
  if (enabled.status === "conflict") {
    return {
      kind: "conflict",
      message: OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
    };
  }
  if (enabled.status === "gmail-unavailable") {
    return {
      kind: "bad-request",
      message: "Connect Gmail before using Gmail event automations",
    };
  }
  if (enabled.status === "google-calendar-unavailable") {
    return {
      kind: "bad-request",
      message:
        "Connect Google Calendar before using Google Calendar event automations",
    };
  }
  if (enabled.status === "notion-unavailable") {
    return {
      kind: "bad-request",
      message: "Connect Notion before using Notion event automations",
    };
  }
  if (enabled.status === "notion-account-changed") {
    return {
      kind: "bad-request",
      message:
        "Notion account selection changed; retry enabling the automation",
    };
  }
  if (enabled.status === "stripe-unavailable") {
    return { kind: "bad-request", message: enabled.message };
  }
  if (enabled.status === "google-forms-unavailable") {
    return {
      kind: "bad-request",
      message:
        "Connect Google Forms before using Google Forms response automations",
    };
  }
  if (enabled.status === "google-meet-unavailable") {
    return {
      kind: "bad-request",
      message: "Connect Google Meet before using Google Meet event automations",
    };
  }
  return null;
}

const persistAndReconcileEnabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly orgId: string;
      readonly memberUserId: string;
      readonly nextRunAt: Date | null;
      readonly now: Date;
      readonly inheritedAutonomyBudget?: number;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    if (
      args.automation.eventType === "google-forms-response-submitted" &&
      args.automation.officialBlueprintKey === null
    ) {
      if (args.automation.enabled) {
        return await set(
          refreshEnabledGoogleFormsAutomation$,
          {
            automation: args.automation,
            memberUserId: args.memberUserId,
          },
          signal,
        );
      }
      return await set(
        activateInactiveGoogleFormsAutomation$,
        {
          previousAutomation: args.automation,
          memberUserId: args.memberUserId,
          nextRunAt: args.nextRunAt,
          inheritedAutonomyBudget: args.inheritedAutonomyBudget,
        },
        signal,
      );
    }
    const db = set(writeDb$);
    const accountProjection = await set(
      prepareEnabledAutomationAccountProjection$,
      args.automation,
      signal,
    );
    if (accountProjection.kind !== "ok") {
      return accountProjection;
    }
    const automation = enabledAutomationWithAccountProjection(
      args.automation,
      accountProjection.eventConnectorId,
    );
    const watchHadConsumer = await set(
      enabledWatchHadConsumer$,
      { automation },
      signal,
    );
    const enabled = await persistEnabledWorkflowAutomation(
      db,
      {
        automation,
        orgId: args.orgId,
        nextRunAt: args.nextRunAt,
        now: args.now,
        inheritedAutonomyBudget: args.inheritedAutonomyBudget,
      },
      signal,
    );
    signal.throwIfAborted();
    const failure = enabledWorkflowAutomationFailure(enabled);
    if (failure) {
      return failure;
    }
    if (enabled.status !== "ok") {
      throw new Error("Unclassified automation enable result");
    }
    if (!enabled.row) {
      throw new Error("Failed to enable workflow automation");
    }
    const watchFailure = await set(
      ensureEnabledAutomationEventWatchWithRollback$,
      {
        previousAutomation: args.automation,
        enabledAutomation: enabled.row,
        hadConsumer: watchHadConsumer,
      },
      signal,
    );
    if (watchFailure) {
      return watchFailure;
    }
    return await finalizeAndPublishEnabledWorkflowAutomation(
      db,
      {
        previousAutomation: args.automation,
        enabledAutomation: enabled.row,
        memberUserId: args.memberUserId,
      },
      signal,
    );
  },
);

const validateStripeFeature$ = command(
  async (
    { get },
    automation: AutomationRow,
    signal: AbortSignal,
  ): Promise<AutomationResult | null> => {
    if (automation.eventType !== "stripe-invoice-paid") {
      return null;
    }
    const featureEnabled = await get(
      stripeInvoicePaidWorkflowAutomationEnabledForOwner(
        automation.orgId,
        automation.ownerUserId,
      ),
    );
    signal.throwIfAborted();
    return featureEnabled
      ? null
      : stripeInvoicePaidWorkflowAutomationsDisabledResult();
  },
);

const readWorkflowAutomationEnableTarget$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<OwnedAutomation | AutomationActionFailure> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        automation: workflowAutomationColumns(),
        agent: {
          id: agents.id,
          owner: agents.owner,
          visibility: agents.visibility,
        },
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .innerJoin(agents, eq(agents.id, workflows.agentId))
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflows.orgId, args.orgId),
          eq(agents.orgId, args.orgId),
          visibleWorkflowCondition(args.member),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      (row.automation.kind === "event" &&
        !supportedAutomationEventType(row.automation.eventType))
    ) {
      return { kind: "not-found" };
    }
    if (row.automation.ownerUserId !== args.member.userId) {
      return {
        kind: "forbidden",
        message: "Only the automation owner can manage this automation",
      };
    }
    if (!canUseAgent(row.agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }
    return { automation: row.automation };
  },
);

export const enableWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const owned = await set(readWorkflowAutomationEnableTarget$, args, signal);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    const reconfigurationFailure =
      args.allowReservedOfficialMaterialization === true
        ? automation.officialReconciliationStatus === "reconciling"
          ? null
          : {
              kind: "conflict" as const,
              message: OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
            }
        : officialAutomationReconfigurationFailure(automation);
    if (reconfigurationFailure) {
      return reconfigurationFailure;
    }
    const stripeFailure = await set(validateStripeFeature$, automation, signal);
    signal.throwIfAborted();
    if (stripeFailure) {
      return stripeFailure;
    }
    const now = nowDate();
    const nextRunAt =
      automation.kind === "schedule"
        ? resolveNextRunAt(
            rowToSchedule(automation),
            true,
            now,
            automation.lastRunAt,
          )
        : automation.nextRunAt;
    if (supportedGithubEventType(automation.eventType)) {
      const failure = await set(
        ensureEventAutomationCanBeEnabled$,
        {
          orgId: args.orgId,
          member: args.member,
          automation,
        },
        signal,
      );
      signal.throwIfAborted();
      if (failure) {
        return failure;
      }
    }
    const morningBriefRow = await set(
      persistMorningBriefAutomationToggle$,
      {
        automation,
        enabled: true,
        nextRunAt,
        now,
        inheritedAutonomyBudget: args.inheritedAutonomyBudget,
        useDurableChoice: args.allowReservedOfficialMaterialization === true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (morningBriefRow !== undefined) {
      return await finalizeAndPublishEnabledWorkflowAutomation(
        set(writeDb$),
        {
          previousAutomation: automation,
          enabledAutomation: morningBriefRow,
          memberUserId: args.member.userId,
        },
        signal,
      );
    }
    return await set(
      persistAndReconcileEnabledWorkflowAutomation$,
      {
        automation,
        orgId: args.orgId,
        memberUserId: args.member.userId,
        nextRunAt,
        now,
        inheritedAutonomyBudget: args.inheritedAutonomyBudget,
      },
      signal,
    );
  },
);
const persistDisabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly nextRunAt: Date | null;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<AutomationRow | undefined> => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(workflowAutomations)
        .set({
          enabled: false,
          nextRunAt: args.nextRunAt,
          updatedAt: args.now,
          ...(args.automation.officialBlueprintKey === null
            ? {}
            : { officialIntendedEnabled: false }),
        })
        .where(officialAutomationLifecycleCondition(args.automation))
        .returning(workflowAutomationColumns());
      if (row?.eventType === "google-forms-response-submitted") {
        // A user stop ends this delivery interval. Re-enable establishes a new
        // baseline; a reconciliation pause never calls this command.
        await tx
          .delete(googleFormsAutomationCursors)
          .where(eq(googleFormsAutomationCursors.automationId, row.id));
      }
      signal.throwIfAborted();
      return row;
    });
  },
);

export const disableWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const reconfigurationFailure = officialAutomationReconfigurationFailure(
      owned.automation,
    );
    if (reconfigurationFailure) {
      return reconfigurationFailure;
    }
    const now = nowDate();
    const nextRunAt =
      owned.automation.kind === "schedule" ? null : owned.automation.nextRunAt;
    const morningBriefRow = await set(
      persistMorningBriefAutomationToggle$,
      {
        automation: owned.automation,
        enabled: false,
        nextRunAt,
        now,
      },
      signal,
    );
    signal.throwIfAborted();
    const ordinaryRow =
      morningBriefRow === undefined
        ? await set(
            persistDisabledWorkflowAutomation$,
            { automation: owned.automation, nextRunAt, now },
            signal,
          )
        : undefined;
    const row = morningBriefRow ?? ordinaryRow;
    signal.throwIfAborted();
    if (!row) {
      if (owned.automation.officialBlueprintKey !== null) {
        return {
          kind: "conflict",
          message: OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
        };
      }
      throw new Error("Failed to disable workflow automation");
    }
    if (supportedNotionEventType(row.eventType)) {
      await invalidateNotionPendingEventsForAutomation(writeDb, row.id);
      signal.throwIfAborted();
    }
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: [owned.automation],
      },
      signal,
    );
    signal.throwIfAborted();
    const chatThreadId = await loadWorkflowUserAutomationThreadId(writeDb, {
      orgId: row.orgId,
      userId: row.ownerUserId,
      workflowId: row.workflowId,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return {
      kind: "ok",
      summary: await rowToSummary(writeDb, row, { chatThreadId }),
    };
  },
);
