import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  union,
  url,
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

export {
  workflowImportSourceSchema,
  type WorkflowImportSource,
} from "./workflow-import-source";

const c = initContract();

// Reuse identical leaf schemas across automation variants. Keep full Zod
// objects for runtime validation, schema reflection, and generated bindings.
const textSchema = string();
const nullValueSchema = zNull();
const flagSchema = boolean();
const eventAutomationKindSchema = literal("event");
const scheduleAutomationKindSchema = literal("schedule");
const githubProviderSchema = literal("github");
const notionProviderSchema = literal("notion");
const googleCalendarProviderSchema = literal("google-calendar");
const urlSchema = url();
const chatRunFinishedEventTypeSchema = literal("chat-run-finished");
const gmailNewMessageEventTypeSchema = literal("gmail-new-message");
const gmailLabelAppliedEventTypeSchema = literal("gmail-label-applied");
const githubPullRequestEventTypeSchema = literal("github-pull-request");
const githubWorkflowRunCompletedEventTypeSchema = literal(
  "github-workflow-run-completed",
);
const githubWorkflowJobCompletedEventTypeSchema = literal(
  "github-workflow-job-completed",
);
const githubPullRequestReviewSubmittedEventTypeSchema = literal(
  "github-pull-request-review-submitted",
);
const githubDeploymentStatusCreatedEventTypeSchema = literal(
  "github-deployment-status-created",
);
const githubIssueCommentCreatedEventTypeSchema = literal(
  "github-issue-comment-created",
);
const googleCalendarEventCreatedEventTypeSchema = literal(
  "google-calendar-event-created",
);
const googleCalendarEventUpdatedEventTypeSchema = literal(
  "google-calendar-event-updated",
);
const googleCalendarEventCancelledEventTypeSchema = literal(
  "google-calendar-event-cancelled",
);
const googleFormsResponseSubmittedEventTypeSchema = literal(
  "google-forms-response-submitted",
);
const googleMeetTranscriptGeneratedEventTypeSchema = literal(
  "google-meet-transcript-generated",
);
const notionChildPageCreatedEventTypeSchema = literal(
  "notion-child-page-created",
);
const notionDatabaseItemCreatedEventTypeSchema = literal(
  "notion-database-item-created",
);
const notionPageContentUpdatedEventTypeSchema = literal(
  "notion-page-content-updated",
);
const workflowUuidSchema = textSchema.uuid();
const optionalFlagSchema = flagSchema.optional();
const nonEmptyTextSchema = textSchema.min(1);
const trimmedTextSchema = textSchema.trim();
const nullableTextSchema = textSchema.nullable();
const timestampSchema = textSchema.datetime();
const workflowDisplayNameSchema = textSchema.max(256);
const workflowDescriptionSchema = textSchema.max(1024);
const nonEmptyTrimmedTextSchema = trimmedTextSchema.min(1);
const nullableTimestampSchema = timestampSchema.nullable();
const optionalNonEmptyTextSchema = nonEmptyTextSchema.optional();
const nullableWorkflowDisplayNameSchema = workflowDisplayNameSchema.nullable();
const externalResourceUrlSchema = nonEmptyTrimmedTextSchema.max(2048);
const trimmedTextMax1024Schema = nonEmptyTrimmedTextSchema.max(1024);
const trimmedTextMax255Schema = nonEmptyTrimmedTextSchema.max(255);

export const workflowVisibilitySchema = zEnum(["public", "private"]);
export type WorkflowVisibility = zInfer<typeof workflowVisibilitySchema>;

/**
 * Workflow name (slug) validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters. Slugs are NOT unique — duplicates across and within an
 * agent are allowed; run-time picks a winner by a fixed priority rule.
 */
export const workflowNameSchema = textSchema
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
  path: nonEmptyTextSchema
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
  content: textSchema,
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
  path: textSchema,
  size: number(),
});

export const workflowInstructionSchema = textSchema.max(
  WORKFLOW_FILES_MAX_BYTES,
);

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
  chatThreadId: workflowUuidSchema,
  runStatuses: array(chatRunFinishedRunStatusSchema).min(1).optional(),
  outputPattern: nonEmptyTrimmedTextSchema.max(512).optional(),
}).strict();
export type ChatRunFinishedEventConfig = zInfer<
  typeof chatRunFinishedEventConfigSchema
>;

const gmailTextMatchSchema = object({
  contains: optionalNonEmptyTextSchema,
  containsAny: array(nonEmptyTextSchema).min(1).optional(),
  doesNotContain: optionalNonEmptyTextSchema,
  doesNotContainAny: array(nonEmptyTextSchema).min(1).optional(),
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
  threadId: optionalNonEmptyTextSchema,
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
  labelName: nonEmptyTrimmedTextSchema.max(225),
  resolvedLabelId: nonEmptyTextSchema.max(128).optional(),
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

const githubFilterValuesSchema = array(trimmedTextMax255Schema).min(1).max(100);

export const githubWorkflowRunCompletedEventConfigSchema = object({
  provider: githubProviderSchema,
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
  provider: githubProviderSchema,
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
  provider: githubProviderSchema,
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
  provider: githubProviderSchema,
  event: literal("deployment_status_created"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    environments: githubFilterValuesSchema.optional(),
    states: array(githubDeploymentStateSchema)
      .min(1)
      .max(githubDeploymentStateSchema.options.length)
      .optional(),
    refs: githubFilterValuesSchema.optional(),
    productionEnvironment: optionalFlagSchema,
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
  provider: githubProviderSchema,
  event: literal("issue_comment_created"),
  filters: object({
    repositories: githubFilterValuesSchema.optional(),
    subject: githubIssueCommentSubjectFilterSchema.default("both"),
    trustedAuthors: githubFilterValuesSchema.optional(),
    commentPrefixes: array(trimmedTextMax1024Schema).min(1).max(100).optional(),
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
  provider: githubProviderSchema,
  event: literal("pull_request"),
  repository: trimmedTextMax255Schema,
  action: githubPullRequestActionSchema,
  merged: optionalFlagSchema,
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
  provider: googleCalendarProviderSchema,
  event: literal("event_created"),
  calendarId: trimmedTextMax1024Schema.default("primary"),
}).strict();
export type GoogleCalendarEventCreatedEventConfig = zInfer<
  typeof googleCalendarEventCreatedEventConfigSchema
>;

export const googleCalendarEventUpdatedEventConfigSchema = object({
  provider: googleCalendarProviderSchema,
  event: literal("event_updated"),
  calendarId: trimmedTextMax1024Schema.default("primary"),
}).strict();
export type GoogleCalendarEventUpdatedEventConfig = zInfer<
  typeof googleCalendarEventUpdatedEventConfigSchema
>;

export const googleCalendarEventCancelledEventConfigSchema = object({
  provider: googleCalendarProviderSchema,
  event: literal("event_cancelled"),
  calendarId: trimmedTextMax1024Schema.default("primary"),
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
  id: trimmedTextMax255Schema,
  title: nonEmptyTrimmedTextSchema.max(512),
  url: urlSchema,
}).strict();
export type GoogleFormsFormReference = zInfer<
  typeof googleFormsFormReferenceSchema
>;

export const googleFormsResponseSubmittedEventConfigSchema = object({
  provider: literal("google-forms"),
  event: literal("response_submitted"),
  connectorId: workflowUuidSchema,
  form: googleFormsFormReferenceSchema,
}).strict();
export type GoogleFormsResponseSubmittedEventConfig = zInfer<
  typeof googleFormsResponseSubmittedEventConfigSchema
>;

export const googleFormsResponseSubmittedEventCreateConfigSchema = object({
  provider: literal("google-forms"),
  event: literal("response_submitted"),
  formUrl: externalResourceUrlSchema,
}).strict();
export type GoogleFormsResponseSubmittedEventCreateConfig = zInfer<
  typeof googleFormsResponseSubmittedEventCreateConfigSchema
>;

export type GoogleFormsAutomationEventConfig =
  GoogleFormsResponseSubmittedEventConfig;

export const notionPageReferenceSchema = object({
  id: workflowUuidSchema,
  url: urlSchema,
  title: nullableTextSchema,
  rawUrl: nonEmptyTextSchema.max(2048).optional(),
}).strict();
export type NotionPageReference = zInfer<typeof notionPageReferenceSchema>;

export const notionDataSourceReferenceSchema = object({
  id: workflowUuidSchema,
  url: urlSchema,
  title: nullableTextSchema,
  rawUrl: nonEmptyTextSchema.max(2048).optional(),
}).strict();
export type NotionDataSourceReference = zInfer<
  typeof notionDataSourceReferenceSchema
>;

export const notionChildPageCreatedEventConfigSchema = object({
  provider: notionProviderSchema,
  event: literal("child_page_created"),
  connectorId: workflowUuidSchema,
  parentPage: notionPageReferenceSchema,
}).strict();
export type NotionChildPageCreatedEventConfig = zInfer<
  typeof notionChildPageCreatedEventConfigSchema
>;

export const notionChildPageCreatedEventCreateConfigSchema = object({
  provider: notionProviderSchema,
  event: literal("child_page_created"),
  parentPageUrl: externalResourceUrlSchema,
}).strict();
export type NotionChildPageCreatedEventCreateConfig = zInfer<
  typeof notionChildPageCreatedEventCreateConfigSchema
>;

export const notionDatabaseItemCreatedEventConfigSchema = object({
  provider: notionProviderSchema,
  event: literal("database_item_created"),
  connectorId: workflowUuidSchema,
  dataSource: notionDataSourceReferenceSchema,
}).strict();
export type NotionDatabaseItemCreatedEventConfig = zInfer<
  typeof notionDatabaseItemCreatedEventConfigSchema
>;

export const notionDatabaseItemCreatedEventCreateConfigSchema = object({
  provider: notionProviderSchema,
  event: literal("database_item_created"),
  databaseUrl: externalResourceUrlSchema,
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
  provider: notionProviderSchema,
  event: literal("page_content_updated"),
  connectorId: workflowUuidSchema,
  scope: notionPageContentUpdatedScopeSchema,
}).strict();
export type NotionPageContentUpdatedEventConfig = zInfer<
  typeof notionPageContentUpdatedEventConfigSchema
>;

export const notionPageContentUpdatedEventCreateConfigSchema = object({
  provider: notionProviderSchema,
  event: literal("page_content_updated"),
  pageUrl: externalResourceUrlSchema.optional(),
  databaseUrl: externalResourceUrlSchema.optional(),
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
    cronExpression: nonEmptyTextSchema.max(100),
    timezone: nonEmptyTextSchema,
  }),
  object({
    type: literal("loop"),
    intervalSeconds: number().int().positive(),
  }),
  object({
    type: literal("once"),
    atTime: nonEmptyTextSchema,
    timezone: nonEmptyTextSchema,
  }),
]);
export type WorkflowSchedule = zInfer<typeof workflowScheduleSchema>;

/**
 * Automation summary. Under 1:N the agent is derived from the workflow, so
 * automations no longer carry an agentId. Detail responses only ever list the
 * caller's own automations.
 */
const workflowAutomationSummaryBaseSchema = object({
  id: textSchema,
  ownerUserId: textSchema,
  enabled: flagSchema,
  chatThreadId: nullableTextSchema,
  nextRunAt: nullableTimestampSchema,
  lastRunAt: nullableTimestampSchema,
  official: object({
    blueprintKey: officialWorkflowBlueprintKeySchema,
    appliedFingerprint: textSchema.regex(/^[0-9a-f]{64}$/),
    reconciliationStatus: zEnum([
      "current",
      "reconciling",
      "needs_reconfiguration",
      "failed",
    ]),
    intendedEnabled: flagSchema,
    parameterBindings: array(officialWorkflowParameterBindingSchema),
  })
    .strict()
    .nullable(),
});

export const workflowScheduleAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: scheduleAutomationKindSchema,
    schedule: workflowScheduleSchema,
    scheduleSummary: textSchema,
  });

export const workflowChatRunFinishedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: chatRunFinishedEventTypeSchema,
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGmailNewMessageAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: gmailNewMessageEventTypeSchema,
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGmailLabelAppliedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: gmailLabelAppliedEventTypeSchema,
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubPullRequestAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubPullRequestEventTypeSchema,
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubWorkflowRunCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowRunCompletedEventTypeSchema,
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubWorkflowJobCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowJobCompletedEventTypeSchema,
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubPullRequestReviewSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubPullRequestReviewSubmittedEventTypeSchema,
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubDeploymentStatusCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubDeploymentStatusCreatedEventTypeSchema,
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGithubIssueCommentCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubIssueCommentCreatedEventTypeSchema,
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowGoogleCalendarEventCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCreatedEventTypeSchema,
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventUpdatedEventTypeSchema,
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventCancelledAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCancelledEventTypeSchema,
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleFormsResponseSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleFormsResponseSubmittedEventTypeSchema,
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
    warning: textSchema.optional(),
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleMeetTranscriptGeneratedEventTypeSchema,
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowNotionChildPageCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionChildPageCreatedEventTypeSchema,
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowNotionDatabaseItemCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionDatabaseItemCreatedEventTypeSchema,
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowNotionPageContentUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionPageContentUpdatedEventTypeSchema,
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const workflowWebhookReceivedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
    webhookUrl: urlSchema.optional(),
    secretLastFour: textSchema.length(4),
    disabledReason: literal("paid_plan_required").nullable().optional(),
    lastReceivedAt: nullableTimestampSchema,
    webhookSecret: optionalNonEmptyTextSchema,
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
  id: workflowUuidSchema,
  agentId: workflowUuidSchema,
  name: workflowNameSchema,
  displayName: nullableTextSchema,
  description: nullableTextSchema,
});

const chatThreadWorkflowAutomationBaseSchema =
  workflowAutomationSummaryBaseSchema.extend({
    id: workflowUuidSchema,
    chatThreadId: nonEmptyTextSchema,
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowScheduleAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: scheduleAutomationKindSchema,
    schedule: workflowScheduleSchema,
    scheduleSummary: textSchema,
  });

export const chatThreadWorkflowChatRunFinishedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: chatRunFinishedEventTypeSchema,
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGmailNewMessageAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: gmailNewMessageEventTypeSchema,
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGmailLabelAppliedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: gmailLabelAppliedEventTypeSchema,
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubPullRequestAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubPullRequestEventTypeSchema,
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowRunCompletedEventTypeSchema,
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowJobCompletedEventTypeSchema,
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubPullRequestReviewSubmittedEventTypeSchema,
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubDeploymentStatusCreatedEventTypeSchema,
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: githubIssueCommentCreatedEventTypeSchema,
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCreatedEventTypeSchema,
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventUpdatedEventTypeSchema,
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCancelledEventTypeSchema,
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGoogleFormsResponseSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleFormsResponseSubmittedEventTypeSchema,
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: googleMeetTranscriptGeneratedEventTypeSchema,
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowNotionChildPageCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionChildPageCreatedEventTypeSchema,
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionDatabaseItemCreatedEventTypeSchema,
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowNotionPageContentUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: eventAutomationKindSchema,
    eventType: notionPageContentUpdatedEventTypeSchema,
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: nullValueSchema,
    scheduleSummary: nullValueSchema,
  });

export const chatThreadWorkflowWebhookReceivedAutomationSchema =
  workflowWebhookReceivedAutomationSummarySchema.extend({
    id: workflowUuidSchema,
    chatThreadId: nonEmptyTextSchema,
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
  kind: scheduleAutomationKindSchema.optional(),
  schedule: workflowScheduleSchema,
  enabled: optionalFlagSchema,
});

export const workflowChatRunFinishedAutomationCreateRequestSchema = object({
  kind: eventAutomationKindSchema,
  eventType: chatRunFinishedEventTypeSchema,
  eventConfig: chatRunFinishedEventConfigSchema,
  enabled: optionalFlagSchema,
});

export const workflowGmailNewMessageAutomationCreateRequestSchema = object({
  kind: eventAutomationKindSchema,
  eventType: gmailNewMessageEventTypeSchema,
  eventConfig: gmailNewMessageEventConfigSchema,
  enabled: optionalFlagSchema,
});

export const workflowGmailLabelAppliedAutomationCreateRequestSchema = object({
  kind: eventAutomationKindSchema,
  eventType: gmailLabelAppliedEventTypeSchema,
  eventConfig: gmailLabelAppliedEventConfigSchema,
  enabled: optionalFlagSchema,
});

export const workflowGithubPullRequestAutomationCreateRequestSchema = object({
  kind: eventAutomationKindSchema,
  eventType: githubPullRequestEventTypeSchema,
  eventConfig: githubPullRequestEventConfigSchema,
  enabled: optionalFlagSchema,
});

export const workflowGithubWorkflowRunCompletedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowRunCompletedEventTypeSchema,
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGithubWorkflowJobCompletedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: githubWorkflowJobCompletedEventTypeSchema,
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: githubPullRequestReviewSubmittedEventTypeSchema,
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: githubDeploymentStatusCreatedEventTypeSchema,
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGithubIssueCommentCreatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: githubIssueCommentCreatedEventTypeSchema,
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGoogleCalendarEventCreatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCreatedEventTypeSchema,
    eventConfig: googleCalendarEventCreatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      }),
    enabled: optionalFlagSchema,
  });

export const workflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventUpdatedEventTypeSchema,
    eventConfig: googleCalendarEventUpdatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      }),
    enabled: optionalFlagSchema,
  });

export const workflowGoogleCalendarEventCancelledAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: googleCalendarEventCancelledEventTypeSchema,
    eventConfig: googleCalendarEventCancelledEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      }),
    enabled: optionalFlagSchema,
  });

export const workflowGoogleFormsResponseSubmittedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: googleFormsResponseSubmittedEventTypeSchema,
    eventConfig: googleFormsResponseSubmittedEventCreateConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: googleMeetTranscriptGeneratedEventTypeSchema,
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema
      .optional()
      .default({
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      }),
    enabled: optionalFlagSchema,
  });

export const workflowNotionChildPageCreatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: notionChildPageCreatedEventTypeSchema,
    eventConfig: notionChildPageCreatedEventCreateConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowNotionDatabaseItemCreatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: notionDatabaseItemCreatedEventTypeSchema,
    eventConfig: notionDatabaseItemCreatedEventCreateConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowNotionPageContentUpdatedAutomationCreateRequestSchema =
  object({
    kind: eventAutomationKindSchema,
    eventType: notionPageContentUpdatedEventTypeSchema,
    eventConfig: notionPageContentUpdatedEventCreateConfigSchema,
    enabled: optionalFlagSchema,
  });

export const workflowWebhookReceivedAutomationCreateRequestSchema = object({
  kind: eventAutomationKindSchema,
  eventType: literal("webhook-received"),
  eventConfig: webhookReceivedEventConfigSchema.optional(),
  enabled: optionalFlagSchema,
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
  id: workflowUuidSchema,
  agentId: workflowUuidSchema,
  agentName: nullableTextSchema,
  agentDisplayName: nullableTextSchema,
  name: workflowNameSchema,
  displayName: nullableWorkflowDisplayNameSchema,
  description: workflowDescriptionSchema.nullable(),
  visibility: workflowVisibilitySchema,
  ownerUserId: textSchema,
  createdAt: timestampSchema,
  canManage: flagSchema,
  canPublish: flagSchema,
  official: object({
    definitionName: workflowNameSchema,
    installationState: zEnum(["installing", "installed"]),
    definitionLifecycle: zEnum(["active", "retired", "unavailable"]),
    readOnly: literal(true),
  })
    .strict()
    .nullable(),
  shadowedBy: object({
    id: workflowUuidSchema,
    name: workflowNameSchema,
    displayName: nullableWorkflowDisplayNameSchema,
  })
    .nullable()
    .optional(),
  importSource: workflowImportSourceSchema.nullable(),
});

export const workflowDetailResponseSchema = workflowSummarySchema.extend({
  createdByUserId: textSchema,
  updatedByUserId: textSchema,
  updatedAt: timestampSchema,
  instruction: nullableTextSchema,
  files: array(workflowFileMetadataSchema).nullable(),
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
  agentId: workflowUuidSchema,
  chatThreadId: workflowUuidSchema.optional(),
  name: workflowNameSchema,
  instruction: workflowInstructionSchema.optional(),
  files: workflowFilesSchema.optional(),
  displayName: workflowDisplayNameSchema.optional(),
  description: workflowDescriptionSchema.optional(),
  visibility: workflowVisibilitySchema.optional(),
});

export const workflowUpdateRequestSchema = object({
  name: workflowNameSchema.optional(),
  instruction: workflowInstructionSchema.nullable().optional(),
  files: workflowFilesSchema.optional(),
  displayName: nullableWorkflowDisplayNameSchema.optional(),
  description: workflowDescriptionSchema.nullable().optional(),
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
  toAgentId: workflowUuidSchema,
});

export const workflowRunResponseSchema = object({
  chatThreadId: workflowUuidSchema,
  // Null means the manual invocation is waiting in the chat thread queue and
  // no run has been created for it yet.
  runId: nullableTextSchema,
});

export const workflowChatThreadResponseSchema = object({
  chatThreadId: workflowUuidSchema,
  prompt: textSchema,
});

const workflowIdParams = object({ workflowId: workflowUuidSchema });

export const workflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/workflows",
    headers: authHeadersSchema,
    query: object({ agentId: workflowUuidSchema.optional() }),
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
    query: object({ agentId: workflowUuidSchema }),
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
  displayName: nullableTextSchema,
  imageUrl: nullableTextSchema,
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

const automationIdParams = object({ id: workflowUuidSchema });
const chatThreadIdParams = object({ threadId: nonEmptyTextSchema });

export const workflowWebhookSecretResponseSchema = object({
  webhookUrl: urlSchema,
  webhookSecret: nonEmptyTextSchema,
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
