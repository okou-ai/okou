import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  officialWorkflowBlueprintKeySchema,
  officialWorkflowParameterBindingSchema,
} from "./official-workflow-bindings";

import { workflowImportSourceSchema } from "./workflow-import-source";

export { GMAIL_LABEL_NOT_FOUND_ERROR_CODE } from "../validators/workflows";

export {
  workflowImportSourceSchema,
  type WorkflowImportSource,
} from "./workflow-import-source";

const c = initContract();

export const workflowVisibilitySchema = zEnum(["public", "private"]);
export type WorkflowVisibility = zInfer<typeof workflowVisibilitySchema>;

/**
 * Workflow name (slug) validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters. Slugs are NOT unique — duplicates across and within an
 * agent are allowed; run-time picks a winner by a fixed priority rule.
 */
export const workflowNameSchema = string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

/**
 * Reserved file name. `SKILL.md` is synthesized server-side from the workflow's
 * (name, description, instruction); users never author or see it.
 */
export const RESERVED_SKILL_FILE = "SKILL.md";

/**
 * A single attached (supplementary) file. The synthesized SKILL.md is never
 * part of this set — `SKILL.md` is a reserved path and is rejected.
 */
export const workflowFileEntrySchema = object({
  path: string()
    .min(1)
    .max(256)
    .refine(
      (p) => {
        return !p.startsWith("/");
      },
      { message: "Path must be relative" },
    )
    .refine(
      (p) => {
        return !p.includes("..");
      },
      { message: "Path must not contain .." },
    )
    .refine(
      (p) => {
        return p !== RESERVED_SKILL_FILE;
      },
      { message: "SKILL.md is reserved and is generated automatically" },
    ),
  content: string(),
});

const WORKFLOW_FILES_MAX_BYTES = 5 * 1024 * 1024;
const WORKFLOW_FILES_MAX_COUNT = 500;

/**
 * Attached files (excluding the synthesized SKILL.md). May be empty.
 */
export const workflowFilesSchema = array(workflowFileEntrySchema)
  .max(
    WORKFLOW_FILES_MAX_COUNT,
    `Maximum ${WORKFLOW_FILES_MAX_COUNT} files allowed`,
  )
  .refine(
    (files) => {
      const total = files.reduce((sum, f) => {
        return sum + new TextEncoder().encode(f.content).length;
      }, 0);
      return total <= WORKFLOW_FILES_MAX_BYTES;
    },
    { message: "Total file size must not exceed 5MB" },
  );

export const workflowFileMetadataSchema = object({
  path: string(),
  size: number(),
});

export const workflowInstructionSchema = string().max(WORKFLOW_FILES_MAX_BYTES);

export const workflowScheduleTypeSchema = zEnum(["cron", "loop", "once"]);
export type WorkflowScheduleType = zInfer<typeof workflowScheduleTypeSchema>;

export const workflowAutomationKindSchema = zEnum(["schedule", "event"]);
export type WorkflowAutomationKind = zInfer<
  typeof workflowAutomationKindSchema
>;

export const automationEventTypeSchema = zEnum([
  "chat-run-finished",
  "gmail-new-message",
  "gmail-label-applied",
  "github-deployment-status-created",
  "github-issue-comment-created",
  "github-pull-request",
  "github-pull-request-review-submitted",
  "github-workflow-job-completed",
  "github-workflow-run-completed",
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
  "google-forms-response-submitted",
  "google-meet-transcript-generated",
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
  "webhook-received",
]);
export type WorkflowAutomationEventType = zInfer<
  typeof automationEventTypeSchema
>;

export const chatRunFinishedRunStatusSchema = zEnum([
  "completed",
  "failed",
  "cancelled",
]);
export type ChatRunFinishedRunStatus = zInfer<
  typeof chatRunFinishedRunStatusSchema
>;

/**
 * Fires when a run in the watched chat thread reaches a terminal state.
 *
 * `outputPattern` is a `*`-wildcard expression matched case-insensitively
 * against the run's final assistant text (codex: last agent message;
 * claude code: result). Failed runs without assistant text never match a
 * pattern; error messages are not searched.
 */
export const chatRunFinishedEventConfigSchema = object({
  provider: literal("chat"),
  event: literal("run_finished"),
  chatThreadId: uuid(),
  runStatuses: array(chatRunFinishedRunStatusSchema).min(1).optional(),
  outputPattern: string().trim().min(1).max(512).optional(),
}).strict();
export type ChatRunFinishedEventConfig = zInfer<
  typeof chatRunFinishedEventConfigSchema
>;

const gmailTextMatchSchema = object({
  contains: string().min(1).optional(),
  containsAny: array(string().min(1)).min(1).optional(),
  doesNotContain: string().min(1).optional(),
  doesNotContainAny: array(string().min(1)).min(1).optional(),
})
  .strict()
  .refine(
    (value) => {
      return (
        value.contains !== undefined ||
        value.containsAny !== undefined ||
        value.doesNotContain !== undefined ||
        value.doesNotContainAny !== undefined
      );
    },
    { message: "At least one text matcher is required" },
  );

export const gmailNewMessageEventConfigSchema = object({
  provider: literal("gmail"),
  event: literal("new_message"),
  threadId: string().min(1).optional(),
  match: object({
    from: gmailTextMatchSchema.optional(),
    subject: gmailTextMatchSchema.optional(),
    body: gmailTextMatchSchema.optional(),
    to: gmailTextMatchSchema.optional(),
    cc: gmailTextMatchSchema.optional(),
  })
    .strict()
    .optional(),
}).strict();
export type GmailNewMessageEventConfig = zInfer<
  typeof gmailNewMessageEventConfigSchema
>;

export const gmailLabelAppliedEventConfigSchema = object({
  provider: literal("gmail"),
  event: literal("label_applied"),
  labelName: string().trim().min(1).max(225),
  resolvedLabelId: string().min(1).max(128).optional(),
}).strict();
export type GmailLabelAppliedEventConfig = zInfer<
  typeof gmailLabelAppliedEventConfigSchema
>;

export const gmailAutomationEventConfigSchema = discriminatedUnion("event", [
  gmailNewMessageEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
]);
export type GmailAutomationEventConfig = zInfer<
  typeof gmailAutomationEventConfigSchema
>;

export const webhookReceivedEventConfigSchema = object({
  provider: literal("webhook"),
  event: literal("received"),
  auth: object({
    mode: literal("hmac-sha256"),
  }).strict(),
}).strict();
export type WebhookReceivedEventConfig = zInfer<
  typeof webhookReceivedEventConfigSchema
>;

export const githubWorkflowRunConclusionSchema = zEnum([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
export type GithubWorkflowRunConclusion = zInfer<
  typeof githubWorkflowRunConclusionSchema
>;

const githubFilterValuesSchema = array(string().trim().min(1).max(255))
  .min(1)
  .max(100);

export const githubWorkflowRunCompletedEventConfigSchema = object({
  provider: literal("github"),
  event: literal("workflow_run_completed"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    workflows: githubFilterValuesSchema.optional(),
    conclusions: array(githubWorkflowRunConclusionSchema)
      .min(1)
      .max(githubWorkflowRunConclusionSchema.options.length)
      .optional(),
    branches: githubFilterValuesSchema.optional(),
    events: githubFilterValuesSchema.optional(),
    actors: githubFilterValuesSchema.optional(),
  })
    .strict()
    .default({}),
}).strict();
export type GithubWorkflowRunCompletedEventConfig = zInfer<
  typeof githubWorkflowRunCompletedEventConfigSchema
>;

export const githubWorkflowJobCompletedEventConfigSchema = object({
  provider: literal("github"),
  event: literal("workflow_job_completed"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    workflows: githubFilterValuesSchema.optional(),
    jobs: githubFilterValuesSchema.optional(),
    conclusions: array(githubWorkflowRunConclusionSchema)
      .min(1)
      .max(githubWorkflowRunConclusionSchema.options.length)
      .optional(),
    branches: githubFilterValuesSchema.optional(),
    runnerLabels: githubFilterValuesSchema.optional(),
    runnerGroups: githubFilterValuesSchema.optional(),
  })
    .strict()
    .default({}),
}).strict();
export type GithubWorkflowJobCompletedEventConfig = zInfer<
  typeof githubWorkflowJobCompletedEventConfigSchema
>;

export const githubPullRequestReviewStateSchema = zEnum([
  "approved",
  "changes_requested",
  "commented",
]);
export type GithubPullRequestReviewState = zInfer<
  typeof githubPullRequestReviewStateSchema
>;

export const githubPullRequestReviewSubmittedEventConfigSchema = object({
  provider: literal("github"),
  event: literal("pull_request_review_submitted"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    reviewStates: array(githubPullRequestReviewStateSchema)
      .min(1)
      .max(githubPullRequestReviewStateSchema.options.length)
      .optional(),
    baseBranches: githubFilterValuesSchema.optional(),
    headBranches: githubFilterValuesSchema.optional(),
    trustedAuthors: githubFilterValuesSchema.optional(),
  })
    .strict()
    .default({}),
}).strict();
export type GithubPullRequestReviewSubmittedEventConfig = zInfer<
  typeof githubPullRequestReviewSubmittedEventConfigSchema
>;

export const githubDeploymentStateSchema = zEnum([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
  "waiting",
]);
export type GithubDeploymentState = zInfer<typeof githubDeploymentStateSchema>;

export const githubDeploymentStatusCreatedEventConfigSchema = object({
  provider: literal("github"),
  event: literal("deployment_status_created"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    environments: githubFilterValuesSchema.optional(),
    states: array(githubDeploymentStateSchema)
      .min(1)
      .max(githubDeploymentStateSchema.options.length)
      .optional(),
    refs: githubFilterValuesSchema.optional(),
    productionEnvironment: boolean().optional(),
    creators: githubFilterValuesSchema.optional(),
    apps: githubFilterValuesSchema.optional(),
  })
    .strict()
    .default({}),
}).strict();
export type GithubDeploymentStatusCreatedEventConfig = zInfer<
  typeof githubDeploymentStatusCreatedEventConfigSchema
>;

export const githubIssueCommentSubjectFilterSchema = zEnum([
  "both",
  "issues",
  "pull_requests",
]);
export type GithubIssueCommentSubjectFilter = zInfer<
  typeof githubIssueCommentSubjectFilterSchema
>;

export const githubIssueCommentCreatedEventConfigSchema = object({
  provider: literal("github"),
  event: literal("issue_comment_created"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    subject: githubIssueCommentSubjectFilterSchema.default("both"),
    trustedAuthors: githubFilterValuesSchema.optional(),
    commentPrefixes: array(string().trim().min(1).max(1024))
      .min(1)
      .max(100)
      .optional(),
  })
    .strict()
    .default({ subject: "both" }),
}).strict();
export type GithubIssueCommentCreatedEventConfig = zInfer<
  typeof githubIssueCommentCreatedEventConfigSchema
>;

export const githubPullRequestActionSchema = zEnum([
  "opened",
  "reopened",
  "closed",
  "ready_for_review",
  "converted_to_draft",
  "synchronize",
  "enqueued",
  "dequeued",
  "labeled",
  "unlabeled",
]);
export type GithubPullRequestAction = zInfer<
  typeof githubPullRequestActionSchema
>;

/**
 * Fires on one native `pull_request` webhook action in one repository.
 *
 * `merged` narrows the `closed` action: `true` fires only for merged pull
 * requests, `false` only for ones closed without merging, unset for both.
 * `filters.labels` matches the added/removed label for the `labeled` and
 * `unlabeled` actions and any current pull request label otherwise.
 */
export const githubPullRequestEventConfigSchema = object({
  provider: literal("github"),
  event: literal("pull_request"),
  repository: string().trim().min(1).max(255),
  action: githubPullRequestActionSchema,
  merged: boolean().optional(),
  filters: object({
    baseBranches: githubFilterValuesSchema.optional(),
    authors: githubFilterValuesSchema.optional(),
    pullRequestNumbers: githubFilterValuesSchema.optional(),
    labels: githubFilterValuesSchema.optional(),
  })
    .strict()
    .default({}),
})
  .strict()
  .refine(
    (value) => {
      return value.merged === undefined || value.action === "closed";
    },
    { message: "merged only applies to the closed action" },
  );
export type GithubPullRequestEventConfig = zInfer<
  typeof githubPullRequestEventConfigSchema
>;

export const githubAutomationEventConfigSchema = discriminatedUnion("event", [
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  githubWorkflowRunCompletedEventConfigSchema,
]);
export type GithubAutomationEventConfig = zInfer<
  typeof githubAutomationEventConfigSchema
>;

export const googleCalendarEventCreatedEventConfigSchema = object({
  provider: literal("google-calendar"),
  event: literal("event_created"),
  calendarId: string().trim().min(1).max(1024).default("primary"),
}).strict();
export type GoogleCalendarEventCreatedEventConfig = zInfer<
  typeof googleCalendarEventCreatedEventConfigSchema
>;

export const googleCalendarEventUpdatedEventConfigSchema = object({
  provider: literal("google-calendar"),
  event: literal("event_updated"),
  calendarId: string().trim().min(1).max(1024).default("primary"),
}).strict();
export type GoogleCalendarEventUpdatedEventConfig = zInfer<
  typeof googleCalendarEventUpdatedEventConfigSchema
>;

export const googleCalendarEventCancelledEventConfigSchema = object({
  provider: literal("google-calendar"),
  event: literal("event_cancelled"),
  calendarId: string().trim().min(1).max(1024).default("primary"),
}).strict();
export type GoogleCalendarEventCancelledEventConfig = zInfer<
  typeof googleCalendarEventCancelledEventConfigSchema
>;

export const googleCalendarAutomationEventConfigSchema = discriminatedUnion(
  "event",
  [
    googleCalendarEventCreatedEventConfigSchema,
    googleCalendarEventUpdatedEventConfigSchema,
    googleCalendarEventCancelledEventConfigSchema,
  ],
);
export type GoogleCalendarAutomationEventConfig = zInfer<
  typeof googleCalendarAutomationEventConfigSchema
>;

export const googleCalendarWatchActionRequiredReasonSchema = zEnum([
  "calendar_not_found",
  "reconnect_required",
]);
export type GoogleCalendarWatchActionRequiredReason = zInfer<
  typeof googleCalendarWatchActionRequiredReasonSchema
>;

export const googleMeetTranscriptGeneratedEventConfigSchema = object({
  provider: literal("google-meet"),
  event: literal("transcript_generated"),
  scope: object({
    type: literal("organizer_user"),
  })
    .strict()
    .default({ type: "organizer_user" }),
}).strict();
export type GoogleMeetTranscriptGeneratedEventConfig = zInfer<
  typeof googleMeetTranscriptGeneratedEventConfigSchema
>;
export type GoogleMeetAutomationEventConfig =
  GoogleMeetTranscriptGeneratedEventConfig;

export const googleFormsFormReferenceSchema = object({
  id: string().trim().min(1).max(255),
  title: string().trim().min(1).max(512),
  url: url(),
}).strict();
export type GoogleFormsFormReference = zInfer<
  typeof googleFormsFormReferenceSchema
>;

export const googleFormsResponseSubmittedEventConfigSchema = object({
  provider: literal("google-forms"),
  event: literal("response_submitted"),
  connectorId: uuid(),
  form: googleFormsFormReferenceSchema,
}).strict();
export type GoogleFormsResponseSubmittedEventConfig = zInfer<
  typeof googleFormsResponseSubmittedEventConfigSchema
>;

export const googleFormsResponseSubmittedEventCreateConfigSchema = object({
  provider: literal("google-forms"),
  event: literal("response_submitted"),
  formUrl: string().trim().min(1).max(2048),
}).strict();
export type GoogleFormsResponseSubmittedEventCreateConfig = zInfer<
  typeof googleFormsResponseSubmittedEventCreateConfigSchema
>;

export type GoogleFormsAutomationEventConfig =
  GoogleFormsResponseSubmittedEventConfig;

export const notionPageReferenceSchema = object({
  id: uuid(),
  url: url(),
  title: string().nullable(),
  rawUrl: string().min(1).max(2048).optional(),
}).strict();
export type NotionPageReference = zInfer<typeof notionPageReferenceSchema>;

export const notionDataSourceReferenceSchema = object({
  id: uuid(),
  url: url(),
  title: string().nullable(),
  rawUrl: string().min(1).max(2048).optional(),
}).strict();
export type NotionDataSourceReference = zInfer<
  typeof notionDataSourceReferenceSchema
>;

export const notionChildPageCreatedEventConfigSchema = object({
  provider: literal("notion"),
  event: literal("child_page_created"),
  connectorId: uuid(),
  parentPage: notionPageReferenceSchema,
}).strict();
export type NotionChildPageCreatedEventConfig = zInfer<
  typeof notionChildPageCreatedEventConfigSchema
>;

export const notionChildPageCreatedEventCreateConfigSchema = object({
  provider: literal("notion"),
  event: literal("child_page_created"),
  parentPageUrl: string().trim().min(1).max(2048),
}).strict();
export type NotionChildPageCreatedEventCreateConfig = zInfer<
  typeof notionChildPageCreatedEventCreateConfigSchema
>;

export const notionDatabaseItemCreatedEventConfigSchema = object({
  provider: literal("notion"),
  event: literal("database_item_created"),
  connectorId: uuid(),
  dataSource: notionDataSourceReferenceSchema,
}).strict();
export type NotionDatabaseItemCreatedEventConfig = zInfer<
  typeof notionDatabaseItemCreatedEventConfigSchema
>;

export const notionDatabaseItemCreatedEventCreateConfigSchema = object({
  provider: literal("notion"),
  event: literal("database_item_created"),
  databaseUrl: string().trim().min(1).max(2048),
}).strict();
export type NotionDatabaseItemCreatedEventCreateConfig = zInfer<
  typeof notionDatabaseItemCreatedEventCreateConfigSchema
>;

export const notionPageContentUpdatedScopeSchema = discriminatedUnion("type", [
  object({
    type: literal("page"),
    page: notionPageReferenceSchema,
  }).strict(),
  object({
    type: literal("data_source"),
    dataSource: notionDataSourceReferenceSchema,
  }).strict(),
]);
export type NotionPageContentUpdatedScope = zInfer<
  typeof notionPageContentUpdatedScopeSchema
>;

export const notionPageContentUpdatedEventConfigSchema = object({
  provider: literal("notion"),
  event: literal("page_content_updated"),
  connectorId: uuid(),
  scope: notionPageContentUpdatedScopeSchema,
}).strict();
export type NotionPageContentUpdatedEventConfig = zInfer<
  typeof notionPageContentUpdatedEventConfigSchema
>;

export const notionPageContentUpdatedEventCreateConfigSchema = object({
  provider: literal("notion"),
  event: literal("page_content_updated"),
  pageUrl: string().trim().min(1).max(2048).optional(),
  databaseUrl: string().trim().min(1).max(2048).optional(),
})
  .strict()
  .refine(
    (value) => {
      return (
        (value.pageUrl !== undefined) !== (value.databaseUrl !== undefined)
      );
    },
    { message: "Provide exactly one of pageUrl or databaseUrl" },
  );
export type NotionPageContentUpdatedEventCreateConfig = zInfer<
  typeof notionPageContentUpdatedEventCreateConfigSchema
>;

export type NotionAutomationEventConfig =
  | NotionChildPageCreatedEventConfig
  | NotionDatabaseItemCreatedEventConfig
  | NotionPageContentUpdatedEventConfig;

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-based Automation schedule model:
 * - `cron`: recurring at wall-clock times.
 * - `loop`: re-scheduled `intervalSeconds` after each completion.
 * - `once`: fires once at `atTime`, then auto-disables.
 */
export const workflowScheduleSchema = discriminatedUnion("type", [
  object({
    type: literal("cron"),
    cronExpression: string().min(1).max(100),
    timezone: string().min(1),
  }),
  object({
    type: literal("loop"),
    intervalSeconds: number().int().positive(),
  }),
  object({
    type: literal("once"),
    atTime: string().min(1),
    timezone: string().min(1),
  }),
]);
export type WorkflowSchedule = zInfer<typeof workflowScheduleSchema>;

/**
 * Automation summary. Under 1:N the agent is derived from the workflow, so
 * automations no longer carry an agentId. Detail responses only ever list the
 * caller's own automations.
 */
const workflowAutomationSummaryBaseSchema = object({
  id: string(),
  ownerUserId: string(),
  enabled: boolean(),
  chatThreadId: string().nullable(),
  nextRunAt: iso.datetime().nullable(),
  lastRunAt: iso.datetime().nullable(),
  official: object({
    blueprintKey: officialWorkflowBlueprintKeySchema,
    appliedFingerprint: string().regex(/^[0-9a-f]{64}$/),
    reconciliationStatus: zEnum([
      "current",
      "reconciling",
      "needs_reconfiguration",
      "failed",
    ]),
    intendedEnabled: boolean(),
    parameterBindings: array(officialWorkflowParameterBindingSchema),
  })
    .strict()
    .nullable(),
});

export const workflowScheduleAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("schedule"),
    schedule: workflowScheduleSchema,
    scheduleSummary: string(),
  });

export const workflowChatRunFinishedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGmailNewMessageAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGmailLabelAppliedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubPullRequestAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-pull-request"),
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubWorkflowRunCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubWorkflowJobCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubPullRequestReviewSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubDeploymentStatusCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGithubIssueCommentCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowGoogleCalendarEventCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventCancelledAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleFormsResponseSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
    warning: string().optional(),
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowNotionChildPageCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowNotionDatabaseItemCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowNotionPageContentUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const workflowWebhookReceivedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
    webhookUrl: url().optional(),
    secretLastFour: string().length(4),
    disabledReason: literal("paid_plan_required").nullable().optional(),
    lastReceivedAt: iso.datetime().nullable(),
    webhookSecret: string().min(1).optional(),
  });

export const eventAutomationSummarySchema = discriminatedUnion("eventType", [
  workflowChatRunFinishedAutomationSummarySchema,
  workflowGmailNewMessageAutomationSummarySchema,
  workflowGmailLabelAppliedAutomationSummarySchema,
  workflowGithubDeploymentStatusCreatedAutomationSummarySchema,
  workflowGithubIssueCommentCreatedAutomationSummarySchema,
  workflowGithubPullRequestAutomationSummarySchema,
  workflowGithubPullRequestReviewSubmittedAutomationSummarySchema,
  workflowGithubWorkflowJobCompletedAutomationSummarySchema,
  workflowGithubWorkflowRunCompletedAutomationSummarySchema,
  workflowGoogleCalendarEventCreatedAutomationSummarySchema,
  workflowGoogleCalendarEventUpdatedAutomationSummarySchema,
  workflowGoogleCalendarEventCancelledAutomationSummarySchema,
  workflowGoogleFormsResponseSubmittedAutomationSummarySchema,
  workflowGoogleMeetTranscriptGeneratedAutomationSummarySchema,
  workflowNotionChildPageCreatedAutomationSummarySchema,
  workflowNotionDatabaseItemCreatedAutomationSummarySchema,
  workflowNotionPageContentUpdatedAutomationSummarySchema,
  workflowWebhookReceivedAutomationSummarySchema,
]);

export const workflowAutomationSummarySchema = union([
  workflowScheduleAutomationSummarySchema,
  eventAutomationSummarySchema,
]);
export type WorkflowAutomationSummary = zInfer<
  typeof workflowAutomationSummarySchema
>;

const chatThreadWorkflowSchema = object({
  id: uuid(),
  agentId: uuid(),
  name: workflowNameSchema,
  displayName: string().nullable(),
  description: string().nullable(),
});

const chatThreadWorkflowAutomationBaseSchema =
  workflowAutomationSummaryBaseSchema.extend({
    id: uuid(),
    chatThreadId: string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowScheduleAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("schedule"),
    schedule: workflowScheduleSchema,
    scheduleSummary: string(),
  });

export const chatThreadWorkflowChatRunFinishedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGmailNewMessageAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGmailLabelAppliedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubPullRequestAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-pull-request"),
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGoogleFormsResponseSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowNotionChildPageCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowNotionPageContentUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: literal("event"),
    eventType: literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: zNull(),
    scheduleSummary: zNull(),
  });

export const chatThreadWorkflowWebhookReceivedAutomationSchema =
  workflowWebhookReceivedAutomationSummarySchema.extend({
    id: uuid(),
    chatThreadId: string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowAutomationSchema = union([
  chatThreadWorkflowScheduleAutomationSchema,
  chatThreadWorkflowChatRunFinishedAutomationSchema,
  chatThreadWorkflowGmailNewMessageAutomationSchema,
  chatThreadWorkflowGmailLabelAppliedAutomationSchema,
  chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema,
  chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema,
  chatThreadWorkflowGithubPullRequestAutomationSchema,
  chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema,
  chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema,
  chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema,
  chatThreadWorkflowGoogleFormsResponseSubmittedAutomationSchema,
  chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema,
  chatThreadWorkflowNotionChildPageCreatedAutomationSchema,
  chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema,
  chatThreadWorkflowNotionPageContentUpdatedAutomationSchema,
  chatThreadWorkflowWebhookReceivedAutomationSchema,
]);
export type ChatThreadWorkflowAutomation = zInfer<
  typeof chatThreadWorkflowAutomationSchema
>;

export const workflowScheduleAutomationCreateRequestSchema = object({
  kind: literal("schedule").optional(),
  schedule: workflowScheduleSchema,
  enabled: boolean().optional(),
});

export const workflowChatRunFinishedAutomationCreateRequestSchema = object({
  kind: literal("event"),
  eventType: literal("chat-run-finished"),
  eventConfig: chatRunFinishedEventConfigSchema,
  enabled: boolean().optional(),
});

export const workflowGmailNewMessageAutomationCreateRequestSchema = object({
  kind: literal("event"),
  eventType: literal("gmail-new-message"),
  eventConfig: gmailNewMessageEventConfigSchema,
  enabled: boolean().optional(),
});

export const workflowGmailLabelAppliedAutomationCreateRequestSchema = object({
  kind: literal("event"),
  eventType: literal("gmail-label-applied"),
  eventConfig: gmailLabelAppliedEventConfigSchema,
  enabled: boolean().optional(),
});

export const workflowGithubPullRequestAutomationCreateRequestSchema = object({
  kind: literal("event"),
  eventType: literal("github-pull-request"),
  eventConfig: githubPullRequestEventConfigSchema,
  enabled: boolean().optional(),
});

export const workflowGithubWorkflowRunCompletedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGithubWorkflowJobCompletedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGithubIssueCommentCreatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGoogleCalendarEventCreatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      }),
    enabled: boolean().optional(),
  });

export const workflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      }),
    enabled: boolean().optional(),
  });

export const workflowGoogleCalendarEventCancelledAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      }),
    enabled: boolean().optional(),
  });

export const workflowGoogleFormsResponseSubmittedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventCreateConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema
      .optional()
      .default({
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      }),
    enabled: boolean().optional(),
  });

export const workflowNotionChildPageCreatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventCreateConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowNotionDatabaseItemCreatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventCreateConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowNotionPageContentUpdatedAutomationCreateRequestSchema =
  object({
    kind: literal("event"),
    eventType: literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventCreateConfigSchema,
    enabled: boolean().optional(),
  });

export const workflowWebhookReceivedAutomationCreateRequestSchema = object({
  kind: literal("event"),
  eventType: literal("webhook-received"),
  eventConfig: webhookReceivedEventConfigSchema.optional(),
  enabled: boolean().optional(),
});

export const workflowAutomationCreateRequestSchema = union([
  workflowScheduleAutomationCreateRequestSchema,
  workflowChatRunFinishedAutomationCreateRequestSchema,
  workflowGmailNewMessageAutomationCreateRequestSchema,
  workflowGmailLabelAppliedAutomationCreateRequestSchema,
  workflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema,
  workflowGithubIssueCommentCreatedAutomationCreateRequestSchema,
  workflowGithubPullRequestAutomationCreateRequestSchema,
  workflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema,
  workflowGithubWorkflowJobCompletedAutomationCreateRequestSchema,
  workflowGithubWorkflowRunCompletedAutomationCreateRequestSchema,
  workflowGoogleCalendarEventCreatedAutomationCreateRequestSchema,
  workflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema,
  workflowGoogleCalendarEventCancelledAutomationCreateRequestSchema,
  workflowGoogleFormsResponseSubmittedAutomationCreateRequestSchema,
  workflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema,
  workflowNotionChildPageCreatedAutomationCreateRequestSchema,
  workflowNotionDatabaseItemCreatedAutomationCreateRequestSchema,
  workflowNotionPageContentUpdatedAutomationCreateRequestSchema,
  workflowWebhookReceivedAutomationCreateRequestSchema,
]);
export type WorkflowAutomationCreateRequest = zInfer<
  typeof workflowAutomationCreateRequestSchema
>;

export const workflowScheduleAutomationUpdateRequestSchema = object({
  schedule: workflowScheduleSchema,
});

export const workflowGmailEventAutomationUpdateRequestSchema = object({
  eventConfig: gmailAutomationEventConfigSchema,
});

export const workflowGithubEventAutomationUpdateRequestSchema = object({
  eventConfig: githubAutomationEventConfigSchema,
});

export const workflowGoogleCalendarEventAutomationUpdateRequestSchema = object({
  eventConfig: googleCalendarAutomationEventConfigSchema,
});

export const workflowAutomationUpdateRequestSchema = union([
  workflowScheduleAutomationUpdateRequestSchema,
  workflowGmailEventAutomationUpdateRequestSchema,
  workflowGithubEventAutomationUpdateRequestSchema,
  workflowGoogleCalendarEventAutomationUpdateRequestSchema,
]);
export type WorkflowAutomationUpdateRequest = zInfer<
  typeof workflowAutomationUpdateRequestSchema
>;

/**
 * Workflow summary. A workflow belongs to exactly one agent (`agentId`).
 * `canManage` reflects the caller's effective rights (agent write-permission
 * for public workflows; ownership for private ones).
 */
export const workflowSummarySchema = object({
  id: uuid(),
  agentId: uuid(),
  agentName: string().nullable(),
  agentDisplayName: string().nullable(),
  name: workflowNameSchema,
  displayName: string().max(256).nullable(),
  description: string().max(1024).nullable(),
  visibility: workflowVisibilitySchema,
  ownerUserId: string(),
  createdAt: iso.datetime(),
  canManage: boolean(),
  canPublish: boolean(),
  official: object({
    definitionName: workflowNameSchema,
    installationState: zEnum(["installing", "installed"]),
    definitionLifecycle: zEnum(["active", "retired", "unavailable"]),
    readOnly: literal(true),
  })
    .strict()
    .nullable(),
  shadowedBy: object({
    id: uuid(),
    name: workflowNameSchema,
    displayName: string().max(256).nullable(),
  })
    .nullable()
    .optional(),
  importSource: workflowImportSourceSchema.nullable(),
});

export const workflowDetailResponseSchema = workflowSummarySchema.extend({
  createdByUserId: string(),
  updatedByUserId: string(),
  updatedAt: iso.datetime(),
  instruction: string().nullable(),
  files: array(workflowFileMetadataSchema).nullable(),
  // Updates return metadata without reading R2. GET supplies file bodies.
  fileContents: array(workflowFileEntrySchema).nullable(),
  automations: array(workflowAutomationSummarySchema),
});

export const workflowListResponseSchema = array(workflowSummarySchema);

/**
 * What the chat composer needs to offer and highlight `/workflow` commands:
 * the agent's own workflows that are not shadowed by a private override.
 */
export const composerWorkflowSchema = workflowSummarySchema.pick({
  id: true,
  name: true,
  displayName: true,
  description: true,
});

export const composerWorkflowListResponseSchema = array(composerWorkflowSchema);

export const workflowAutomationsListEntrySchema = object({
  workflow: workflowSummarySchema,
  automation: workflowAutomationSummarySchema,
});
export const workflowAutomationsListResponseSchema = array(
  workflowAutomationsListEntrySchema,
);

export const workflowCreateRequestSchema = object({
  agentId: uuid(),
  chatThreadId: uuid().optional(),
  name: workflowNameSchema,
  instruction: workflowInstructionSchema.optional(),
  files: workflowFilesSchema.optional(),
  displayName: string().max(256).optional(),
  description: string().max(1024).optional(),
  visibility: workflowVisibilitySchema.optional(),
});

export const workflowUpdateRequestSchema = object({
  name: workflowNameSchema.optional(),
  instruction: workflowInstructionSchema.nullable().optional(),
  files: workflowFilesSchema.optional(),
  displayName: string().max(256).nullable().optional(),
  description: string().max(1024).nullable().optional(),
}).refine(
  (body) => {
    return (
      body.name !== undefined ||
      body.instruction !== undefined ||
      body.files !== undefined ||
      body.displayName !== undefined ||
      body.description !== undefined
    );
  },
  { message: "At least one workflow update is required" },
);

export const workflowCopyRequestSchema = object({
  toAgentId: uuid(),
});

export const workflowRunResponseSchema = object({
  chatThreadId: uuid(),
  // Null means the manual invocation is waiting in the chat thread queue and
  // no run has been created for it yet.
  runId: string().nullable(),
});

export const workflowChatThreadResponseSchema = object({
  chatThreadId: uuid(),
  prompt: string(),
});

const workflowIdParams = object({ workflowId: uuid() });

export const workflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/workflows",
    headers: authHeadersSchema,
    query: object({ agentId: uuid().optional() }),
    responses: {
      200: workflowListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible workflows, optionally scoped to one agent",
  },
  composer: {
    method: "GET",
    path: "/api/workflows/for-composer",
    headers: authHeadersSchema,
    query: object({ agentId: uuid() }),
    responses: {
      200: composerWorkflowListResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "List the slash-command workflows the composer offers for one agent",
  },
  create: {
    method: "POST",
    path: "/api/workflows",
    headers: authHeadersSchema,
    body: workflowCreateRequestSchema,
    responses: {
      201: workflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a workflow under an agent",
  },
});

export const workflowOwnerProfileSchema = object({
  displayName: string().nullable(),
  imageUrl: string().nullable(),
});
export type WorkflowOwnerProfile = zInfer<typeof workflowOwnerProfileSchema>;

export const workflowsDetailContract = c.router({
  ownerProfile: {
    method: "GET",
    path: "/api/workflows/:workflowId/owner-profile",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: workflowOwnerProfileSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get the display profile of a visible workflow's owner",
  },
  get: {
    method: "GET",
    path: "/api/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: workflowDetailResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow with its instruction and files",
  },
  update: {
    method: "PATCH",
    path: "/api/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: workflowUpdateRequestSchema,
    responses: {
      200: workflowDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow's instruction, files, or metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete a workflow",
  },
  copy: {
    method: "POST",
    path: "/api/workflows/:workflowId/copy",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: workflowCopyRequestSchema,
    responses: {
      201: workflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Copy (fork) a workflow onto another agent",
  },
  chatThread: {
    method: "POST",
    path: "/api/workflows/:workflowId/chat-thread",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: workflowChatThreadResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get or create the shared chat thread for a workflow",
  },
  run: {
    method: "POST",
    path: "/api/workflows/:workflowId/run",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: workflowRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Run the workflow once in its shared chat thread (equivalent to /slug)",
  },
});

/** Visibility transitions. */
export const workflowVisibilityContract = c.router({
  publish: {
    method: "POST",
    path: "/api/workflows/:workflowId/publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: workflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Publish a private workflow",
  },
  demote: {
    method: "POST",
    path: "/api/workflows/:workflowId/demote",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: workflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Agent write-permission holder demotes a public workflow to private",
  },
});

const automationIdParams = object({ id: uuid() });
const chatThreadIdParams = object({ threadId: string().min(1) });

export const workflowWebhookSecretResponseSchema = object({
  webhookUrl: url(),
  webhookSecret: string().min(1),
});
export type WorkflowWebhookSecretResponse = zInfer<
  typeof workflowWebhookSecretResponseSchema
>;

export const workflowAutomationsContract = c.router({
  listWorkspace: {
    method: "GET",
    path: "/api/workflow-automations",
    headers: authHeadersSchema,
    responses: {
      200: workflowAutomationsListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List the caller's automations across visible workflows",
  },
  listForChatThread: {
    method: "GET",
    path: "/api/chat-threads/:threadId/workflow-automations",
    headers: authHeadersSchema,
    pathParams: chatThreadIdParams,
    responses: {
      200: array(chatThreadWorkflowAutomationSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List workflow automations bound to a chat thread",
  },
  list: {
    method: "GET",
    path: "/api/workflows/:workflowId/automations",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: array(workflowAutomationSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List the caller's own automations for a workflow",
  },
  create: {
    method: "POST",
    path: "/api/workflows/:workflowId/automations",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: workflowAutomationCreateRequestSchema,
    responses: {
      201: workflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create an automation on a workflow",
  },
  get: {
    method: "GET",
    path: "/api/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    responses: {
      200: workflowAutomationSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow automation",
  },
  update: {
    method: "PATCH",
    path: "/api/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: workflowAutomationUpdateRequestSchema,
    responses: {
      200: workflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow automation",
  },
  delete: {
    method: "DELETE",
    path: "/api/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete a workflow automation",
  },
  enable: {
    method: "POST",
    path: "/api/workflow-automations/:id/enable",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: workflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Enable a workflow automation",
  },
  disable: {
    method: "POST",
    path: "/api/workflow-automations/:id/disable",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: workflowAutomationSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Disable a workflow automation",
  },
  run: {
    method: "POST",
    path: "/api/workflow-automations/:id/run",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      201: workflowRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Submit a workflow automation run in its bound chat thread",
  },
  revealWebhookSecret: {
    method: "POST",
    path: "/api/workflow-automations/:id/webhook-secret",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: workflowWebhookSecretResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Reveal the webhook URL and signing secret for a workflow automation",
  },
});

export type WorkflowFileEntry = zInfer<typeof workflowFileEntrySchema>;
export type WorkflowFileMetadata = zInfer<typeof workflowFileMetadataSchema>;
export type WorkflowSummary = zInfer<typeof workflowSummarySchema>;
export type ComposerWorkflow = zInfer<typeof composerWorkflowSchema>;
export type WorkflowDetailResponse = zInfer<
  typeof workflowDetailResponseSchema
>;
export type WorkflowCreateRequest = zInfer<typeof workflowCreateRequestSchema>;
export type WorkflowUpdateRequest = zInfer<typeof workflowUpdateRequestSchema>;
export type WorkflowCopyRequest = zInfer<typeof workflowCopyRequestSchema>;
export type WorkflowChatThreadResponse = zInfer<
  typeof workflowChatThreadResponseSchema
>;
export type WorkflowRunResponse = zInfer<typeof workflowRunResponseSchema>;
export type WorkflowAutomationsListEntry = zInfer<
  typeof workflowAutomationsListEntrySchema
>;
export type WorkflowsCollectionContract = typeof workflowsCollectionContract;
export type WorkflowsDetailContract = typeof workflowsDetailContract;
export type WorkflowVisibilityContract = typeof workflowVisibilityContract;
export type WorkflowAutomationsContract = typeof workflowAutomationsContract;
