import {
  workflowAutomationSnapshot,
  workflowAutomationSnapshotColumns,
} from "./workflow-automation-snapshot";
import { revokeDeletedWorkflowAutomationInputs$ } from "./workflow-automation-queue-revocation.service";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { parseRawRows } from "../../lib/db-raw-rows";
import * as z from "zod";
import { randomUUID } from "node:crypto";
import {
  chatThreadEventInsertPlan,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";

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
  type WebhookReceivedEventConfig,
  type WorkflowAutomationEventType,
  type WorkflowAutomationsListEntry,
  type WorkflowAutomationSummary,
  type WorkflowSchedule,
  type WorkflowWebhookSecretResponse,
} from "@okouai/api-contracts/contracts/workflows";
import { parseScheduledAtTime } from "@okouai/core/timezone";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import {
  officialWorkflowAutomationIdentities,
  workflows,
  workflowUserAutomationThreads,
  workflowWebhookAutomations,
  type WorkflowAutomationEventConfig,
  type WorkflowScheduleType,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  gte,
  exists,
  notExists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  pgBooleanDecoder,
  pgNullDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import {
  bestEffort,
  isValidTimeZone,
  onRejection,
  safeSync,
  settle,
} from "../utils";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { parseGithubWebhookAutomationConfig } from "./github-webhook-automation-config";
import {
  readGmailAutomationConnectorId$,
  gmailSelectedAccountCondition,
} from "./gmail-automation-account.service";
import {
  hasEnabledGmailConsumer$,
  resolveGmailLabelForUser$,
  ensureGmailWatchForUser$,
} from "./gmail-automation-watch.service";
import { readGoogleCalendarAutomationConnectorId$ } from "./google-calendar-automation-account.service";
import {
  normalizeGoogleCalendarId,
  normalizeGoogleCalendarIdForConnector$,
  reconcileGoogleCalendarWatchTarget$,
  releaseStagedGoogleCalendarWatchTarget$,
  ensureGoogleCalendarWatchForUser$,
  hasEnabledGoogleCalendarConsumer$,
  stageGoogleCalendarWatchTargetForReconfiguration$,
  type StagedGoogleCalendarWatchTarget,
} from "./google-calendar-automation-watch.service";
import {
  readGoogleFormsActivationAccount$,
  prepareGoogleFormsResponseEventConfigForPersist$,
  ensureGoogleFormsWatchForUser$,
  reprojectGoogleFormsAutomationOwnership$,
  hasEnabledGoogleFormsConsumer$,
} from "./google-forms-automation-watch.service";
import {
  ensureGoogleMeetTranscriptGeneratedSubscriptionForUser$,
  hasEnabledGoogleMeetConsumer$,
} from "./google-meet-automation-watch.service";
import { persistMorningBriefAutomationToggle$ } from "./morning-brief-automation-toggle.service";
import { officialAutomationLifecycleCondition } from "./workflow-automation-write-condition";
import { notionConfigWithConnectorId } from "./notion-automation-account.service";
import {
  prepareNotionChildPageEventConfigForPersist$,
  prepareNotionDatabaseItemEventConfigForPersist$,
  prepareNotionPageContentUpdatedEventConfigForPersist$,
  validateNotionEventConfigForConnector$,
} from "./notion-automation-preparation.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import { readAcceptedOfficialWorkflowCatalog$ } from "./official-workflow-catalog-read.service";
import {
  OFFICIAL_WORKFLOW_AUTOMATION_READ_ONLY_MESSAGE,
  OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
} from "./official-workflow-constants";
import { orgPlanCapabilitiesFromRow } from "./org-plan-entitlement-read.service";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  prepareChatThreadInsert,
  createdChatThreadFromRow,
} from "./chat-thread-create.service";
import { calculateNextRun } from "./time-automation";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "./workflow-automation-account-classification.service";
import {
  visibleWorkflowCondition,
  workflowSummary,
  type WorkflowMember,
} from "./workflow-data.service";
import {
  prepareWorkflowUserAutomationThread$,
  type WorkflowThreadPreparation,
  workflowUserAutomationThreadOwnerCondition,
  preparedWorkflowThreadValues,
  workflowThreadInsertFromBindingSql,
} from "./workflow-user-automation-thread.service";
import {
  buildWorkflowWebhookSummaryFields$,
  workflowWebhookSummaryFields,
  defaultWebhookReceivedEventConfig,
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
  revealWorkflowWebhookSecretFields$,
} from "./workflow-webhook-automation-config.service";

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
type AutomationActionFailure = Exclude<
  AutomationResult,
  | {
      readonly kind: "ok";
    }
  | {
      readonly kind: "deleted";
    }
>;
export type WorkflowAutomationRunNowResult =
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

const resolveAutomationChatThreadId$ = command(
  async (
    { set },
    row: AutomationRow,
    options: RowToSummaryOptions,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if ("chatThreadId" in options) {
      return options.chatThreadId ?? null;
    }
    return await set(
      readAutomationChatThreadId$,
      {
        orgId: row.orgId,
        userId: row.ownerUserId,
        workflowId: row.workflowId,
      },
      signal,
    );
  },
);

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

const loadGoogleCalendarAutomationWarning$ = command(
  async (
    { get },
    row: AutomationRow,
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchActionRequiredReason | undefined> => {
    const db = get(db$);

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
    signal.throwIfAborted();
    return googleCalendarWarningFromState(state);
  },
);

const rowToSummary$ = command(
  async (
    { set },
    row: AutomationRow,
    options: RowToSummaryOptions,
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const chatThreadId = await set(
      resolveAutomationChatThreadId$,
      row,
      options,
      signal,
    );
    signal.throwIfAborted();
    if (row.kind === "event") {
      if (row.eventType === "webhook-received") {
        return {
          ...rowSummaryBase(row, chatThreadId),
          kind: "event",
          eventType: "webhook-received",
          eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
          schedule: null,
          scheduleSummary: null,
          ...(await set(
            buildWorkflowWebhookSummaryFields$,
            {
              automation: row,
              ...options,
            },
            signal,
          )),
        };
      }
      const eventSummary = eventRowToSummary(row, chatThreadId, {
        googleCalendar: await set(
          loadGoogleCalendarAutomationWarning$,
          row,
          signal,
        ),
        googleForms: options.warning,
      });
      signal.throwIfAborted();
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
  },
);
const rowToPublicSummary$ = command(
  async (
    { set },
    row: AutomationRow,
    options: {
      readonly chatThreadId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary | null> => {
    if (row.kind === "event" && !supportedAutomationEventType(row.eventType)) {
      return null;
    }
    return await set(rowToSummary$, row, options, signal);
  },
);

const readAutomationVisibleWorkflow$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflowId: string;
      readonly includeInstallingOfficial?: boolean;
    },
    signal: AbortSignal,
  ): Promise<{
    workflow: WorkflowRow;
    agent: {
      readonly id: string;
      readonly orgId: string;
      readonly owner: string;
      readonly visibility: "public" | "private";
      readonly name: string;
      readonly displayName: string | null;
    };
  } | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        workflow: workflows,
        agent: {
          id: agents.id,
          orgId: agents.orgId,
          owner: agents.owner,
          visibility: agents.visibility,
          name: agents.name,
          displayName: agents.displayName,
        },
      })
      .from(workflows)
      .innerJoin(agents, eq(workflows.agentId, agents.id))
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          eq(workflows.id, args.workflowId),
          args.includeInstallingOfficial
            ? or(
                visibleWorkflowCondition(args.member),
                and(
                  eq(workflows.ownerUserId, args.member.userId),
                  eq(workflows.officialInstallationState, "installing"),
                ),
              )
            : visibleWorkflowCondition(args.member),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!row) {
      return null;
    }
    return { workflow: row.workflow, agent: row.agent };
  },
);

const readAutomationChatThreadId$ = command(
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
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(workflowUserAutomationThreadOwnerCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return binding?.chatThreadId ?? null;
  },
);

interface UsableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}
export const loadAgent$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<UsableAgent | null> => {
    const db = get(db$);

    const [agent] = await db
      .select({
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
      .limit(1);
    signal.throwIfAborted();
    return agent ?? null;
  },
);

/**
 * An automation run executes as its owner, so the owner must be able to run the
 * workflow's owning agent: public agents are runnable by any member, private
 * agents only by their owner. This is a "use" gate, not the agent "manage" gate.
 */
export function canUseAgent(
  agent: UsableAgent,
  member: WorkflowMember,
): boolean {
  return agent.visibility === "public" || agent.owner === member.userId;
}
export const loadAutomationWorkflowRunTarget$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly agentId: string;
    readonly workflowName: string;
    readonly workflowTitle: string;
  } | null> => {
    const db = get(db$);

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
    signal.throwIfAborted();
    if (!workflow) {
      return null;
    }
    return {
      agentId: workflow.agentId,
      workflowName: workflow.workflowName,
      workflowTitle: workflow.workflowDisplayName ?? workflow.workflowName,
    };
  },
);
const loadAutomationRow$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly automationId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationRow | null> => {
    const db = get(db$);

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
    signal.throwIfAborted();
    return row ?? null;
  },
);

export const loadAutomationOwnerTimezone$ = command(
  async (
    { get },
    automation: AutomationRow,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);

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
    signal.throwIfAborted();
    return row?.timezone ?? null;
  },
);

/**
 * List the caller's own workflow automations under a workflow. Detail pages show
 * only the automations the caller owns, so this filters by `ownerUserId`.
 * Visibility of the workflow itself is the caller's responsibility (the workflow
 * must already be resolved as visible).
 */
export const loadWorkflowAutomations$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly workflowId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly WorkflowAutomationSummary[]> => {
    const db = get(db$);

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
    signal.throwIfAborted();
    const chatThreadId = await set(
      readAutomationChatThreadId$,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    const summaries = await Promise.all(
      rows.map((row) => {
        return set(rowToPublicSummary$, row, { chatThreadId }, signal);
      }),
    );
    signal.throwIfAborted();
    return summaries.flatMap((summary) => {
      return summary ? [summary] : [];
    });
  },
);

/**
 * List the caller's workflow automations across every visible workflow in one
 * lightweight projection. This deliberately avoids workflow detail loading, so
 * it does not read workflow volume files from R2.
 */
export const listWorkspaceWorkflowAutomations$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
    },
    signal: AbortSignal,
  ): Promise<readonly WorkflowAutomationsListEntry[]> => {
    const db = get(db$);

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
    signal.throwIfAborted();

    const hasOfficialWorkflow = rows.some((row) => {
      return row.workflow.officialDefinitionName !== null;
    });
    const acceptedCatalog = hasOfficialWorkflow
      ? await set(readAcceptedOfficialWorkflowCatalog$, signal)
      : null;
    signal.throwIfAborted();
    const officialLifecycleByName = new Map(
      acceptedCatalog?.payload.definitions.map((definition) => {
        return [definition.name, definition.lifecycle] as const;
      }) ?? [],
    );

    const entries = await Promise.all(
      rows.map(async (row): Promise<WorkflowAutomationsListEntry | null> => {
        const automation = await set(
          rowToPublicSummary$,
          row.automation,
          {
            chatThreadId: row.chatThreadId ?? null,
          },
          signal,
        );
        signal.throwIfAborted();
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
    signal.throwIfAborted();
    return entries.flatMap((entry) => {
      return entry ? [entry] : [];
    });
  },
);

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
export const listThreadBoundWorkflowAutomations$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly ChatThreadWorkflowAutomation[]> => {
    const db = get(db$);

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
    signal.throwIfAborted();

    const summaries = await Promise.all(
      rows.map(async ({ automation, workflow, chatThreadId }) => {
        const summary = await set(
          rowToPublicSummary$,
          automation,
          {
            chatThreadId,
          },
          signal,
        );
        signal.throwIfAborted();
        return { workflow, summary, chatThreadId };
      }),
    );
    signal.throwIfAborted();

    return summaries.flatMap((summary) => {
      return chatThreadAutomationFromSummary(summary);
    });
  },
);

/**
 * Load a single automation if its workflow is visible to the caller. Read-only;
 * does not require ownership.
 */
export const getWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automationId: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary | null> => {
    const automation = await set(
      loadAutomationRow$,
      {
        orgId: args.orgId,
        automationId: args.automationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!automation) {
      return null;
    }
    const visible = await set(
      readAutomationVisibleWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        workflowId: automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!visible) {
      return null;
    }
    return await set(rowToPublicSummary$, automation, {}, signal);
  },
);

export const revealWorkflowWebhookSecret$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automationId: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowWebhookSecretResponse | null> => {
    const automation = await set(
      loadAutomationRow$,
      {
        orgId: args.orgId,
        automationId: args.automationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      !automation ||
      automation.kind !== "event" ||
      automation.eventType !== "webhook-received" ||
      automation.ownerUserId !== args.member.userId
    ) {
      return null;
    }
    const visible = await set(
      readAutomationVisibleWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        workflowId: automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!visible) {
      return null;
    }
    return await set(
      revealWorkflowWebhookSecretFields$,
      { automation },
      signal,
    );
  },
);

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
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly connectorSlug: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(rawSqlReadDb$);
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
    hidden: values.hidden,
    modelSettings: values.modelSettings,
    cloudBrowserEnabled: values.cloudBrowserEnabled,
    serviceTier: chatThreadServiceTierFromCodex(values.codexServiceTier),
    createdAt: values.createdAt,
  };
}

interface CreatedEventAutomation {
  readonly summary: WorkflowAutomationSummary;
}

function createdEventAutomationReceipt(
  row: AutomationRow,
  chatThreadId: string,
  warning: GoogleCalendarWatchActionRequiredReason | undefined,
): CreatedEventAutomation {
  const summary = eventRowToSummary(row, chatThreadId, {
    googleCalendar: warning,
  });
  if (!summary) {
    throw new Error("Unsupported created workflow automation event");
  }
  return { summary };
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

function eventAutomationThreadBinding(
  owner: ReturnType<typeof eventAutomationThreadOwner>,
  values: ReturnType<typeof preparedWorkflowThreadValues>,
  args: InsertEventAutomationArgs,
) {
  return {
    orgId: owner.orgId,
    userId: owner.userId,
    workflowId: owner.workflowId,
    chatThreadId: values.id,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

function eventAutomationBindingConflict(
  values: ReturnType<typeof preparedWorkflowThreadValues>,
  args: InsertEventAutomationArgs,
) {
  return {
    target: [
      workflowUserAutomationThreads.orgId,
      workflowUserAutomationThreads.userId,
      workflowUserAutomationThreads.workflowId,
    ],
    set: {
      chatThreadId: sql`coalesce(${workflowUserAutomationThreads.chatThreadId}, ${sql.param(values.id, workflowUserAutomationThreads.chatThreadId)})`,
      updatedAt: args.currentTime,
    },
  };
}

function eventAutomationReturning() {
  const snapshot = workflowAutomationSnapshotColumns();
  return {
    ...workflowAutomationColumns(),
    observedUpdatedAt: snapshot.observedUpdatedAt.as("observed_updated_at"),
    observedXmin: snapshot.observedXmin.as("observed_xmin"),
    chatThreadId: sql`(SELECT chat_thread_id FROM accepted_binding)`
      .mapWith(workflowUserAutomationThreads.chatThreadId)
      .as("bound_chat_thread_id"),
  };
}

function eventAutomationCalendarWarningWhere(
  owner: ReturnType<typeof eventAutomationThreadOwner>,
  eventConnectorId: string,
  calendarId: string,
) {
  return and(
    eq(googleCalendarWatchStates.orgId, owner.orgId),
    eq(googleCalendarWatchStates.userId, owner.userId),
    eq(googleCalendarWatchStates.connectorId, eventConnectorId),
    eq(googleCalendarWatchStates.calendarId, calendarId),
  );
}

/** An account write lost the race with deletion of the referenced account. */
function isAutomationEventConnectorMissing(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint ===
      "workflow_automations_event_connector_id_connectors_id_fk"
  );
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
    const inserted = await settle(
      (async () => {
        let eventConnectorId: string | null = null;
        if (connectorSlug !== null) {
          const [selected] = parseRawRows(
            z.object({ connectorId: z.string().nullable() }),
            await db.execute(
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
        if (
          automationCreateInputIsGoogleForms(args.input) &&
          eventConnectorId !== args.input.eventConfig.connectorId
        ) {
          throw new GoogleFormsAccountSelectionChangedError();
        }
        let warning: GoogleCalendarWatchActionRequiredReason | undefined;
        if (
          automationCreateInputIsGoogleCalendar(args.input) &&
          eventConnectorId !== null
        ) {
          const calendarId = parseGoogleCalendarEventConfig(
            args.input.eventType,
            args.input.eventConfig,
          ).calendarId;
          const [state] = await db
            .select({
              reason: googleCalendarWatchStates.actionRequiredReason,
              startedAt: googleCalendarWatchStates.actionRequiredAt,
            })
            .from(googleCalendarWatchStates)
            .where(
              eventAutomationCalendarWarningWhere(
                owner,
                eventConnectorId,
                calendarId,
              ),
            )
            .limit(1);
          warning = googleCalendarWarningFromState(state);
        }
        const values = preparedWorkflowThreadValues(
          owner,
          args.threadPreparation,
          randomUUID(),
        );
        const binding = db.$with("accepted_binding").as(
          db
            .insert(workflowUserAutomationThreads)
            .values(eventAutomationThreadBinding(owner, values, args))
            .onConflictDoUpdate(eventAutomationBindingConflict(values, args))
            .returning({
              chatThreadId: workflowUserAutomationThreads.chatThreadId,
            }),
        );
        const thread = db
          .$with("inserted_thread", {
            id: chatThreads.id,
            agentId: chatThreads.agentId,
          })
          .as(workflowThreadInsertFromBindingSql(values, values.id));
        const event = chatThreadEventInsertPlan(
          workflowThreadCreatedEventValues(owner, values),
          {
            gate: sql`EXISTS (SELECT 1 FROM inserted_thread)`,
            agentId: sql`(SELECT agent_id FROM inserted_thread)`,
          },
        );
        const reserved = db
          .$with("reserved", {
            lastSeqId: chatThreadEventSequences.lastSeqId,
          })
          .as(event.reservation);
        const createdEvent = db
          .$with("inserted_thread_event", { id: chatThreadEvents.id })
          .as(event.insertion);
        const automation = db.$with("inserted_event_automation").as(
          db
            .insert(workflowAutomations)
            .values({
              ...preparedEventAutomationValues(args, eventConnectorId),
              workflowId: sql`(SELECT ${sql.param(args.workflowId, workflowAutomations.workflowId)}::uuid
                FROM accepted_binding
                CROSS JOIN (SELECT count(*) FROM inserted_thread_event) AS event_completion)`,
            })
            .returning(eventAutomationReturning()),
        );
        const [row] = await db
          .with(binding, thread, reserved, createdEvent, automation)
          .select()
          .from(automation);
        if (!row || !row.chatThreadId) {
          throw new Error("Failed to create workflow automation");
        }
        return createdEventAutomationReceipt(row, row.chatThreadId, warning);
      })(),
    );
    if (inserted.ok) {
      return inserted.value;
    }
    // The whole publication statement has rolled back. The account was deleted
    // after it was read: report the changed account like an expectation miss.
    if (!isAutomationEventConnectorMissing(inserted.error)) {
      throw inserted.error;
    }
    if (automationCreateInputIsGoogleForms(args.input)) {
      throw new GoogleFormsAccountSelectionChangedError();
    }
    return null;
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

interface WebhookAutomationCreateArgs {
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly input: CreateWebhookEventAutomationInput;
  readonly workflowId: string;
  readonly agentId: string;
  readonly automationId?: string;
  readonly currentTime: Date;
}

function webhookTierCapabilityColumns() {
  return {
    planKey: orgPlanEntitlements.planKey,
    status: orgPlanEntitlements.status,
    baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
    canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
    canBuyCredits: orgPlanEntitlements.canBuyCredits,
    showUsagePack: orgPlanEntitlements.showUsagePack,
    autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
    restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
    workflowWebhookAutomationAllowed:
      orgPlanEntitlements.workflowWebhookTriggerAllowed,
    audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
    audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
    audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
  };
}

function webhookCreationAccessFailure(
  args: WebhookAutomationCreateArgs,
  agent: UsableAgent | undefined,
  workflow: WorkflowRow | undefined,
): AutomationActionFailure | null {
  if (!agent || !workflow || workflow.agentId !== agent.id) {
    return { kind: "not-found" };
  }
  const official = args.input.officialInstallation;
  const owned = workflow.ownerUserId === args.input.member.userId;
  const available =
    workflow.officialDefinitionName === null ||
    workflow.officialInstallationState === "installed";
  const visible =
    owned ||
    (workflow.visibility === "public" && canUseAgent(agent, args.input.member));
  const installing =
    official !== undefined &&
    owned &&
    workflow.officialInstallationState === "installing";
  if (!(available && visible) && !installing) {
    return { kind: "not-found" };
  }
  if (
    official !== undefined &&
    (workflow.officialDefinitionName !== official.definitionName ||
      workflow.officialInstallationState !==
        (official.installationState ?? "installing") ||
      !owned)
  ) {
    return { kind: "not-found" };
  }
  if (workflow.officialDefinitionName !== null && official === undefined) {
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
  return null;
}

function automationThreadInsertPlan(args: {
  readonly input: {
    readonly orgId: string;
    readonly member: Pick<WorkflowMember, "userId">;
  };
  readonly agentId: string;
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly currentTime: Date;
}) {
  const pin = args.threadPreparation.initialModel;
  return prepareChatThreadInsert({
    orgId: args.input.orgId,
    userId: args.input.member.userId,
    agentId: args.agentId,
    title: args.threadPreparation.title,
    hidden: args.threadPreparation.hidden,
    modelSettings: args.threadPreparation.modelSettings,
    cloudBrowserEnabled: args.threadPreparation.cloudBrowserEnabled,
    selectedModel: pin.selectedModel,
    codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
}

function webhookAutomationValues(args: WebhookAutomationCreateArgs) {
  return {
    id: args.automationId,
    orgId: args.input.orgId,
    workflowId: args.workflowId,
    ownerUserId: args.input.member.userId,
    kind: "event" as const,
    eventType: args.input.eventType,
    eventConfig: args.input.eventConfig ?? defaultWebhookReceivedEventConfig(),
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

const readWebhookAutomationTierEligible$ = command(
  async ({ get }, orgId: string, signal: AbortSignal): Promise<boolean> => {
    const db = get(db$);
    const [row] = await db
      .select(webhookTierCapabilityColumns())
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    if (row) {
      return orgPlanCapabilitiesFromRow(row, orgId)
        .workflowWebhookAutomationAllowed;
    }
    const [org] = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
    if (org) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return false;
  },
);

function webhookThreadOwner(args: WebhookAutomationCreateArgs) {
  return {
    orgId: args.input.orgId,
    userId: args.input.member.userId,
    workflowId: args.workflowId,
  };
}

function createdWebhookAutomationResult(
  row: AutomationRow,
  chatThreadId: string,
  webhook: typeof workflowWebhookAutomations.$inferSelect | undefined,
  credentials: Awaited<ReturnType<typeof prepareWebhookCredentials>>,
): AutomationResult {
  if (!webhook) {
    throw new Error(`Workflow webhook automation config missing: ${row.id}`);
  }
  return {
    kind: "ok",
    summary: {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "webhook-received",
      eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
      ...workflowWebhookSummaryFields(webhook, {
        webhookToken: credentials.token,
        webhookSecret: credentials.secret,
      }),
    },
  };
}

function webhookCreationAgentColumns() {
  return { id: agents.id, owner: agents.owner, visibility: agents.visibility };
}

function webhookCreationAccessCondition(
  args: WebhookAutomationCreateArgs,
  agent: ReturnType<typeof webhookCreationAdmissionPlan>["agent"],
  workflow: ReturnType<typeof webhookCreationAdmissionPlan>["workflow"],
) {
  const owned = eq(workflow.ownerUserId, args.input.member.userId);
  const usable = or(
    eq(agent.visibility, "public"),
    eq(agent.owner, args.input.member.userId),
  );
  const official = args.input.officialInstallation;
  return and(
    eq(workflow.agentId, agent.id),
    or(
      and(
        or(
          isNull(workflow.officialDefinitionName),
          eq(workflow.officialInstallationState, "installed"),
        ),
        or(owned, and(eq(workflow.visibility, "public"), usable)),
      ),
      official === undefined
        ? sql`false`
        : and(owned, eq(workflow.officialInstallationState, "installing")),
    ),
    official === undefined
      ? isNull(workflow.officialDefinitionName)
      : and(
          owned,
          eq(workflow.officialDefinitionName, official.definitionName),
          eq(
            workflow.officialInstallationState,
            official.installationState ?? "installing",
          ),
        ),
    usable,
  );
}

/** Retain the original entitlement -> agent -> Workflow protection order. */
function webhookCreationAdmissionPlan(args: WebhookAutomationCreateArgs) {
  const query = new QueryBuilder();
  const entitlement = enabledAutomationEntitlementPlan(args.input.orgId, true);
  const agent = query.$with("webhook_creation_agent").as(
    query
      .select(webhookCreationAgentColumns())
      .from(agents)
      .where(
        and(
          eq(agents.id, args.agentId),
          eq(agents.orgId, args.input.orgId),
          entitlement.eligible,
        ),
      )
      .for("share")
      .limit(1),
  );
  const workflow = query.$with("webhook_creation_workflow").as(
    query
      .select(getTableColumns(workflows))
      .from(workflows)
      .where(
        and(
          eq(workflows.id, args.workflowId),
          eq(workflows.orgId, args.input.orgId),
          entitlement.eligible,
          gte(query.select({ total: count() }).from(agent), 0),
        ),
      )
      .for("share")
      .limit(1),
  );
  return { ...entitlement, agent, workflow };
}

function webhookThreadPublicationValues(args: WebhookAutomationCreateArgs) {
  const values = preparedWorkflowThreadValues(
    {
      ...webhookThreadOwner(args),
      agentId: args.agentId,
      workflowTitle: args.threadPreparation.title,
      currentTime: args.currentTime,
    },
    args.threadPreparation,
    randomUUID(),
  );
  const thread = {
    ...values,
    selectedModel: automationThreadInsertPlan(args).values.selectedModel,
  };
  // The prepared preferences are ordinary inputs. Validate before any write.
  createdChatThreadFromRow(
    { ...thread, computerUseHostId: null },
    args.agentId,
  );
  return thread;
}

function webhookBindingSource(
  args: WebhookAutomationCreateArgs,
  threadId: string,
  source: ReturnType<typeof webhookCreationAdmissionPlan>["workflow"],
  agent: ReturnType<typeof webhookCreationAdmissionPlan>["agent"],
) {
  const binding = workflowUserAutomationThreads;
  return new QueryBuilder()
    .select({
      id: sql`gen_random_uuid()`.mapWith(binding.id).as("id"),
      orgId: sql`${sql.param(args.input.orgId, binding.orgId)}`
        .mapWith(binding.orgId)
        .as("org_id"),
      userId: sql`${sql.param(args.input.member.userId, binding.userId)}`
        .mapWith(binding.userId)
        .as("user_id"),
      workflowId: source.id,
      chatThreadId: sql`${sql.param(threadId, binding.chatThreadId)}`
        .mapWith(binding.chatThreadId)
        .as("chat_thread_id"),
      createdAt: sql`${sql.param(args.currentTime, binding.createdAt)}`
        .mapWith(binding.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(args.currentTime, binding.updatedAt)}`
        .mapWith(binding.updatedAt)
        .as("updated_at"),
    })
    .from(source)
    .innerJoin(agent, eq(source.agentId, agent.id))
    .where(webhookCreationAccessCondition(args, agent, source));
}

function webhookBindingConflict(
  args: WebhookAutomationCreateArgs,
  threadId: string,
) {
  const binding = workflowUserAutomationThreads;
  return {
    target: [binding.orgId, binding.userId, binding.workflowId],
    set: {
      chatThreadId: sql`coalesce(${binding.chatThreadId}, ${sql.param(threadId, binding.chatThreadId)})`,
      updatedAt: sql`CASE WHEN ${isNull(binding.chatThreadId)}
        THEN ${sql.param(args.currentTime, binding.updatedAt)} ELSE ${binding.updatedAt} END`,
    },
  };
}

/** INSERT SELECT with omitted schema defaults is not supported by the builder. */
function webhookAutomationPublicationSql(args: WebhookAutomationCreateArgs) {
  const original = webhookAutomationValues(args);
  const values = {
    ...original,
    id: args.automationId ?? randomUUID(),
    eventConfig: webhookReceivedEventConfigSchema.parse(original.eventConfig),
  };
  const columns = getTableColumns(workflowAutomations);
  const entries = (Object.keys(values) as (keyof typeof values)[]).map(
    (key) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(
          "Webhook automation publication contains an undefined value",
        );
      }
      return { column: columns[key], value };
    },
  );
  const names = entries.map(({ column }) => {
    return sql.identifier(column.name);
  });
  const parameters = entries.map(({ column, value }) => {
    return sql.param(value, column);
  });
  return sql`INSERT INTO ${workflowAutomations} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(parameters, sql`, `)} FROM accepted_binding
    CROSS JOIN (SELECT count(*) FROM inserted_thread_event) AS event_completion
    RETURNING *, ${workflowAutomations.updatedAt}::text AS observed_updated_at,
      ${workflowAutomations}.xmin::text AS observed_xmin`;
}

function webhookPublicationColumns() {
  const columns = workflowAutomationColumns();
  return {
    ...columns,
    observedUpdatedAt: columns.observedUpdatedAt.as("observed_updated_at"),
    observedXmin: columns.observedXmin.as("observed_xmin"),
  };
}

function webhookCreationPublicationResult(
  args: WebhookAutomationCreateArgs,
  credentials: Awaited<ReturnType<typeof prepareWebhookCredentials>>,
  result:
    | {
        readonly enable_outcome: {
          readonly eligible: boolean;
          readonly missingEntitlement: boolean;
          readonly invalidRestriction: boolean;
        };
        readonly webhook_creation_agent: UsableAgent | null;
        readonly webhook_creation_workflow: WorkflowRow | null;
        readonly accepted_binding: {
          readonly chatThreadId: string | null;
        } | null;
        readonly inserted_webhook_automation: AutomationRow | null;
        readonly inserted_webhook_config:
          typeof workflowWebhookAutomations.$inferSelect | null;
      }
    | undefined,
): AutomationResult {
  if (!result) {
    throw new Error("Webhook automation publication returned no result");
  }
  const outcome = result.enable_outcome;
  if (outcome.missingEntitlement) {
    throw new Error(`Missing org plan entitlement for ${args.input.orgId}`);
  }
  if (outcome.invalidRestriction) {
    throw new Error(
      `Unexpected NULL restricted_built_in_models for org plan entitlement ${args.input.orgId}`,
    );
  }
  if (!outcome.eligible) {
    return workflowWebhookTeamRequiredResult();
  }
  const failure = webhookCreationAccessFailure(
    args,
    result.webhook_creation_agent ?? undefined,
    result.webhook_creation_workflow ?? undefined,
  );
  if (failure) {
    return failure;
  }
  const row = result.inserted_webhook_automation;
  const threadId = result.accepted_binding?.chatThreadId;
  if (!row || !threadId) {
    throw new Error("Failed to create workflow automation");
  }
  return createdWebhookAutomationResult(
    row,
    threadId,
    result.inserted_webhook_config ?? undefined,
    credentials,
  );
}

/** Publish the binding, optional thread/event, automation and signed configuration together. */
const commitWebhookEventAutomation$ = command(
  async (
    { set },
    args: WebhookAutomationCreateArgs,
    credentials: Awaited<ReturnType<typeof prepareWebhookCredentials>>,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const db = set(writeDb$);
    const plan = webhookCreationAdmissionPlan(args);
    const values = webhookThreadPublicationValues(args);
    const binding = db.$with("accepted_binding").as(
      db
        .insert(workflowUserAutomationThreads)
        .select(
          webhookBindingSource(args, values.id, plan.workflow, plan.agent),
        )
        .onConflictDoUpdate(webhookBindingConflict(args, values.id))
        .returning({
          chatThreadId: workflowUserAutomationThreads.chatThreadId,
        }),
    );
    const thread = db
      .$with("inserted_thread", {
        id: chatThreads.id,
        agentId: chatThreads.agentId,
      })
      .as(workflowThreadInsertFromBindingSql(values, values.id));
    const event = chatThreadEventInsertPlan(
      workflowThreadCreatedEventValues(
        {
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          agentId: args.agentId,
        },
        values,
      ),
      {
        gate: sql`EXISTS (SELECT 1 FROM inserted_thread)`,
        agentId: sql`(SELECT agent_id FROM inserted_thread)`,
      },
    );
    const reserved = db
      .$with("reserved", { lastSeqId: chatThreadEventSequences.lastSeqId })
      .as(event.reservation);
    const createdEvent = db
      .$with("inserted_thread_event", { id: chatThreadEvents.id })
      .as(event.insertion);
    const automation = db
      .$with("inserted_webhook_automation", webhookPublicationColumns())
      .as(webhookAutomationPublicationSql(args));
    const config = workflowWebhookAutomations;
    const signed = db.$with("inserted_webhook_config").as(
      db
        .insert(config)
        .select(
          db
            .select({
              automationId: automation.id,
              tokenHash:
                sql`${sql.param(credentials.row.tokenHash, config.tokenHash)}`
                  .mapWith(config.tokenHash)
                  .as("token_hash"),
              encryptedToken:
                sql`${sql.param(credentials.row.encryptedToken, config.encryptedToken)}`
                  .mapWith(config.encryptedToken)
                  .as("encrypted_token"),
              encryptedSecret:
                sql`${sql.param(credentials.row.encryptedSecret, config.encryptedSecret)}`
                  .mapWith(config.encryptedSecret)
                  .as("encrypted_secret"),
              secretLastFour:
                sql`${sql.param(credentials.row.secretLastFour, config.secretLastFour)}`
                  .mapWith(config.secretLastFour)
                  .as("secret_last_four"),
              disabledReason: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("disabled_reason"),
              lastReceivedAt: sql`NULL`
                .mapWith(pgNullDecoder)
                .as("last_received_at"),
              createdAt: sql`${sql.param(args.currentTime, config.createdAt)}`
                .mapWith(config.createdAt)
                .as("created_at"),
              updatedAt: sql`${sql.param(args.currentTime, config.updatedAt)}`
                .mapWith(config.updatedAt)
                .as("updated_at"),
            })
            .from(automation),
        )
        .returning(),
    );
    signal.throwIfAborted();
    const [result] = await db
      .with(
        plan.entitlement,
        plan.missingEntitlementOrg,
        plan.agent,
        plan.workflow,
        binding,
        thread,
        reserved,
        createdEvent,
        automation,
        signed,
      )
      .select()
      .from(plan.outcome)
      .leftJoin(plan.agent, sql`true`)
      .leftJoin(plan.workflow, sql`true`)
      .leftJoin(binding, sql`true`)
      .leftJoin(automation, sql`true`)
      .leftJoin(signed, sql`true`);
    signal.throwIfAborted();
    return webhookCreationPublicationResult(args, credentials, result);
  },
);
const insertWebhookEventAutomation$ = command(
  async (
    { set },
    args: WebhookAutomationCreateArgs,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const tierEligible = await set(
      readWebhookAutomationTierEligible$,
      args.input.orgId,
      signal,
    );
    if (!tierEligible) {
      return workflowWebhookTeamRequiredResult();
    }
    // KMS can stall independently of PostgreSQL; prepare before taking any locks.
    const credentials = await prepareWebhookCredentials(
      { orgId: args.input.orgId, userId: args.input.member.userId },
      signal,
    );
    return await set(commitWebhookEventAutomation$, args, credentials, signal);
  },
);

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
    if (created === null) {
      return {
        kind: "bad-request",
        message: "Gmail account selection changed; retry adding the automation",
      };
    }
    const { summary } = created;
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
    // The INSERT snapshot also reads an existing destination. No empty thread
    // is materialized; the first run still creates one when absent.
    const bindingThreadId = db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        workflowUserAutomationThreadOwnerCondition({
          orgId: args.input.orgId,
          userId: args.input.member.userId,
          workflowId: args.workflowId,
        }),
      )
      .limit(1);
    const [row] = await db
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
      .returning({
        ...workflowAutomationColumns(),
        chatThreadId: sql`(${bindingThreadId})`.mapWith(
          workflowUserAutomationThreads.chatThreadId,
        ),
      });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to create workflow automation");
    }
    const schedule = rowToSchedule(row);
    return {
      ...rowSummaryBase(row, row.chatThreadId),
      kind: "schedule" as const,
      schedule,
      scheduleSummary: summarizeSchedule(schedule),
    };
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
    const result = await set(
      insertWebhookEventAutomation$,
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
    { get, set },
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
    const db = get(db$);
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
    { get, set },
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
    const db = get(db$);
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
  async ({ set }, args: { readonly automationId: string }): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automationId));
  },
);
const cleanFailedGoogleFormsAutomation$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
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
    const { summary } = requireCreatedEventAutomation(inserted.value);
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
          seedCursor: prepared.seedCursor,
        },
        signal,
      ),
      async () => {
        await set(deleteUnpublishedGoogleFormsAutomation$, {
          automationId: summary.id,
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
    const preparedConfig = googleMeetTranscriptGeneratedEventConfigSchema.parse(
      args.input.eventConfig,
    );
    const connectorId = await set(
      readEventAutomationConnectorId$,
      {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
        workflowId: args.context.workflowId,
        connectorSlug: "google-meet",
      },
      signal,
    );
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
      set(
        ensureGoogleMeetTranscriptGeneratedSubscriptionForUser$,
        {
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
const createChatRunFinishedEventAutomationForWorkflow$ = command(
  async (
    { get, set },
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
    const db = get(db$);
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
    updatedAt: at,
  };
}

/** Preserve schema decoding and the exact snapshot strings through the CTE. */
function attachedOfficialAutomationColumns() {
  const automation = alias(workflowAutomations, "official_metadata_updated");
  return {
    ...getTableColumns(automation),
    observedUpdatedAt: sql`${automation.updatedAt}::text`.mapWith(
      pgTextDecoder,
    ),
    observedXmin: sql`${automation}.${sql.identifier("observedXmin")}`.mapWith(
      pgTextDecoder,
    ),
  };
}

function officialMetadataReservationCondition(
  metadata: OfficialAutomationCreationMetadata,
  identityComplete: boolean,
) {
  const plain = alias(workflowAutomations, "official_metadata_plain");
  const reservation = alias(
    officialWorkflowAutomationIdentities,
    "official_metadata_reservation",
  );
  // JSONB normalizes negative zero, while the former strict JS comparison
  // rejected it. Binding values are schema-validated scalar primitives.
  const bindingsComparable = !metadata.parameterBindings.some((binding) => {
    return Object.is(binding.value, -0);
  });
  return and(
    sql`${identityComplete && bindingsComparable}`,
    eq(plain.enabled, false),
    eq(reservation.retainedAppliedFingerprint, metadata.appliedFingerprint),
    eq(reservation.retainedParameterBindings, [...metadata.parameterBindings]),
    eq(reservation.retainedIntendedEnabled, metadata.intendedEnabled ?? true),
  );
}

function activeOfficialAutomationIdentityColumns(
  metadata: OfficialAutomationCreationMetadata,
  at: Date,
) {
  const updated = alias(workflowAutomations, "official_metadata_updated");
  const identities = officialWorkflowAutomationIdentities;
  return {
    id: updated.id,
    workflowId: updated.workflowId,
    automationId: updated.id,
    blueprintKey: sql`${metadata.blueprintKey}`
      .mapWith(identities.blueprintKey)
      .as("blueprint_key"),
    state: sql`'active'`.mapWith(identities.state).as("state"),
    retainedParameterBindings: sql`NULL`
      .mapWith(pgNullDecoder)
      .as("retained_parameter_bindings"),
    retainedIntendedEnabled: sql`NULL`
      .mapWith(pgNullDecoder)
      .as("retained_intended_enabled"),
    retainedAppliedFingerprint: sql`NULL`
      .mapWith(pgNullDecoder)
      .as("retained_applied_fingerprint"),
    createdAt: sql`${sql.param(at, identities.createdAt)}`
      .mapWith(identities.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(at, identities.updatedAt)}`
      .mapWith(identities.updatedAt)
      .as("updated_at"),
  };
}

function activeOfficialAutomationIdentityUpdate(
  automationId: string,
  at: Date,
) {
  return {
    automationId,
    state: "active" as const,
    retainedParameterBindings: null,
    retainedIntendedEnabled: null,
    retainedAppliedFingerprint: null,
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
    const staged = metadata.stagedMaterialization === true;
    const identityComplete = metadata.automationId === automationId;
    const identities = officialWorkflowAutomationIdentities;
    const plain = db
      .$with("official_metadata_plain")
      .as(
        db
          .select()
          .from(workflowAutomations)
          .where(plainOfficialAutomationWhere(automationId))
          .for("update")
          .limit(1),
      );
    // Retain the existing automation -> reservation lock order. Only a valid
    // disabled staged automation proceeds to the existing reservation lock.
    const reservation = db.$with("official_metadata_reservation").as(
      db
        .select({
          id: identities.id,
          retainedAppliedFingerprint: identities.retainedAppliedFingerprint,
          retainedParameterBindings: identities.retainedParameterBindings,
          retainedIntendedEnabled: identities.retainedIntendedEnabled,
        })
        .from(identities)
        .innerJoin(plain, eq(plain.workflowId, identities.workflowId))
        .where(
          and(
            sql`${staged && identityComplete}`,
            eq(plain.enabled, false),
            eq(identities.id, automationId),
            eq(identities.blueprintKey, metadata.blueprintKey),
            eq(identities.state, "reconciling"),
            isNull(identities.automationId),
          ),
        )
        .for("update", { of: identities })
        .limit(1),
    );
    const admitted = db.$with("official_metadata_admitted").as(
      db
        .select({ id: plain.id, updatedAt: plain.updatedAt })
        .from(plain)
        .leftJoin(reservation, eq(reservation.id, plain.id))
        .where(
          staged
            ? officialMetadataReservationCondition(metadata, identityComplete)
            : sql`true`,
        ),
    );
    // One application timestamp owns both writes. Sampling before the statement
    // can precede a competing writer's timestamp after waiting for its lock.
    const at = nowDate();
    const columns = workflowAutomationColumns();
    const updated = db.$with("official_metadata_updated").as(
      db
        .update(workflowAutomations)
        .set(officialAutomationMetadataValues(metadata, at))
        .from(admitted)
        .where(
          and(
            eq(workflowAutomations.id, admitted.id),
            // Preserve the old Date-encoded CAS rejection of submillisecond
            // preimages before either write can commit.
            eq(
              admitted.updatedAt,
              sql`date_trunc('milliseconds', ${admitted.updatedAt})`,
            ),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    const activeIdentity = db.$with("official_metadata_active_identity").as(
      db
        .insert(identities)
        .select(
          db
            .select(activeOfficialAutomationIdentityColumns(metadata, at))
            .from(updated)
            .where(sql`${!staged}`),
        )
        .onConflictDoUpdate({
          target: [identities.workflowId, identities.blueprintKey],
          set: activeOfficialAutomationIdentityUpdate(automationId, at),
        })
        .returning({ id: identities.id }),
    );
    const result = await (async () => {
      const [row] = await db
        .with(plain, reservation, admitted, updated, activeIdentity)
        .select({
          plainId: plain.id,
          plainEnabled: plain.enabled,
          admittedId: admitted.id,
          row: attachedOfficialAutomationColumns(),
          identityId: activeIdentity.id,
        })
        .from(sql`(SELECT 1) AS metadata_result`)
        .leftJoin(plain, sql`true`)
        .leftJoin(reservation, eq(reservation.id, plain.id))
        .leftJoin(admitted, eq(admitted.id, plain.id))
        .leftJoin(updated, eq(updated.id, plain.id))
        .leftJoin(activeIdentity, sql`true`);
      if (!row?.plainId) {
        throw new Error("Failed to lock new Official Workflow automation");
      }
      if (staged && (!identityComplete || row.plainEnabled)) {
        throw new Error("Official materialization identity is incomplete");
      }
      if (!row.admittedId) {
        return { kind: "reservation-lost" as const };
      }
      if (!row.row || (!staged && !row.identityId)) {
        throw new Error("Failed to mark Official Workflow automation");
      }
      return { kind: "attached" as const, row: row.row };
    })();
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
    return await set(
      rowToSummary$,
      args.row,
      { chatThreadId: args.chatThreadId },
      signal,
    );
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
    const visible = await set(
      readAutomationVisibleWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        workflowId: args.workflowId,
        includeInstallingOfficial: args.officialInstallation !== undefined,
      },
      signal,
    );
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
    const agent = await set(
      loadAgent$,
      {
        orgId: args.orgId,
        agentId: workflow.agentId,
      },
      signal,
    );
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
    if (!automationCreateInputIsSchedule(args)) {
      const created = await set(
        createEventAutomationForWorkflow$,
        {
          input: args,
          workflowId: workflow.id,
          agentId: agent.id,
          workflowTitle: workflow.displayName ?? workflow.name,
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

const prepareOfficialChatRunFinishedEvent$ = command(
  async (
    { get },
    input: CreateChatRunFinishedEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const db = get(db$);
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
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, input.orgId),
          eq(workflowUserAutomationThreads.userId, input.member.userId),
          eq(workflowUserAutomationThreads.workflowId, input.workflowId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const automationThreadId = binding?.chatThreadId ?? null;
    if (automationThreadId === input.eventConfig.chatThreadId) {
      return {
        kind: "bad-request",
        message:
          "A workflow cannot watch run-finished events from its own chat thread",
      };
    }
    return preparedOfficialEvent(input.eventConfig);
  },
);

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
const prepareOfficialGithubEvent$ = command(
  async (
    { set },
    input: CreateGithubEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const prepared = await set(
      prepareGithubAutomationEventConfig$,
      {
        orgId: input.orgId,
        eventType: input.eventType,
        eventConfig: input.eventConfig,
      },
      signal,
    );
    signal.throwIfAborted();
    return prepared.kind === "ok"
      ? preparedOfficialEvent(prepared.eventConfig)
      : prepared;
  },
);

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

const prepareOfficialGoogleMeetEvent$ = command(
  async (
    { set },
    input: CreateGoogleMeetEventAutomationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const eventConnectorId = await set(
      readEventAutomationConnectorId$,
      {
        orgId: input.orgId,
        userId: input.member.userId,
        workflowId: input.workflowId,
        connectorSlug: "google-meet",
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventConnectorId === null) {
      return {
        kind: "bad-request",
        message:
          "Connect Google Meet before using Google Meet event automations",
      };
    }
    const eventConfig = googleMeetTranscriptGeneratedEventConfigSchema.parse(
      input.eventConfig,
    );
    return preparedOfficialEvent(eventConfig, { eventConnectorId });
  },
);

export const prepareOfficialAutomationReconfiguration$ = command(
  async (
    { get, set },
    args: PrepareOfficialAutomationReconfigurationInput,
    signal: AbortSignal,
  ): Promise<OfficialAutomationEventPreparationResult> => {
    const db = get(db$);
    const owned = await set(
      loadOwnedAutomation$,
      {
        orgId: args.input.orgId,
        member: args.input.member,
        automationId: args.automationId,
      },
      signal,
    );
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
      return await set(prepareOfficialChatRunFinishedEvent$, input, signal);
    }
    if (automationCreateInputIsGmail(input)) {
      return await set(prepareOfficialGmailEvent$, input, signal);
    }
    if (automationCreateInputIsGithub(input)) {
      return await set(prepareOfficialGithubEvent$, input, signal);
    }
    if (automationCreateInputIsGoogleCalendar(input)) {
      return await set(prepareOfficialGoogleCalendarEvent$, input, signal);
    }
    if (automationCreateInputIsGoogleForms(input)) {
      return await set(prepareOfficialGoogleFormsEvent$, input, signal);
    }
    if (automationCreateInputIsGoogleMeet(input)) {
      return await set(prepareOfficialGoogleMeetEvent$, input, signal);
    }
    if (automationCreateInputIsNotion(input)) {
      return await set(prepareOfficialNotionEvent$, input, signal);
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

export const loadOwnedAutomation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automationId: string;
    },
    signal: AbortSignal,
  ): Promise<OwnedAutomation | AutomationActionFailure> => {
    const automation = await set(
      loadAutomationRow$,
      {
        orgId: args.orgId,
        automationId: args.automationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!automation) {
      return { kind: "not-found" };
    }
    if (
      automation.kind === "event" &&
      !supportedAutomationEventType(automation.eventType)
    ) {
      return { kind: "not-found" };
    }
    const visible = await set(
      readAutomationVisibleWorkflow$,
      {
        orgId: args.orgId,
        member: args.member,
        workflowId: automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
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
  },
);

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

const updateGithubAutomationEventConfig$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly eventConfig: GithubAutomationEventConfig;
    },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const db = set(writeDb$);
    const [row] = await db
      .update(workflowAutomations)
      .set({ eventConfig: args.eventConfig, updatedAt: nowDate() })
      .where(eq(workflowAutomations.id, args.automationId))
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to update workflow automation");
    }
    const [binding] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        workflowUserAutomationThreadOwnerCondition({
          orgId: row.orgId,
          userId: row.ownerUserId,
          workflowId: row.workflowId,
        }),
      )
      .limit(1);
    signal.throwIfAborted();
    const summary = eventRowToSummary(row, binding?.chatThreadId ?? null);
    if (!summary) {
      throw new Error("Unsupported GitHub workflow automation event");
    }
    return summary;
  },
);

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

const prepareGithubAutomationEventConfig$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly eventType: GithubAutomationEventType;
      readonly eventConfig: unknown;
    },
    signal: AbortSignal,
  ) => {
    const eventConfig = parseGithubAutomationEventConfig(
      args.eventType,
      args.eventConfig,
    );
    if (!eventConfig) {
      return {
        kind: "bad-request" as const,
        message: "eventConfig must match the GitHub automation type",
      };
    }
    const db = get(db$);
    const [installation] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return {
        kind: "bad-request" as const,
        message:
          args.eventType === "github-workflow-run-completed"
            ? "Install GitHub before creating GitHub workflow run automations"
            : "Install GitHub before creating GitHub webhook automations",
      };
    }
    return { kind: "ok" as const, eventConfig };
  },
);

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
    const settled = await settle(
      // Publish the account only while it is still the workflow's
      // selection/default; zero rows means it changed.
      db
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
        .returning(workflowAutomationColumns()),
    );
    signal.throwIfAborted();
    if (!settled.ok && !isAutomationEventConnectorMissing(settled.error)) {
      throw settled.error;
    }
    const row = settled.ok ? settled.value[0] : null;
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
      readonly previousTarget: StagedGoogleCalendarWatchTarget | null;
      readonly targetChanged: boolean;
    }
  | {
      readonly kind: "bad-request";
      readonly message: string;
    };

const readCommittedGoogleCalendarSummary$ = command(
  async (
    { get },
    args: { readonly row: AutomationRow },
    signal: AbortSignal,
  ): Promise<WorkflowAutomationSummary> => {
    const db = get(db$);
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

type GoogleCalendarReconfigurationPersistenceArgs = {
  readonly orgId: string;
  readonly source: AutomationRow;
  readonly eventConnectorId: string;
  readonly eventConfig: GoogleCalendarAutomationEventConfig;
};

const persistGoogleCalendarAutomationReconfiguration$ = command(
  async (
    { set },
    args: GoogleCalendarReconfigurationPersistenceArgs,
    signal: AbortSignal,
  ): Promise<GoogleCalendarReconfigurationPersistenceResult> => {
    const db = set(writeDb$);
    const settled = await settle(
      db
        .update(workflowAutomations)
        .set({
          eventConfig: args.eventConfig,
          eventConnectorId: args.eventConnectorId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.id, args.source.id),
          ),
        )
        .returning(workflowAutomationColumns()),
    );
    signal.throwIfAborted();
    if (!settled.ok) {
      if (isAutomationEventConnectorMissing(settled.error)) {
        return { kind: "account-changed" };
      }
      throw settled.error;
    }
    const [row] = settled.value;
    if (!row) {
      return { kind: "automation-changed" };
    }
    const summary = await set(
      readCommittedGoogleCalendarSummary$,
      { row },
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
        source: args.automation,
        eventConnectorId: prepared.eventConnectorId,
        eventConfig: prepared.eventConfig,
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
      const eventConfig = await set(
        prepareGithubAutomationEventConfig$,
        {
          orgId: args.orgId,
          eventType: args.automation.eventType,
          eventConfig: args.eventConfig,
        },
        signal,
      );
      signal.throwIfAborted();
      if (eventConfig.kind !== "ok") {
        return eventConfig;
      }
      return {
        kind: "ok",
        summary: await set(
          updateGithubAutomationEventConfig$,
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
    const owned = await set(
      loadOwnedAutomation$,
      {
        orgId: args.orgId,
        member: args.member,
        automationId: args.automationId,
      },
      signal,
    );
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

    const [row] = await writeDb
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
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to update workflow automation");
    }
    return { kind: "ok", summary: await set(rowToSummary$, row, {}, signal) };
  },
);

export interface AutomationActionInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automationId: string;
  readonly sourceRunId?: string;
  readonly inheritedAutonomyBudget?: number;
  readonly allowReservedOfficialMaterialization?: boolean;
  readonly userRequestedEnable?: true;
}
export const deleteWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await set(loadOwnedAutomation$, args, signal);
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
    const chatThreadId = await set(
      readAutomationChatThreadId$,
      {
        orgId: owned.automation.orgId,
        userId: owned.automation.ownerUserId,
        workflowId: owned.automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    // Keep the bound thread and claimed turns; retire only pending inputs.
    await writeDb
      .delete(workflowAutomations)
      .where(eq(workflowAutomations.id, owned.automation.id));
    signal.throwIfAborted();
    await set(
      revokeDeletedWorkflowAutomationInputs$,
      { orgId: args.orgId, automationId: owned.automation.id },
      signal,
    );
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
      const preparedConfig = await set(
        prepareGithubAutomationEventConfig$,
        {
          orgId: args.orgId,
          eventType: args.automation.eventType,
          eventConfig: args.automation.eventConfig,
        },
        signal,
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
      return await set(
        hasEnabledGoogleMeetConsumer$,
        {
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
      const result = await set(
        ensureGoogleMeetTranscriptGeneratedSubscriptionForUser$,
        {
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

const restoreDisabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly previousAutomation: AutomationRow;
    },
  ): Promise<void> => {
    const { previousAutomation } = args;
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
    const restore = db
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
      .where(eq(workflowAutomations.id, previousAutomation.id))
      .returning({ id: workflowAutomations.id });
    if (
      previousAutomation.eventType !== "google-forms-response-submitted" ||
      previousAutomation.enabled
    ) {
      await restore;
      return;
    }
    const restoredAutomation = db.$with("restored_automation").as(restore);
    await db
      .with(restoredAutomation)
      .delete(googleFormsAutomationCursors)
      .where(
        inArray(
          googleFormsAutomationCursors.automationId,
          db.select({ id: restoredAutomation.id }).from(restoredAutomation),
        ),
      );
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

const finalizeEnabledOfficialAutomation$ = command(
  async (
    { set },
    previousAutomation: AutomationRow,
    enabledAutomation: AutomationRow,
    signal: AbortSignal,
  ): Promise<AutomationRow> => {
    const db = set(writeDb$);
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
  },
);
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
      readonly status: "ok";
      readonly required: false;
    }
  | {
      readonly status: "ok";
      readonly required: true;
      readonly connectorSlug: WorkflowAutomationAccountConnectorSlug;
      readonly eventConnectorId: string;
      readonly eventConfig: WorkflowAutomationEventConfig;
      readonly resetFormsCursor?: boolean;
    };

function unavailableEnabledAutomationProjection(
  provider: WorkflowAutomationAccountConnectorSlug,
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
  provider: WorkflowAutomationAccountConnectorSlug,
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

/** Read the selected account immediately before the local enable commit. */
const readEnabledAutomationAccountProjection$ = command(
  async (
    { get, set },
    automation: AutomationRow,
    signal: AbortSignal,
  ): Promise<EnabledAutomationAccountProjection> => {
    const db = get(db$);
    const provider = workflowAutomationAccountConnectorSlug(
      automation.eventType,
    );
    if (provider === null) {
      return { status: "ok", required: false };
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
      signal.throwIfAborted();
      const calendarId = normalizeGoogleCalendarId(
        parsedConfig.calendarId,
        calendarAccount?.externalEmail ?? null,
      );
      signal.throwIfAborted();
      eventConfig = { ...parsedConfig, calendarId };
    } else if (provider === "google-forms") {
      eventConfig = {
        ...googleFormsResponseSubmittedEventConfigSchema.parse(
          automation.eventConfig,
        ),
        connectorId: eventConnectorId,
      };
    }
    if (eventConfig === null) {
      throw new Error("Enabled connector automation config is incomplete");
    }
    return {
      status: "ok",
      required: true,
      connectorSlug: provider,
      eventConnectorId,
      eventConfig,
      resetFormsCursor: googleFormsEnabledCursorMustReset(
        automation,
        eventConnectorId,
      ),
    };
  },
);
type PersistEnabledWorkflowAutomationResult =
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
      readonly status: "google-forms-unavailable";
    }
  | {
      readonly status: "google-meet-unavailable";
    }
  | {
      readonly status: "account-changed";
    }
  | {
      readonly status: "ok";
      readonly row: AutomationRow | undefined;
    };

function googleFormsEnabledCursorMustReset(
  automation: AutomationRow,
  connectorId: string,
): boolean {
  if (!supportedGoogleFormsEventType(automation.eventType)) {
    return false;
  }
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    automation.eventConfig,
  );
  return (
    config.connectorId !== connectorId ||
    (automation.eventConnectorId !== null &&
      automation.eventConnectorId !== connectorId)
  );
}
function enabledWorkflowAutomationValues(
  args: {
    readonly automation: AutomationRow;
    readonly nextRunAt: Date | null;
    readonly now: Date;
    readonly inheritedAutonomyBudget?: number;
  },
  accountProjection: Extract<
    EnabledAutomationAccountProjection,
    { readonly status: "ok" }
  >,
) {
  return {
    enabled: true,
    ...(accountProjection.required
      ? {
          eventConnectorId: accountProjection.eventConnectorId,
          eventConfig: accountProjection.eventConfig,
        }
      : {}),
    nextRunAt: args.nextRunAt,
    ...(args.automation.officialBlueprintKey === null
      ? { consecutiveFailures: 0 }
      : {}),
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
  };
}
function enabledAutomationCommitResult(
  automation: AutomationRow,
  row: AutomationRow | undefined,
): PersistEnabledWorkflowAutomationResult {
  return !row && automation.officialBlueprintKey !== null
    ? { status: "conflict" }
    : { status: "ok", row };
}

function enabledAutomationEntitlementPlan(orgId: string, isWebhook: boolean) {
  const query = new QueryBuilder();
  const entitlement = query.$with("enable_entitlement").as(
    query
      .select({
        allowed: orgPlanEntitlements.workflowWebhookTriggerAllowed,
        restricted: orgPlanEntitlements.restrictedBuiltInModels,
      })
      .from(orgPlanEntitlements)
      .where(and(eq(orgPlanEntitlements.orgId, orgId), sql`${isWebhook}`))
      .limit(1)
      .for("update"),
  );
  const entitlementRows = query.select().from(entitlement);
  const missingEntitlementOrg = query
    .$with("enable_missing_entitlement_org")
    .as(
      query
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(
          and(
            sql`${isWebhook}`,
            eq(orgMetadata.orgId, orgId),
            notExists(entitlementRows),
          ),
        )
        .limit(1)
        .for("update"),
    );
  const eligible = isWebhook
    ? exists(
        query
          .select()
          .from(entitlement)
          .where(
            and(
              eq(entitlement.allowed, true),
              isNotNull(entitlement.restricted),
            ),
          ),
      )
    : sql`true`;
  const outcome = query
    .select({
      eligible: sql`${eligible}`.mapWith(pgBooleanDecoder).as("eligible"),
      missingEntitlement:
        sql`${exists(query.select().from(missingEntitlementOrg))}`
          .mapWith(pgBooleanDecoder)
          .as("missing_entitlement"),
      invalidRestriction:
        sql`${exists(query.select().from(entitlement).where(isNull(entitlement.restricted)))}`
          .mapWith(pgBooleanDecoder)
          .as("invalid_restriction"),
    })
    .from(sql`(SELECT 1) AS enable_result_seed`)
    .as("enable_outcome");
  return { entitlement, missingEntitlementOrg, eligible, outcome };
}

function enabledAutomationPublicationResult(
  automation: AutomationRow,
  orgId: string,
  outcome:
    | {
        readonly eligible: boolean;
        readonly missingEntitlement: boolean;
        readonly invalidRestriction: boolean;
      }
    | undefined,
  row: AutomationRow | null | undefined,
): PersistEnabledWorkflowAutomationResult {
  if (!outcome) {
    throw new Error("Missing automation enable result");
  }
  // These invariant outcomes gate every mutation in the statement.
  if (outcome.missingEntitlement) {
    throw new Error("Missing org plan entitlement for " + orgId);
  }
  if (outcome.invalidRestriction) {
    throw new Error(
      `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
    );
  }
  return outcome.eligible
    ? enabledAutomationCommitResult(automation, row ?? undefined)
    : { status: "team-required" };
}

const commitEnabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly orgId: string;
      readonly now: Date;
    },
    publication: {
      readonly values: ReturnType<typeof enabledWorkflowAutomationValues>;
      readonly isWebhook: boolean;
      readonly resetsFormsCursor: boolean;
    },
    signal: AbortSignal,
  ): Promise<PersistEnabledWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { values, isWebhook, resetsFormsCursor } = publication;
    const { entitlement, missingEntitlementOrg, eligible, outcome } =
      enabledAutomationEntitlementPlan(args.orgId, isWebhook);
    // Each mutation consumes its predecessor before taking the next lock.
    const resetCursor = db.$with("enable_reset_forms_cursor").as(
      db
        .delete(googleFormsAutomationCursors)
        .where(
          and(
            eq(googleFormsAutomationCursors.automationId, args.automation.id),
            sql`${resetsFormsCursor}`,
            eligible,
          ),
        )
        .returning({
          automationId: googleFormsAutomationCursors.automationId,
        }),
    );
    const columns = workflowAutomationColumns();
    const enabled = db.$with("enabled_automation").as(
      db
        .update(workflowAutomations)
        .set(values)
        .where(
          and(
            officialAutomationLifecycleCondition(args.automation),
            eligible,
            gte(db.select({ count: count() }).from(resetCursor), 0),
          ),
        )
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as(
            "observed_updated_at",
          ),
          observedXmin: columns.observedXmin.as("observed_xmin"),
        }),
    );
    const clearedWebhook = db.$with("enable_cleared_webhook").as(
      db
        .update(workflowWebhookAutomations)
        .set({ disabledReason: null, updatedAt: args.now })
        .where(
          and(
            sql`${isWebhook}`,
            inArray(
              workflowWebhookAutomations.automationId,
              db.select({ id: enabled.id }).from(enabled),
            ),
          ),
        )
        .returning({
          automationId: workflowWebhookAutomations.automationId,
        }),
    );
    const [result] = await db
      .with(
        entitlement,
        missingEntitlementOrg,
        resetCursor,
        enabled,
        clearedWebhook,
      )
      .select()
      .from(outcome)
      .leftJoin(enabled, sql`true`)
      .where(gte(db.select({ count: count() }).from(clearedWebhook), 0));
    signal.throwIfAborted();
    return enabledAutomationPublicationResult(
      args.automation,
      args.orgId,
      result?.enable_outcome,
      result?.enabled_automation,
    );
  },
);

const persistEnabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly orgId: string;
      readonly nextRunAt: Date | null;
      readonly now: Date;
      readonly inheritedAutonomyBudget?: number;
    },
    signal: AbortSignal,
  ): Promise<PersistEnabledWorkflowAutomationResult> => {
    const accountProjection = await set(
      readEnabledAutomationAccountProjection$,
      args.automation,
      signal,
    );
    signal.throwIfAborted();
    if (accountProjection.status !== "ok") {
      return accountProjection;
    }
    const db = set(writeDb$);
    const values = enabledWorkflowAutomationValues(args, accountProjection);
    const isWebhook =
      args.automation.kind === "event" &&
      args.automation.eventType === "webhook-received";
    const resetsFormsCursor =
      accountProjection.required && accountProjection.resetFormsCursor === true;
    const settled = await settle<
      PersistEnabledWorkflowAutomationResult | AutomationRow[]
    >(
      isWebhook || resetsFormsCursor
        ? set(
            commitEnabledWorkflowAutomation$,
            args,
            { values, isWebhook, resetsFormsCursor },
            signal,
          )
        : db
            .update(workflowAutomations)
            .set(values)
            .where(officialAutomationLifecycleCondition(args.automation))
            .returning(workflowAutomationColumns()),
    );
    signal.throwIfAborted();
    if (settled.ok) {
      return "status" in settled.value
        ? settled.value
        : enabledAutomationCommitResult(args.automation, settled.value[0]);
    }
    if (isAutomationEventConnectorMissing(settled.error)) {
      return { status: "account-changed" };
    }
    throw settled.error;
  },
);
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
    if (provider === null) {
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

const finalizeAndPublishEnabledWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly previousAutomation: AutomationRow;
      readonly enabledAutomation: AutomationRow;
      readonly memberUserId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const row = await set(
      finalizeEnabledOfficialAutomation$,
      args.previousAutomation,
      args.enabledAutomation,
      signal,
    );
    const chatThreadId = await set(
      readAutomationChatThreadId$,
      {
        orgId: row.orgId,
        userId: row.ownerUserId,
        workflowId: row.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      args.memberUserId,
      chatThreadId,
    );
    signal.throwIfAborted();
    const summary = await set(rowToSummary$, row, { chatThreadId }, signal);
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);
const publishEnabledGoogleFormsSummary$ = command(
  async (
    { get },
    args: {
      readonly row: AutomationRow;
      readonly memberUserId: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const { row } = args;
    const db = get(db$);
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
    const automationSnapshot = workflowAutomationSnapshot(
      args.previousAutomation,
    );
    if (automationSnapshot === undefined) {
      throw new Error(
        "Google Forms activation requires its observed automation",
      );
    }
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
        activation: {
          automationSnapshot,
          ...(args.previousAutomation.officialBlueprintKey === null
            ? {}
            : { officialAutomation: args.previousAutomation }),
          automationId: args.previousAutomation.id,
          workflowId: args.previousAutomation.workflowId,
          eventConfig,
          nextRunAt: args.nextRunAt,
          inheritedAutonomyBudget:
            args.previousAutomation.officialBlueprintKey === null
              ? args.inheritedAutonomyBudget
              : undefined,
        },
      },
      signal,
    );
    if (prepared.kind !== "ok") {
      return {
        kind: prepared.kind === "superseded" ? "conflict" : "bad-request",
        message:
          prepared.kind === "superseded" &&
          args.previousAutomation.officialBlueprintKey !== null
            ? OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE
            : prepared.message,
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
    { get, set },
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
    const db = get(db$);
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
  enabled: PersistEnabledWorkflowAutomationResult,
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
  if (enabled.status === "account-changed") {
    return {
      kind: "bad-request",
      message:
        "Connector account selection changed; retry enabling the automation",
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
      readonly userRequestedEnable: boolean;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    if (
      args.automation.eventType === "google-forms-response-submitted" &&
      (args.automation.officialBlueprintKey === null ||
        (args.userRequestedEnable &&
          !args.automation.enabled &&
          args.automation.officialIntendedEnabled === false))
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
    const enabled = await set(
      persistEnabledWorkflowAutomation$,
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
    return await set(
      finalizeAndPublishEnabledWorkflowAutomation$,
      {
        previousAutomation: args.automation,
        enabledAutomation: enabled.row,
        memberUserId: args.memberUserId,
      },
      signal,
    );
  },
);

const readWorkflowAutomationEnableTarget$ = command(
  async (
    { get },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<OwnedAutomation | AutomationActionFailure> => {
    const db = get(db$);
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
        reconciliationOwned: args.allowReservedOfficialMaterialization === true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (morningBriefRow.kind === "conflict") {
      return {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_RECONFIGURATION_IN_PROGRESS_MESSAGE,
      };
    }
    if (morningBriefRow.kind === "applied") {
      return await set(
        finalizeAndPublishEnabledWorkflowAutomation$,
        {
          previousAutomation: automation,
          enabledAutomation: morningBriefRow.row,
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
        userRequestedEnable: args.userRequestedEnable === true,
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
    const columns = workflowAutomationColumns();
    const disabled = db.$with("disabled_workflow_automation").as(
      db
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
        .returning({
          ...columns,
          observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
          observedXmin: columns.observedXmin.as("observedXmin"),
        }),
    );
    // A user stop ends this delivery interval. Only its actual Forms row
    // clears the cursor; a reconciliation pause never calls this command.
    const cleared = db
      .$with("cleared_disabled_forms_cursor")
      .as(
        db
          .delete(googleFormsAutomationCursors)
          .where(
            inArray(
              googleFormsAutomationCursors.automationId,
              db
                .select({ id: disabled.id })
                .from(disabled)
                .where(
                  eq(disabled.eventType, "google-forms-response-submitted"),
                ),
            ),
          ),
      );
    const [row] = await db.with(disabled, cleared).select().from(disabled);
    signal.throwIfAborted();
    return row;
  },
);

export const disableWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await set(loadOwnedAutomation$, args, signal);
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
    const row =
      morningBriefRow.kind === "applied"
        ? morningBriefRow.row
        : morningBriefRow.kind === "conflict"
          ? undefined
          : await set(
              persistDisabledWorkflowAutomation$,
              { automation: owned.automation, nextRunAt, now },
              signal,
            );
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
      const currentTime = nowDate();
      await writeDb
        .update(notionWorkflowPendingEvents)
        .set({
          status: "skipped",
          skipReason:
            "Notion automation was disabled before the event was processed",
          processedAt: currentTime,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(notionWorkflowPendingEvents.automationId, row.id),
            inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
          ),
        );
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
    const chatThreadId = await set(
      readAutomationChatThreadId$,
      {
        orgId: row.orgId,
        userId: row.ownerUserId,
        workflowId: row.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return {
      kind: "ok",
      summary: await set(rowToSummary$, row, { chatThreadId }, signal),
    };
  },
);
