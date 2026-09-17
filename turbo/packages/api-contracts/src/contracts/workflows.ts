import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  officialWorkflowBlueprintKeySchema,
  officialWorkflowParameterBindingSchema,
} from "./official-workflow-bindings";

const c = initContract();

export const workflowVisibilitySchema = z.enum(["public", "private"]);
export type WorkflowVisibility = z.infer<typeof workflowVisibilitySchema>;

/**
 * Workflow name (slug) validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters. Slugs are NOT unique — duplicates across and within an
 * agent are allowed; run-time picks a winner by a fixed priority rule.
 */
export const workflowNameSchema = z
  .string()
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
export const workflowFileEntrySchema = z.object({
  path: z
    .string()
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
  content: z.string(),
});

const WORKFLOW_FILES_MAX_BYTES = 5 * 1024 * 1024;
const WORKFLOW_FILES_MAX_COUNT = 500;

/**
 * Attached files (excluding the synthesized SKILL.md). May be empty.
 */
export const workflowFilesSchema = z
  .array(workflowFileEntrySchema)
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

export const workflowFileMetadataSchema = z.object({
  path: z.string(),
  size: z.number(),
});

export const workflowInstructionSchema = z
  .string()
  .max(WORKFLOW_FILES_MAX_BYTES);

export const workflowScheduleTypeSchema = z.enum(["cron", "loop", "once"]);
export type WorkflowScheduleType = z.infer<typeof workflowScheduleTypeSchema>;

export const workflowAutomationKindSchema = z.enum(["schedule", "event"]);
export type WorkflowAutomationKind = z.infer<
  typeof workflowAutomationKindSchema
>;

export const automationEventTypeSchema = z.enum([
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
  "stripe-invoice-paid",
  "webhook-received",
]);
export type WorkflowAutomationEventType = z.infer<
  typeof automationEventTypeSchema
>;

export const chatRunFinishedRunStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
]);
export type ChatRunFinishedRunStatus = z.infer<
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
export const chatRunFinishedEventConfigSchema = z
  .object({
    provider: z.literal("chat"),
    event: z.literal("run_finished"),
    chatThreadId: z.string().uuid(),
    runStatuses: z.array(chatRunFinishedRunStatusSchema).min(1).optional(),
    outputPattern: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type ChatRunFinishedEventConfig = z.infer<
  typeof chatRunFinishedEventConfigSchema
>;

const gmailTextMatchSchema = z
  .object({
    contains: z.string().min(1).optional(),
    containsAny: z.array(z.string().min(1)).min(1).optional(),
    doesNotContain: z.string().min(1).optional(),
    doesNotContainAny: z.array(z.string().min(1)).min(1).optional(),
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

export const gmailNewMessageEventConfigSchema = z
  .object({
    provider: z.literal("gmail"),
    event: z.literal("new_message"),
    threadId: z.string().min(1).optional(),
    match: z
      .object({
        from: gmailTextMatchSchema.optional(),
        subject: gmailTextMatchSchema.optional(),
        body: gmailTextMatchSchema.optional(),
        to: gmailTextMatchSchema.optional(),
        cc: gmailTextMatchSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GmailNewMessageEventConfig = z.infer<
  typeof gmailNewMessageEventConfigSchema
>;

export const gmailLabelAppliedEventConfigSchema = z
  .object({
    provider: z.literal("gmail"),
    event: z.literal("label_applied"),
    labelName: z.string().trim().min(1).max(225),
    resolvedLabelId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type GmailLabelAppliedEventConfig = z.infer<
  typeof gmailLabelAppliedEventConfigSchema
>;

export const gmailAutomationEventConfigSchema = z.discriminatedUnion("event", [
  gmailNewMessageEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
]);
export type GmailAutomationEventConfig = z.infer<
  typeof gmailAutomationEventConfigSchema
>;

export const webhookReceivedEventConfigSchema = z
  .object({
    provider: z.literal("webhook"),
    event: z.literal("received"),
    auth: z
      .object({
        mode: z.literal("hmac-sha256"),
      })
      .strict(),
  })
  .strict();
export type WebhookReceivedEventConfig = z.infer<
  typeof webhookReceivedEventConfigSchema
>;

export const githubWorkflowRunConclusionSchema = z.enum([
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
export type GithubWorkflowRunConclusion = z.infer<
  typeof githubWorkflowRunConclusionSchema
>;

const githubFilterValuesSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(100);

export const githubWorkflowRunCompletedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("workflow_run_completed"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        workflows: githubFilterValuesSchema.optional(),
        conclusions: z
          .array(githubWorkflowRunConclusionSchema)
          .min(1)
          .max(githubWorkflowRunConclusionSchema.options.length)
          .optional(),
        branches: githubFilterValuesSchema.optional(),
        events: githubFilterValuesSchema.optional(),
        actors: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubWorkflowRunCompletedEventConfig = z.infer<
  typeof githubWorkflowRunCompletedEventConfigSchema
>;

export const githubWorkflowJobCompletedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("workflow_job_completed"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        workflows: githubFilterValuesSchema.optional(),
        jobs: githubFilterValuesSchema.optional(),
        conclusions: z
          .array(githubWorkflowRunConclusionSchema)
          .min(1)
          .max(githubWorkflowRunConclusionSchema.options.length)
          .optional(),
        branches: githubFilterValuesSchema.optional(),
        runnerLabels: githubFilterValuesSchema.optional(),
        runnerGroups: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubWorkflowJobCompletedEventConfig = z.infer<
  typeof githubWorkflowJobCompletedEventConfigSchema
>;

export const githubPullRequestReviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "commented",
]);
export type GithubPullRequestReviewState = z.infer<
  typeof githubPullRequestReviewStateSchema
>;

export const githubPullRequestReviewSubmittedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("pull_request_review_submitted"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        reviewStates: z
          .array(githubPullRequestReviewStateSchema)
          .min(1)
          .max(githubPullRequestReviewStateSchema.options.length)
          .optional(),
        baseBranches: githubFilterValuesSchema.optional(),
        headBranches: githubFilterValuesSchema.optional(),
        trustedAuthors: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubPullRequestReviewSubmittedEventConfig = z.infer<
  typeof githubPullRequestReviewSubmittedEventConfigSchema
>;

export const githubDeploymentStateSchema = z.enum([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
  "waiting",
]);
export type GithubDeploymentState = z.infer<typeof githubDeploymentStateSchema>;

export const githubDeploymentStatusCreatedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("deployment_status_created"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        environments: githubFilterValuesSchema.optional(),
        states: z
          .array(githubDeploymentStateSchema)
          .min(1)
          .max(githubDeploymentStateSchema.options.length)
          .optional(),
        refs: githubFilterValuesSchema.optional(),
        productionEnvironment: z.boolean().optional(),
        creators: githubFilterValuesSchema.optional(),
        apps: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubDeploymentStatusCreatedEventConfig = z.infer<
  typeof githubDeploymentStatusCreatedEventConfigSchema
>;

export const githubIssueCommentSubjectFilterSchema = z.enum([
  "both",
  "issues",
  "pull_requests",
]);
export type GithubIssueCommentSubjectFilter = z.infer<
  typeof githubIssueCommentSubjectFilterSchema
>;

export const githubIssueCommentCreatedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("issue_comment_created"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        subject: githubIssueCommentSubjectFilterSchema.default("both"),
        trustedAuthors: githubFilterValuesSchema.optional(),
        commentPrefixes: z
          .array(z.string().trim().min(1).max(1024))
          .min(1)
          .max(100)
          .optional(),
      })
      .strict()
      .default({ subject: "both" }),
  })
  .strict();
export type GithubIssueCommentCreatedEventConfig = z.infer<
  typeof githubIssueCommentCreatedEventConfigSchema
>;

export const githubPullRequestActionSchema = z.enum([
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
export type GithubPullRequestAction = z.infer<
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
export const githubPullRequestEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("pull_request"),
    repository: z.string().trim().min(1).max(255),
    action: githubPullRequestActionSchema,
    merged: z.boolean().optional(),
    filters: z
      .object({
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
export type GithubPullRequestEventConfig = z.infer<
  typeof githubPullRequestEventConfigSchema
>;

export const githubAutomationEventConfigSchema = z.discriminatedUnion("event", [
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  githubWorkflowRunCompletedEventConfigSchema,
]);
export type GithubAutomationEventConfig = z.infer<
  typeof githubAutomationEventConfigSchema
>;

export const googleCalendarEventCreatedEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_created"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventCreatedEventConfig = z.infer<
  typeof googleCalendarEventCreatedEventConfigSchema
>;

export const googleCalendarEventUpdatedEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_updated"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventUpdatedEventConfig = z.infer<
  typeof googleCalendarEventUpdatedEventConfigSchema
>;

export const googleCalendarEventCancelledEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_cancelled"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventCancelledEventConfig = z.infer<
  typeof googleCalendarEventCancelledEventConfigSchema
>;

export const googleCalendarAutomationEventConfigSchema = z.discriminatedUnion(
  "event",
  [
    googleCalendarEventCreatedEventConfigSchema,
    googleCalendarEventUpdatedEventConfigSchema,
    googleCalendarEventCancelledEventConfigSchema,
  ],
);
export type GoogleCalendarAutomationEventConfig = z.infer<
  typeof googleCalendarAutomationEventConfigSchema
>;

export const googleCalendarWatchActionRequiredReasonSchema = z.enum([
  "calendar_not_found",
  "reconnect_required",
]);
export type GoogleCalendarWatchActionRequiredReason = z.infer<
  typeof googleCalendarWatchActionRequiredReasonSchema
>;

export const googleMeetTranscriptGeneratedEventConfigSchema = z
  .object({
    provider: z.literal("google-meet"),
    event: z.literal("transcript_generated"),
    scope: z
      .object({
        type: z.literal("organizer_user"),
      })
      .strict()
      .default({ type: "organizer_user" }),
  })
  .strict();
export type GoogleMeetTranscriptGeneratedEventConfig = z.infer<
  typeof googleMeetTranscriptGeneratedEventConfigSchema
>;
export type GoogleMeetAutomationEventConfig =
  GoogleMeetTranscriptGeneratedEventConfig;

export const googleFormsFormReferenceSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(512),
    url: z.url(),
  })
  .strict();
export type GoogleFormsFormReference = z.infer<
  typeof googleFormsFormReferenceSchema
>;

export const googleFormsResponseSubmittedEventConfigSchema = z
  .object({
    provider: z.literal("google-forms"),
    event: z.literal("response_submitted"),
    connectorId: z.string().uuid(),
    form: googleFormsFormReferenceSchema,
  })
  .strict();
export type GoogleFormsResponseSubmittedEventConfig = z.infer<
  typeof googleFormsResponseSubmittedEventConfigSchema
>;

export const googleFormsResponseSubmittedEventCreateConfigSchema = z
  .object({
    provider: z.literal("google-forms"),
    event: z.literal("response_submitted"),
    formUrl: z.string().trim().min(1).max(2048),
  })
  .strict();
export type GoogleFormsResponseSubmittedEventCreateConfig = z.infer<
  typeof googleFormsResponseSubmittedEventCreateConfigSchema
>;

export type GoogleFormsAutomationEventConfig =
  GoogleFormsResponseSubmittedEventConfig;

export const notionPageReferenceSchema = z
  .object({
    id: z.string().uuid(),
    url: z.url(),
    title: z.string().nullable(),
    rawUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type NotionPageReference = z.infer<typeof notionPageReferenceSchema>;

export const notionDataSourceReferenceSchema = z
  .object({
    id: z.string().uuid(),
    url: z.url(),
    title: z.string().nullable(),
    rawUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type NotionDataSourceReference = z.infer<
  typeof notionDataSourceReferenceSchema
>;

export const notionChildPageCreatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("child_page_created"),
    connectorId: z.string().uuid(),
    parentPage: notionPageReferenceSchema,
  })
  .strict();
export type NotionChildPageCreatedEventConfig = z.infer<
  typeof notionChildPageCreatedEventConfigSchema
>;

export const notionChildPageCreatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("child_page_created"),
    parentPageUrl: z.string().trim().min(1).max(2048),
  })
  .strict();
export type NotionChildPageCreatedEventCreateConfig = z.infer<
  typeof notionChildPageCreatedEventCreateConfigSchema
>;

export const notionDatabaseItemCreatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("database_item_created"),
    connectorId: z.string().uuid(),
    dataSource: notionDataSourceReferenceSchema,
  })
  .strict();
export type NotionDatabaseItemCreatedEventConfig = z.infer<
  typeof notionDatabaseItemCreatedEventConfigSchema
>;

export const notionDatabaseItemCreatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("database_item_created"),
    databaseUrl: z.string().trim().min(1).max(2048),
  })
  .strict();
export type NotionDatabaseItemCreatedEventCreateConfig = z.infer<
  typeof notionDatabaseItemCreatedEventCreateConfigSchema
>;

export const notionPageContentUpdatedScopeSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("page"),
        page: notionPageReferenceSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("data_source"),
        dataSource: notionDataSourceReferenceSchema,
      })
      .strict(),
  ],
);
export type NotionPageContentUpdatedScope = z.infer<
  typeof notionPageContentUpdatedScopeSchema
>;

export const notionPageContentUpdatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("page_content_updated"),
    connectorId: z.string().uuid(),
    scope: notionPageContentUpdatedScopeSchema,
  })
  .strict();
export type NotionPageContentUpdatedEventConfig = z.infer<
  typeof notionPageContentUpdatedEventConfigSchema
>;

export const notionPageContentUpdatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("page_content_updated"),
    pageUrl: z.string().trim().min(1).max(2048).optional(),
    databaseUrl: z.string().trim().min(1).max(2048).optional(),
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
export type NotionPageContentUpdatedEventCreateConfig = z.infer<
  typeof notionPageContentUpdatedEventCreateConfigSchema
>;

export type NotionAutomationEventConfig =
  | NotionChildPageCreatedEventConfig
  | NotionDatabaseItemCreatedEventConfig
  | NotionPageContentUpdatedEventConfig;

export const stripeInvoiceBillingReasonSchema = z.enum([
  "automatic_pending_invoice_item_invoice",
  "manual",
  "quote_accept",
  "subscription",
  "subscription_create",
  "subscription_cycle",
  "subscription_threshold",
  "subscription_update",
  "upcoming",
]);
export type StripeInvoiceBillingReason = z.infer<
  typeof stripeInvoiceBillingReasonSchema
>;

export const stripeInvoicePaidEventCreateConfigSchema = z
  .object({
    provider: z.literal("stripe"),
    event: z.literal("invoice_paid"),
    billingReasons: z.array(stripeInvoiceBillingReasonSchema).optional(),
  })
  .strict();
export type StripeInvoicePaidEventCreateConfig = z.infer<
  typeof stripeInvoicePaidEventCreateConfigSchema
>;

export const stripeInvoicePaidEventConfigSchema = z
  .object({
    provider: z.literal("stripe"),
    event: z.literal("invoice_paid"),
    billingReasons: z.array(stripeInvoiceBillingReasonSchema).optional(),
    connectorId: z.string().uuid(),
    stripeAccountId: z.string().min(1).max(255),
    mode: z.literal("live"),
  })
  .strict();
export type StripeInvoicePaidEventConfig = z.infer<
  typeof stripeInvoicePaidEventConfigSchema
>;

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-based Automation schedule model:
 * - `cron`: recurring at wall-clock times.
 * - `loop`: re-scheduled `intervalSeconds` after each completion.
 * - `once`: fires once at `atTime`, then auto-disables.
 */
export const workflowScheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cronExpression: z.string().min(1).max(100),
    timezone: z.string().min(1),
  }),
  z.object({
    type: z.literal("loop"),
    intervalSeconds: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("once"),
    atTime: z.string().min(1),
    timezone: z.string().min(1),
  }),
]);
export type WorkflowSchedule = z.infer<typeof workflowScheduleSchema>;

/**
 * Automation summary. Under 1:N the agent is derived from the workflow, so
 * automations no longer carry an agentId. Detail responses only ever list the
 * caller's own automations.
 */
const workflowAutomationSummaryBaseSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  enabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  official: z
    .object({
      blueprintKey: officialWorkflowBlueprintKeySchema,
      appliedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      reconciliationStatus: z.enum([
        "current",
        "reconciling",
        "needs_reconfiguration",
        "failed",
      ]),
      intendedEnabled: z.boolean(),
      parameterBindings: z.array(officialWorkflowParameterBindingSchema),
    })
    .strict()
    .nullable(),
});

export const workflowScheduleAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: workflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const workflowChatRunFinishedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGmailNewMessageAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGmailLabelAppliedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubPullRequestAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request"),
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubWorkflowRunCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubWorkflowJobCompletedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubPullRequestReviewSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubDeploymentStatusCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGithubIssueCommentCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowGoogleCalendarEventCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleCalendarEventCancelledAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    warning: googleCalendarWatchActionRequiredReasonSchema.optional(),
  });

export const workflowGoogleFormsResponseSubmittedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    warning: z.string().optional(),
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowNotionChildPageCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowNotionDatabaseItemCreatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const workflowNotionPageContentUpdatedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const stripeWorkflowAutomationHealthSchema = z.object({
  lastMatchingEventReceivedAt: z.string().datetime().nullable(),
  lastDeliveryStatus: z
    .enum(["pending", "delivered", "skipped", "failed"])
    .nullable(),
  lastDeliveryStatusAt: z.string().datetime().nullable(),
  warning: z.literal("delivery_failed").nullable(),
});
export type StripeWorkflowAutomationHealth = z.infer<
  typeof stripeWorkflowAutomationHealthSchema
>;

export const workflowStripeInvoicePaidAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("stripe-invoice-paid"),
    eventConfig: stripeInvoicePaidEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    health: stripeWorkflowAutomationHealthSchema,
  });

export const workflowWebhookReceivedAutomationSummarySchema =
  workflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    webhookUrl: z.url().optional(),
    secretLastFour: z.string().length(4),
    disabledReason: z.literal("paid_plan_required").nullable().optional(),
    lastReceivedAt: z.string().datetime().nullable(),
    webhookSecret: z.string().min(1).optional(),
  });

export const eventAutomationSummarySchema = z.discriminatedUnion("eventType", [
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
  workflowStripeInvoicePaidAutomationSummarySchema,
  workflowWebhookReceivedAutomationSummarySchema,
]);

export const workflowAutomationSummarySchema = z.union([
  workflowScheduleAutomationSummarySchema,
  eventAutomationSummarySchema,
]);
export type WorkflowAutomationSummary = z.infer<
  typeof workflowAutomationSummarySchema
>;

const chatThreadWorkflowSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: workflowNameSchema,
  displayName: z.string().nullable(),
  description: z.string().nullable(),
});

const chatThreadWorkflowAutomationBaseSchema =
  workflowAutomationSummaryBaseSchema.extend({
    id: z.string().uuid(),
    chatThreadId: z.string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowScheduleAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: workflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const chatThreadWorkflowChatRunFinishedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGmailNewMessageAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGmailLabelAppliedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubPullRequestAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request"),
    eventConfig: githubPullRequestEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleFormsResponseSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionChildPageCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionPageContentUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowStripeInvoicePaidAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("stripe-invoice-paid"),
    eventConfig: stripeInvoicePaidEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    health: stripeWorkflowAutomationHealthSchema,
  });

export const chatThreadWorkflowWebhookReceivedAutomationSchema =
  workflowWebhookReceivedAutomationSummarySchema.extend({
    id: z.string().uuid(),
    chatThreadId: z.string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowAutomationSchema = z.union([
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
  chatThreadWorkflowStripeInvoicePaidAutomationSchema,
  chatThreadWorkflowWebhookReceivedAutomationSchema,
]);
export type ChatThreadWorkflowAutomation = z.infer<
  typeof chatThreadWorkflowAutomationSchema
>;

export const workflowScheduleAutomationCreateRequestSchema = z.object({
  kind: z.literal("schedule").optional(),
  schedule: workflowScheduleSchema,
  enabled: z.boolean().optional(),
});

export const workflowChatRunFinishedAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("chat-run-finished"),
  eventConfig: chatRunFinishedEventConfigSchema,
  enabled: z.boolean().optional(),
});

export const workflowGmailNewMessageAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("gmail-new-message"),
  eventConfig: gmailNewMessageEventConfigSchema,
  enabled: z.boolean().optional(),
});

export const workflowGmailLabelAppliedAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("gmail-label-applied"),
  eventConfig: gmailLabelAppliedEventConfigSchema,
  enabled: z.boolean().optional(),
});

export const workflowGithubPullRequestAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("github-pull-request"),
  eventConfig: githubPullRequestEventConfigSchema,
  enabled: z.boolean().optional(),
});

export const workflowGithubWorkflowRunCompletedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGithubWorkflowJobCompletedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGithubIssueCommentCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGoogleCalendarEventCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const workflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const workflowGoogleCalendarEventCancelledAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const workflowGoogleFormsResponseSubmittedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-forms-response-submitted"),
    eventConfig: googleFormsResponseSubmittedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema
      .optional()
      .default({
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      }),
    enabled: z.boolean().optional(),
  });

export const workflowNotionChildPageCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowNotionDatabaseItemCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowNotionPageContentUpdatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const workflowStripeInvoicePaidAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("stripe-invoice-paid"),
  eventConfig: stripeInvoicePaidEventCreateConfigSchema,
  enabled: z.boolean().optional(),
});

export const workflowWebhookReceivedAutomationCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("webhook-received"),
  eventConfig: webhookReceivedEventConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export const workflowAutomationCreateRequestSchema = z.union([
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
  workflowStripeInvoicePaidAutomationCreateRequestSchema,
  workflowWebhookReceivedAutomationCreateRequestSchema,
]);
export type WorkflowAutomationCreateRequest = z.infer<
  typeof workflowAutomationCreateRequestSchema
>;

export const workflowScheduleAutomationUpdateRequestSchema = z.object({
  schedule: workflowScheduleSchema,
});

export const workflowGmailEventAutomationUpdateRequestSchema = z.object({
  eventConfig: gmailAutomationEventConfigSchema,
});

export const workflowGithubEventAutomationUpdateRequestSchema = z.object({
  eventConfig: githubAutomationEventConfigSchema,
});

export const workflowGoogleCalendarEventAutomationUpdateRequestSchema =
  z.object({
    eventConfig: googleCalendarAutomationEventConfigSchema,
  });

export const workflowAutomationUpdateRequestSchema = z.union([
  workflowScheduleAutomationUpdateRequestSchema,
  workflowGmailEventAutomationUpdateRequestSchema,
  workflowGithubEventAutomationUpdateRequestSchema,
  workflowGoogleCalendarEventAutomationUpdateRequestSchema,
]);
export type WorkflowAutomationUpdateRequest = z.infer<
  typeof workflowAutomationUpdateRequestSchema
>;

/**
 * Workflow summary. A workflow belongs to exactly one agent (`agentId`).
 * `canManage` reflects the caller's effective rights (agent write-permission
 * for public workflows; ownership for private ones).
 */
export const workflowSummarySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  name: workflowNameSchema,
  displayName: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  visibility: workflowVisibilitySchema,
  ownerUserId: z.string(),
  createdAt: z.string().datetime(),
  canManage: z.boolean(),
  canPublish: z.boolean(),
  official: z
    .object({
      definitionName: workflowNameSchema,
      installationState: z.enum(["installing", "installed"]),
      definitionLifecycle: z.enum(["active", "retired", "unavailable"]),
      readOnly: z.literal(true),
    })
    .strict()
    .nullable(),
  shadowedBy: z
    .object({
      id: z.string().uuid(),
      name: workflowNameSchema,
      displayName: z.string().max(256).nullable(),
    })
    .nullable()
    .optional(),
});

export const workflowDetailResponseSchema = workflowSummarySchema.extend({
  createdByUserId: z.string(),
  updatedByUserId: z.string(),
  updatedAt: z.string().datetime(),
  instruction: z.string().nullable(),
  files: z.array(workflowFileMetadataSchema).nullable(),
  fileContents: z.array(workflowFileEntrySchema).nullable(),
  automations: z.array(workflowAutomationSummarySchema),
});

export const workflowListResponseSchema = z.array(workflowSummarySchema);

export const workflowAutomationsListEntrySchema = z.object({
  workflow: workflowSummarySchema,
  automation: workflowAutomationSummarySchema,
});
export const workflowAutomationsListResponseSchema = z.array(
  workflowAutomationsListEntrySchema,
);

export const workflowCreateRequestSchema = z.object({
  agentId: z.string().uuid(),
  chatThreadId: z.string().uuid().optional(),
  name: workflowNameSchema,
  instruction: workflowInstructionSchema.optional(),
  files: workflowFilesSchema.optional(),
  displayName: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  visibility: workflowVisibilitySchema.optional(),
});

export const workflowUpdateRequestSchema = z
  .object({
    name: workflowNameSchema.optional(),
    instruction: workflowInstructionSchema.nullable().optional(),
    files: workflowFilesSchema.optional(),
    displayName: z.string().max(256).nullable().optional(),
    description: z.string().max(1024).nullable().optional(),
  })
  .refine(
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

export const workflowCopyRequestSchema = z.object({
  toAgentId: z.string().uuid(),
});

export const workflowRunResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  // Null means the manual invocation is waiting in the chat thread queue and
  // no run has been created for it yet.
  runId: z.string().nullable(),
});

export const workflowChatThreadResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  prompt: z.string(),
});

const workflowIdParams = z.object({ workflowId: z.string().uuid() });

export const workflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/workflows",
    headers: authHeadersSchema,
    query: z.object({ agentId: z.string().uuid().optional() }),
    responses: {
      200: workflowListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible workflows, optionally scoped to one agent",
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

export const workflowOwnerProfileSchema = z.object({
  displayName: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
export type WorkflowOwnerProfile = z.infer<typeof workflowOwnerProfileSchema>;

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

const automationIdParams = z.object({ id: z.string().uuid() });
const chatThreadIdParams = z.object({ threadId: z.string().min(1) });

export const workflowWebhookSecretResponseSchema = z.object({
  webhookUrl: z.url(),
  webhookSecret: z.string().min(1),
});
export type WorkflowWebhookSecretResponse = z.infer<
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
      200: z.array(chatThreadWorkflowAutomationSchema),
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
      200: z.array(workflowAutomationSummarySchema),
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

export type WorkflowFileEntry = z.infer<typeof workflowFileEntrySchema>;
export type WorkflowFileMetadata = z.infer<typeof workflowFileMetadataSchema>;
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export type WorkflowDetailResponse = z.infer<
  typeof workflowDetailResponseSchema
>;
export type WorkflowCreateRequest = z.infer<typeof workflowCreateRequestSchema>;
export type WorkflowUpdateRequest = z.infer<typeof workflowUpdateRequestSchema>;
export type WorkflowCopyRequest = z.infer<typeof workflowCopyRequestSchema>;
export type WorkflowChatThreadResponse = z.infer<
  typeof workflowChatThreadResponseSchema
>;
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;
export type WorkflowAutomationsListEntry = z.infer<
  typeof workflowAutomationsListEntrySchema
>;
export type WorkflowsCollectionContract = typeof workflowsCollectionContract;
export type WorkflowsDetailContract = typeof workflowsDetailContract;
export type WorkflowVisibilityContract = typeof workflowVisibilityContract;
export type WorkflowAutomationsContract = typeof workflowAutomationsContract;
