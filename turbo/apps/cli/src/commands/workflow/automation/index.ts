import { Command, Option } from "commander";
import chalk from "chalk";
import type {
  ChatRunFinishedRunStatus,
  GithubDeploymentState,
  GithubIssueCommentSubjectFilter,
  GithubPullRequestAction,
  GithubPullRequestReviewState,
  GithubWorkflowRunConclusion,
  StripeInvoiceBillingReason,
  WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { getModelDisplayName } from "@okouai/core/model-display-name";
import {
  type WorkflowAutomationCreateRequest,
  type WorkflowAutomationSummary,
  type WorkflowAutomationUpdateRequest,
  createWorkflowAutomation,
  deleteWorkflowAutomation,
  disableWorkflowAutomation,
  enableWorkflowAutomation,
  getWorkflowAutomation,
  listWorkspaceWorkflowAutomations,
  listWorkflowAutomations,
  updateWorkflowAutomation,
} from "../../../lib/api/domains/workflows";
import { getChatThread } from "../../../lib/api/domains/chat";
import { listModelPolicies } from "../../../lib/api/domains/model-policies";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";
import { parseDurationSeconds } from "../../shared/duration";
import {
  resolveWorkflowRef,
  type WorkflowRefOptions,
} from "../resolve-workflow-ref";
import {
  printWorkflowAutomationDetails,
  printWorkflowAutomationThreadModel,
  printWorkflowAutomationsTable,
  type WorkflowAutomationThreadModel,
} from "./display";
import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  hasGmailLabelOption,
  hasGmailAutomationOptions,
  type GmailAutomationOptions,
} from "./gmail-config";

interface AddOptions extends GmailAutomationOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly agent?: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly merged?: string;
  readonly author?: string;
  readonly prNumber?: string;
  readonly repository?: string;
  readonly workflow?: string;
  readonly job?: string;
  readonly conclusion?: string;
  readonly branch?: string;
  readonly triggeringEvent?: string;
  readonly runnerLabel?: string;
  readonly runnerGroup?: string;
  readonly reviewState?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly trustedAuthor?: string;
  readonly environment?: string;
  readonly deploymentState?: string;
  readonly ref?: string;
  readonly productionEnvironment?: string;
  readonly creator?: string;
  readonly app?: string;
  readonly commentPrefix?: string;
  readonly calendarId?: string;
  readonly formUrl?: string;
  readonly pageUrl?: string;
  readonly parentPageUrl?: string;
  readonly databaseUrl?: string;
  readonly chatThreadId?: string;
  readonly runStatus?: string;
  readonly outputPattern?: string;
  readonly billingReason?: string;
}

interface UpdateOptions extends GmailAutomationOptions {
  readonly expr?: string;
  readonly at?: string;
  readonly every?: string;
  readonly timezone?: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly merged?: string;
  readonly author?: string;
  readonly prNumber?: string;
  readonly repository?: string;
  readonly workflow?: string;
  readonly job?: string;
  readonly conclusion?: string;
  readonly branch?: string;
  readonly triggeringEvent?: string;
  readonly runnerLabel?: string;
  readonly runnerGroup?: string;
  readonly reviewState?: string;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly trustedAuthor?: string;
  readonly environment?: string;
  readonly deploymentState?: string;
  readonly ref?: string;
  readonly productionEnvironment?: string;
  readonly creator?: string;
  readonly app?: string;
  readonly commentPrefix?: string;
}

const SCHEDULE_KINDS = ["cron", "once", "loop"] as const;
const EVENT_KINDS = [
  "gmail-new-message",
  "gmail-label-applied",
  "github-workflow-run-completed",
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
  "google-forms-response-submitted",
  "google-meet-transcript-generated",
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
  "webhook",
  "chat-run-finished",
] as const;
const GITHUB_WEBHOOK_EVENT_KINDS = [
  "github-pull-request",
  "github-workflow-job-completed",
  "github-pull-request-review-submitted",
  "github-deployment-status-created",
  "github-issue-comment-created",
] as const;
const STRIPE_EVENT_KINDS = ["stripe-invoice-paid"] as const;
const CHAT_RUN_FINISHED_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;
const STRIPE_INVOICE_BILLING_REASONS: readonly StripeInvoiceBillingReason[] = [
  "automatic_pending_invoice_item_invoice",
  "manual",
  "quote_accept",
  "subscription",
  "subscription_create",
  "subscription_cycle",
  "subscription_threshold",
  "subscription_update",
  "upcoming",
];

function stripeInvoicePaidWorkflowAutomationsEnabled(
  overrides?: FeatureSwitchContext["overrides"],
): boolean {
  const payload = decodeSandboxTokenPayload();
  return isFeatureEnabled(
    FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
    {
      userId: payload?.userId,
      orgId: payload?.orgId,
      overrides,
    },
  );
}

function automationKinds(
  stripeInvoicePaidEnabled = stripeInvoicePaidWorkflowAutomationsEnabled(),
): readonly string[] {
  return [
    ...SCHEDULE_KINDS,
    ...EVENT_KINDS,
    ...GITHUB_WEBHOOK_EVENT_KINDS,
    ...(stripeInvoicePaidEnabled ? STRIPE_EVENT_KINDS : []),
  ];
}

async function loadWorkflowAutomationThreadModel(
  automation: WorkflowAutomationSummary,
): Promise<WorkflowAutomationThreadModel | undefined> {
  if (!automation.chatThreadId) {
    return undefined;
  }

  const thread = await getChatThread({
    threadId: automation.chatThreadId,
  });
  const modelId =
    thread.selectedModel ?? (await listModelPolicies()).workspaceDefaultModel;
  if (!modelId) {
    throw new Error(
      `Chat thread "${automation.chatThreadId}" has no available model`,
    );
  }

  return {
    id: modelId,
    label: getModelDisplayName(modelId),
    serviceTier: thread.serviceTier,
  };
}

async function tryLoadWorkflowAutomationThreadModel(
  automation: WorkflowAutomationSummary,
): Promise<WorkflowAutomationThreadModel | undefined> {
  try {
    return await loadWorkflowAutomationThreadModel(automation);
  } catch (error) {
    console.warn(
      chalk.yellow(
        `⚠ Automation changed, but thread model details could not be loaded: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      ),
    );
    return undefined;
  }
}

const EXACTLY_ONE_FLAG_MESSAGE =
  "Provide exactly one of --expr (cron), --at (once), --every (loop), Gmail match options, --label, --subject, --actor, --calendar-id, --form-url, --page-url, --parent-page-url, or --database-url";

function addGmailAutomationOptions(command: Command): Command {
  return command
    .option(
      "--config <path>",
      "Path to a Gmail new message automation config JSON",
    )
    .option("--label <name>", "Label name for label-applied automations")
    .option("--from-contains <text>", "Require the From header to contain text")
    .option(
      "--from-not-contains <text>",
      "Require the From header not to contain text",
    )
    .option(
      "--subject-contains <text>",
      "Require the Subject header to contain text",
    )
    .option(
      "--subject-not-contains <text>",
      "Require the Subject header not to contain text",
    )
    .option(
      "--body-contains <text>",
      "Require the message body to contain text",
    )
    .option(
      "--body-not-contains <text>",
      "Require the message body not to contain text",
    )
    .option("--to-contains <text>", "Require the To header to contain text")
    .option(
      "--to-not-contains <text>",
      "Require the To header not to contain text",
    )
    .option("--cc-contains <text>", "Require the Cc header to contain text")
    .option(
      "--cc-not-contains <text>",
      "Require the Cc header not to contain text",
    );
}

function addGithubAutomationOptions(command: Command): Command {
  return command
    .option(
      "--subject <subject>",
      "GitHub subject filter for issue comment automations: both | issues | pull-requests",
    )
    .option(
      "--actor <actors>",
      "GitHub workflow run actors, comma-separated logins",
    )
    .option(
      "--action <action>",
      "GitHub pull request action for github-pull-request automations",
    )
    .option(
      "--merged <merged>",
      "GitHub pull request merged filter for the closed action: yes | no | any",
    )
    .option(
      "--author <authors>",
      "GitHub pull request authors, comma-separated logins",
    )
    .option(
      "--pr-number <numbers>",
      "GitHub pull request numbers, comma-separated",
    )
    .option(
      "--repository <repositories>",
      "GitHub repositories, comma-separated owner/name values",
    )
    .option(
      "--workflow <workflows>",
      "GitHub workflows, comma-separated IDs, names, or paths",
    )
    .option(
      "--conclusion <conclusions>",
      "Workflow run or job conclusions, comma-separated values",
    )
    .option(
      "--branch <branches>",
      "Workflow run or job branches, comma-separated",
    )
    .option(
      "--triggering-event <events>",
      "Workflow run triggering events, comma-separated",
    )
    .option("--job <jobs>", "GitHub Actions job names or IDs, comma-separated")
    .option("--runner-label <labels>", "Runner labels, comma-separated")
    .option(
      "--runner-group <groups>",
      "Runner group names or IDs, comma-separated",
    )
    .option(
      "--review-state <states>",
      "Review states: approved, changes_requested, commented, or any",
    )
    .option(
      "--base-branch <branches>",
      "Pull request base branches, comma-separated",
    )
    .option(
      "--head-branch <branches>",
      "Pull request head branches, comma-separated",
    )
    .option(
      "--trusted-author <logins>",
      "Trusted GitHub author logins, comma-separated; omit to allow anyone",
    )
    .option("--environment <names>", "Deployment environments, comma-separated")
    .option("--deployment-state <states>", "Deployment states, comma-separated")
    .option("--ref <refs>", "Deployment refs, comma-separated")
    .option(
      "--production-environment <value>",
      "Deployment environment filter: true | false | any",
    )
    .option(
      "--creator <logins>",
      "Deployment creator logins or IDs, comma-separated",
    )
    .option(
      "--app <apps>",
      "Deployment GitHub App slugs, names, or IDs, comma-separated",
    )
    .option(
      "--comment-prefix <prefixes>",
      "Required trimmed comment prefixes, comma-separated",
    );
}

function timezoneOrUtc(timezone: string | undefined): string {
  return timezone ?? "UTC";
}

function assertValidTimezone(timezone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function parseLocalDateTime(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
} {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid at time: "${value}". Use ISO datetime, e.g. 2026-06-10T09:00 or 2026-06-10T09:00:00Z`,
    );
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    millisecond: match[7] ? Number(match[7].padEnd(3, "0")) : 0,
  };
}

function zonedParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function wallTimeToUtcIso(value: string, timezone: string): string {
  assertValidTimezone(timezone);
  if (hasExplicitOffset(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
      throw new Error(`Invalid at time: "${value}"`);
    }
    return instant.toISOString();
  }

  const target = parseLocalDateTime(value);
  const targetUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
    target.millisecond,
  );
  let guess = targetUtc;
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(guess), timezone);
    const renderedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      target.millisecond,
    );
    guess += targetUtc - renderedUtc;
  }

  const result = new Date(guess);
  const rendered = zonedParts(result, timezone);
  if (
    rendered.year !== target.year ||
    rendered.month !== target.month ||
    rendered.day !== target.day ||
    rendered.hour !== target.hour ||
    rendered.minute !== target.minute ||
    rendered.second !== target.second
  ) {
    throw new Error(
      `Invalid at time for ${timezone}: "${value}". The local time does not exist`,
    );
  }
  return result.toISOString();
}

function buildSchedule(kind: string, options: UpdateOptions): WorkflowSchedule {
  switch (kind) {
    case "cron":
      if (!options.expr) {
        throw new Error(
          'cron automations require --expr (e.g. --expr "0 9 * * *")',
        );
      }
      return {
        type: "cron",
        cronExpression: options.expr,
        timezone: timezoneOrUtc(options.timezone),
      };
    case "once": {
      if (!options.at) {
        throw new Error(
          'once automations require --at (e.g. --at "2026-06-10T09:00")',
        );
      }
      const timezone = timezoneOrUtc(options.timezone);
      return {
        type: "once",
        atTime: wallTimeToUtcIso(options.at, timezone),
        timezone,
      };
    }
    case "loop":
      if (!options.every) {
        throw new Error("loop automations require --every (e.g. --every 15m)");
      }
      return {
        type: "loop",
        intervalSeconds: parseDurationSeconds(options.every),
      };
    default:
      throw new Error(
        `Unknown automation kind: "${kind}". Use one of: ${automationKinds().join(", ")}`,
      );
  }
}

function hasScheduleAddOptions(options: AddOptions): boolean {
  return (
    options.expr !== undefined ||
    options.at !== undefined ||
    options.every !== undefined ||
    options.timezone !== undefined
  );
}

type GithubAutomationOptionKey =
  | "subject"
  | "actor"
  | "action"
  | "merged"
  | "author"
  | "prNumber"
  | "repository"
  | "workflow"
  | "job"
  | "conclusion"
  | "branch"
  | "triggeringEvent"
  | "runnerLabel"
  | "runnerGroup"
  | "reviewState"
  | "baseBranch"
  | "headBranch"
  | "trustedAuthor"
  | "environment"
  | "deploymentState"
  | "ref"
  | "productionEnvironment"
  | "creator"
  | "app"
  | "commentPrefix";

const GITHUB_AUTOMATION_OPTION_KEYS: readonly GithubAutomationOptionKey[] = [
  "subject",
  "actor",
  "action",
  "merged",
  "author",
  "prNumber",
  "repository",
  "workflow",
  "job",
  "conclusion",
  "branch",
  "triggeringEvent",
  "runnerLabel",
  "runnerGroup",
  "reviewState",
  "baseBranch",
  "headBranch",
  "trustedAuthor",
  "environment",
  "deploymentState",
  "ref",
  "productionEnvironment",
  "creator",
  "app",
  "commentPrefix",
];

function githubOptionValue(
  options: AddOptions | UpdateOptions,
  key: GithubAutomationOptionKey,
): string | undefined {
  return options[key];
}

function hasGithubWebhookOptions(options: AddOptions | UpdateOptions): boolean {
  return GITHUB_AUTOMATION_OPTION_KEYS.some((key) => {
    return githubOptionValue(options, key) !== undefined;
  });
}

function hasGithubAutomationOptions(
  options: AddOptions | UpdateOptions,
): boolean {
  return hasGithubWebhookOptions(options);
}

function assertOnlyGithubAutomationOptions(
  options: AddOptions | UpdateOptions,
  allowed: readonly GithubAutomationOptionKey[],
): void {
  const invalid = GITHUB_AUTOMATION_OPTION_KEYS.find((key) => {
    return (
      githubOptionValue(options, key) !== undefined && !allowed.includes(key)
    );
  });
  if (invalid) {
    throw new Error(
      `--${invalid.replace(/[A-Z]/g, (match) => {
        return `-${match.toLowerCase()}`;
      })} does not apply to this GitHub automation`,
    );
  }
}

function hasAnyGithubAutomationOption(
  options: AddOptions | UpdateOptions,
  allowed: readonly GithubAutomationOptionKey[],
): boolean {
  return allowed.some((key) => {
    return githubOptionValue(options, key) !== undefined;
  });
}

function hasCalendarAutomationOptions(options: AddOptions): boolean {
  return options.calendarId !== undefined;
}

function hasGoogleFormsAutomationOptions(options: AddOptions): boolean {
  return options.formUrl !== undefined;
}

function hasNotionAutomationOptions(options: AddOptions): boolean {
  return (
    options.pageUrl !== undefined ||
    options.parentPageUrl !== undefined ||
    options.databaseUrl !== undefined
  );
}

function hasChatRunFinishedAutomationOptions(options: AddOptions): boolean {
  return (
    options.chatThreadId !== undefined ||
    options.runStatus !== undefined ||
    options.outputPattern !== undefined
  );
}

function hasEventAddOptions(options: AddOptions): boolean {
  return (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options) ||
    hasNotionAutomationOptions(options) ||
    hasChatRunFinishedAutomationOptions(options)
  );
}

function assertNoScheduleAddOptions(options: AddOptions): void {
  if (hasScheduleAddOptions(options)) {
    throw new Error(
      "--expr, --at, --every, and --timezone only apply to schedule automations",
    );
  }
}

function assertNoGithubAutomationOptions(
  options: AddOptions,
  message = "GitHub automation flags only apply to GitHub event automations",
): void {
  if (hasGithubAutomationOptions(options)) {
    throw new Error(message);
  }
}

function assertNoCalendarAutomationOptions(options: AddOptions): void {
  if (hasCalendarAutomationOptions(options)) {
    throw new Error(
      "Google Calendar automation flags only apply to Google Calendar event automations",
    );
  }
}

function assertNoGoogleFormsAutomationOptions(options: AddOptions): void {
  if (hasGoogleFormsAutomationOptions(options)) {
    throw new Error(
      "--form-url only applies to google-forms-response-submitted automations",
    );
  }
}

function assertNoNotionAutomationOptions(options: AddOptions): void {
  if (hasNotionAutomationOptions(options)) {
    throw new Error(
      "Notion automation flags only apply to Notion event automations",
    );
  }
}

function scheduleUpdateFlagCount(options: UpdateOptions): number {
  return [options.expr, options.at, options.every].filter((value) => {
    return value !== undefined;
  }).length;
}

function hasScheduleUpdateOptions(options: UpdateOptions): boolean {
  return scheduleUpdateFlagCount(options) > 0 || options.timezone !== undefined;
}

function parseGithubSubject(
  value: string | undefined,
  fallback: GithubIssueCommentSubjectFilter = "both",
): GithubIssueCommentSubjectFilter {
  if (value === undefined) {
    return fallback;
  }
  switch (value) {
    case "both":
    case "issues":
      return value;
    case "pull-requests":
      return "pull_requests";
    default:
      throw new Error(
        `Invalid --subject "${value}". Use one of: both, issues, pull-requests`,
      );
  }
}

const GITHUB_WORKFLOW_RUN_CONCLUSIONS: readonly GithubWorkflowRunConclusion[] =
  [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
    "success",
    "timed_out",
  ];

function parseGithubWorkflowRunFilter(
  value: string | undefined,
  fallback: readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) {
    return fallback ? [...fallback] : undefined;
  }
  if (value.trim().toLowerCase() === "any") {
    return undefined;
  }
  const values = Array.from(
    new Set(
      value
        .split(",")
        .map((part) => {
          return part.trim();
        })
        .filter(Boolean),
    ),
  );
  if (values.length === 0) {
    throw new Error("GitHub filters cannot be empty; use any");
  }
  return values;
}

function parseGithubWorkflowRunConclusions(
  value: string | undefined,
  fallback: readonly GithubWorkflowRunConclusion[] | undefined,
): GithubWorkflowRunConclusion[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((conclusion) => {
    if (
      GITHUB_WORKFLOW_RUN_CONCLUSIONS.includes(
        conclusion as GithubWorkflowRunConclusion,
      )
    ) {
      return conclusion as GithubWorkflowRunConclusion;
    }
    throw new Error(
      `Invalid --conclusion "${conclusion}". Use one of: ${GITHUB_WORKFLOW_RUN_CONCLUSIONS.join(", ")}, any`,
    );
  });
}

const GITHUB_PULL_REQUEST_ACTIONS: readonly GithubPullRequestAction[] = [
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
];

function parseGithubPullRequestAction(
  value: string | undefined,
  fallback: GithubPullRequestAction | undefined,
): GithubPullRequestAction {
  if (value === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(
      `github-pull-request automations require --action <action>. Use one of: ${GITHUB_PULL_REQUEST_ACTIONS.join(", ")}`,
    );
  }
  const action = GITHUB_PULL_REQUEST_ACTIONS.find((candidate) => {
    return candidate === value.trim();
  });
  if (!action) {
    throw new Error(
      `Invalid --action "${value}". Use one of: ${GITHUB_PULL_REQUEST_ACTIONS.join(", ")}`,
    );
  }
  return action;
}

function parseGithubPullRequestMerged(
  value: string | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }
  switch (value.trim().toLowerCase()) {
    case "any":
      return undefined;
    case "yes":
    case "true":
      return true;
    case "no":
    case "false":
      return false;
    default:
      throw new Error(`Invalid --merged "${value}". Use yes, no, or any`);
  }
}

function buildGithubPullRequestEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    { readonly kind: "event"; readonly eventType: "github-pull-request" }
  >,
) {
  const repository =
    options.repository?.trim() ?? existing?.eventConfig.repository;
  if (!repository) {
    throw new Error(
      'github-pull-request automations require --repository "owner/name"',
    );
  }
  if (repository.includes(",")) {
    throw new Error(
      "github-pull-request automations accept exactly one --repository",
    );
  }
  const action = parseGithubPullRequestAction(
    options.action,
    existing?.eventConfig.action,
  );
  const merged = parseGithubPullRequestMerged(
    options.merged,
    existing?.eventConfig.merged,
  );
  if (merged !== undefined && action !== "closed") {
    throw new Error("--merged only applies to the closed action");
  }
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "pull_request" as const,
    repository,
    action,
    ...(merged === undefined ? {} : { merged }),
    filters: {
      baseBranches: parseGithubWorkflowRunFilter(
        options.baseBranch,
        filters?.baseBranches,
      ),
      authors: parseGithubWorkflowRunFilter(options.author, filters?.authors),
      pullRequestNumbers: parseGithubWorkflowRunFilter(
        options.prNumber,
        filters?.pullRequestNumbers,
      ),
      labels: parseGithubWorkflowRunFilter(options.label, filters?.labels),
    },
  };
}

const GITHUB_PULL_REQUEST_REVIEW_STATES: readonly GithubPullRequestReviewState[] =
  ["approved", "changes_requested", "commented"];

const GITHUB_DEPLOYMENT_STATES: readonly GithubDeploymentState[] = [
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
  "waiting",
];

function parseGithubReviewStates(
  value: string | undefined,
  fallback: readonly GithubPullRequestReviewState[] | undefined,
): GithubPullRequestReviewState[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((state) => {
    if (
      GITHUB_PULL_REQUEST_REVIEW_STATES.includes(
        state as GithubPullRequestReviewState,
      )
    ) {
      return state as GithubPullRequestReviewState;
    }
    throw new Error(
      `Invalid --review-state "${state}". Use one of: ${GITHUB_PULL_REQUEST_REVIEW_STATES.join(", ")}, any`,
    );
  });
}

function parseGithubDeploymentStates(
  value: string | undefined,
  fallback: readonly GithubDeploymentState[] | undefined,
): GithubDeploymentState[] | undefined {
  const values = parseGithubWorkflowRunFilter(value, fallback);
  if (!values) {
    return undefined;
  }
  return values.map((state) => {
    if (GITHUB_DEPLOYMENT_STATES.includes(state as GithubDeploymentState)) {
      return state as GithubDeploymentState;
    }
    throw new Error(
      `Invalid --deployment-state "${state}". Use one of: ${GITHUB_DEPLOYMENT_STATES.join(", ")}, any`,
    );
  });
}

function parseProductionEnvironment(
  value: string | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }
  switch (value.trim().toLowerCase()) {
    case "any":
      return undefined;
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new Error(
        `Invalid --production-environment "${value}". Use true, false, or any`,
      );
  }
}

function buildGithubWorkflowRunCompletedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-workflow-run-completed";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "workflow_run_completed" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      workflows: parseGithubWorkflowRunFilter(
        options.workflow,
        filters?.workflows,
      ),
      conclusions: parseGithubWorkflowRunConclusions(
        options.conclusion,
        filters?.conclusions,
      ),
      branches: parseGithubWorkflowRunFilter(options.branch, filters?.branches),
      events: parseGithubWorkflowRunFilter(
        options.triggeringEvent,
        filters?.events,
      ),
      actors: parseGithubWorkflowRunFilter(options.actor, filters?.actors),
    },
  };
}

function buildGithubWorkflowJobCompletedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-workflow-job-completed";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "workflow_job_completed" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      workflows: parseGithubWorkflowRunFilter(
        options.workflow,
        filters?.workflows,
      ),
      jobs: parseGithubWorkflowRunFilter(options.job, filters?.jobs),
      conclusions: parseGithubWorkflowRunConclusions(
        options.conclusion,
        filters?.conclusions,
      ),
      branches: parseGithubWorkflowRunFilter(options.branch, filters?.branches),
      runnerLabels: parseGithubWorkflowRunFilter(
        options.runnerLabel,
        filters?.runnerLabels,
      ),
      runnerGroups: parseGithubWorkflowRunFilter(
        options.runnerGroup,
        filters?.runnerGroups,
      ),
    },
  };
}

function buildGithubPullRequestReviewSubmittedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-pull-request-review-submitted";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "pull_request_review_submitted" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      reviewStates: parseGithubReviewStates(
        options.reviewState,
        filters?.reviewStates,
      ),
      baseBranches: parseGithubWorkflowRunFilter(
        options.baseBranch,
        filters?.baseBranches,
      ),
      headBranches: parseGithubWorkflowRunFilter(
        options.headBranch,
        filters?.headBranches,
      ),
      trustedAuthors: parseGithubWorkflowRunFilter(
        options.trustedAuthor,
        filters?.trustedAuthors,
      ),
    },
  };
}

function buildGithubDeploymentStatusCreatedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-deployment-status-created";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "deployment_status_created" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      environments: parseGithubWorkflowRunFilter(
        options.environment,
        filters?.environments,
      ),
      states: parseGithubDeploymentStates(
        options.deploymentState,
        filters?.states,
      ),
      refs: parseGithubWorkflowRunFilter(options.ref, filters?.refs),
      productionEnvironment: parseProductionEnvironment(
        options.productionEnvironment,
        filters?.productionEnvironment,
      ),
      creators: parseGithubWorkflowRunFilter(
        options.creator,
        filters?.creators,
      ),
      apps: parseGithubWorkflowRunFilter(options.app, filters?.apps),
    },
  };
}

function buildGithubIssueCommentCreatedEventConfig(
  options: AddOptions | UpdateOptions,
  existing?: Extract<
    WorkflowAutomationSummary,
    {
      readonly kind: "event";
      readonly eventType: "github-issue-comment-created";
    }
  >,
) {
  const filters = existing?.eventConfig.filters;
  return {
    provider: "github" as const,
    event: "issue_comment_created" as const,
    filters: {
      repositories: parseGithubWorkflowRunFilter(
        options.repository,
        filters?.repositories,
      ),
      subject: parseGithubSubject(options.subject, filters?.subject ?? "both"),
      trustedAuthors: parseGithubWorkflowRunFilter(
        options.trustedAuthor,
        filters?.trustedAuthors,
      ),
      commentPrefixes: parseGithubWorkflowRunFilter(
        options.commentPrefix,
        filters?.commentPrefixes,
      ),
    },
  };
}

function buildGmailNewMessageCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailLabelOption(options)) {
    throw new Error("--label only applies to label-applied event automations");
  }
  assertNoGithubAutomationOptions(options);
  assertNoCalendarAutomationOptions(options);
  assertNoGoogleFormsAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  return {
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: buildGmailNewMessageEventConfig(options),
  };
}

function buildGmailLabelAppliedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to gmail-new-message automations",
    );
  }
  assertNoGithubAutomationOptions(options);
  assertNoCalendarAutomationOptions(options);
  assertNoGoogleFormsAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  return {
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: buildGmailLabelAppliedEventConfig(options),
  };
}

function buildGithubPullRequestCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options)) {
    throw new Error(
      "Gmail match flags and --config only apply to Gmail event automations",
    );
  }
  assertNoCalendarAutomationOptions(options);
  assertNoGoogleFormsAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertOnlyGithubAutomationOptions(options, [
    "repository",
    "action",
    "merged",
    "baseBranch",
    "author",
    "prNumber",
  ]);
  return {
    kind: "event",
    eventType: "github-pull-request",
    eventConfig: buildGithubPullRequestEventConfig(options),
  };
}

function buildGithubWorkflowRunCompletedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options) || hasGmailLabelOption(options)) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  if (options.subject !== undefined) {
    throw new Error(
      "--subject only applies to github-issue-comment-created automations",
    );
  }
  assertOnlyGithubAutomationOptions(options, [
    "repository",
    "workflow",
    "conclusion",
    "branch",
    "triggeringEvent",
    "actor",
  ]);
  assertNoCalendarAutomationOptions(options);
  assertNoGoogleFormsAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  return {
    kind: "event",
    eventType: "github-workflow-run-completed",
    eventConfig: buildGithubWorkflowRunCompletedEventConfig(options),
  };
}

function assertGithubWebhookCreateOptions(
  options: AddOptions,
  allowed: readonly GithubAutomationOptionKey[],
): void {
  assertNoScheduleAddOptions(options);
  if (hasGmailAutomationOptions(options) || hasGmailLabelOption(options)) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  assertNoCalendarAutomationOptions(options);
  assertNoGoogleFormsAutomationOptions(options);
  assertNoNotionAutomationOptions(options);
  assertOnlyGithubAutomationOptions(options, allowed);
}

function buildGithubWorkflowJobCompletedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "workflow",
    "job",
    "conclusion",
    "branch",
    "runnerLabel",
    "runnerGroup",
  ]);
  return {
    kind: "event",
    eventType: "github-workflow-job-completed",
    eventConfig: buildGithubWorkflowJobCompletedEventConfig(options),
  };
}

function buildGithubPullRequestReviewSubmittedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "reviewState",
    "baseBranch",
    "headBranch",
    "trustedAuthor",
  ]);
  return {
    kind: "event",
    eventType: "github-pull-request-review-submitted",
    eventConfig: buildGithubPullRequestReviewSubmittedEventConfig(options),
  };
}

function buildGithubDeploymentStatusCreatedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "environment",
    "deploymentState",
    "ref",
    "productionEnvironment",
    "creator",
    "app",
  ]);
  return {
    kind: "event",
    eventType: "github-deployment-status-created",
    eventConfig: buildGithubDeploymentStatusCreatedEventConfig(options),
  };
}

function buildGithubIssueCommentCreatedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertGithubWebhookCreateOptions(options, [
    "repository",
    "subject",
    "trustedAuthor",
    "commentPrefix",
  ]);
  return {
    kind: "event",
    eventType: "github-issue-comment-created",
    eventConfig: buildGithubIssueCommentCreatedEventConfig(options),
  };
}

function buildGoogleCalendarEventCreateRequest(
  eventType:
    | "google-calendar-event-created"
    | "google-calendar-event-updated"
    | "google-calendar-event-cancelled",
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options) ||
    hasNotionAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Forms, and Notion automation flags only apply to their event automations",
    );
  }
  const calendarId = options.calendarId?.trim() || "primary";
  if (eventType === "google-calendar-event-created") {
    return {
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId,
      },
    };
  }
  if (eventType === "google-calendar-event-updated") {
    return {
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: {
        provider: "google-calendar",
        event: "event_updated",
        calendarId,
      },
    };
  }
  return {
    kind: "event",
    eventType: "google-calendar-event-cancelled",
    eventConfig: {
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId,
    },
  };
}

function buildGoogleFormsResponseSubmittedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasNotionAutomationOptions(options) ||
    hasChatRunFinishedAutomationOptions(options)
  ) {
    throw new Error(
      "Only --form-url applies to google-forms-response-submitted automations",
    );
  }
  const formUrl = options.formUrl?.trim();
  if (!formUrl) {
    throw new Error(
      'google-forms-response-submitted automations require --form-url "https://docs.google.com/forms/d/.../edit"',
    );
  }
  return {
    kind: "event",
    eventType: "google-forms-response-submitted",
    eventConfig: {
      provider: "google-forms",
      event: "response_submitted",
      formUrl,
    },
  };
}

function buildGoogleMeetTranscriptGeneratedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasEventAddOptions(options)) {
    throw new Error(
      "Google Meet transcript automations do not accept event filter options",
    );
  }
  return {
    kind: "event",
    eventType: "google-meet-transcript-generated",
    eventConfig: {
      provider: "google-meet",
      event: "transcript_generated",
      scope: { type: "organizer_user" },
    },
  };
}

function buildNotionChildPageCreatedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Google Forms automation flags only apply to their event automations",
    );
  }

  const parentPageUrl = options.parentPageUrl?.trim();
  if (options.pageUrl !== undefined || options.databaseUrl !== undefined) {
    throw new Error(
      "--page-url and --database-url do not apply to notion-child-page-created automations",
    );
  }
  if (!parentPageUrl) {
    throw new Error(
      'notion-child-page-created automations require --parent-page-url "https://www.notion.so/..."',
    );
  }

  return {
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      parentPageUrl,
    },
  };
}

function buildNotionDatabaseItemCreatedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Google Forms automation flags only apply to their event automations",
    );
  }

  if (options.pageUrl !== undefined || options.parentPageUrl !== undefined) {
    throw new Error(
      "--page-url and --parent-page-url do not apply to notion-database-item-created automations",
    );
  }
  const databaseUrl = options.databaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error(
      'notion-database-item-created automations require --database-url "https://www.notion.so/..."',
    );
  }

  return {
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      databaseUrl,
    },
  };
}

function buildNotionPageContentUpdatedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options)
  ) {
    throw new Error(
      "Gmail, GitHub, Google Calendar, and Google Forms automation flags only apply to their event automations",
    );
  }

  if (options.parentPageUrl !== undefined) {
    throw new Error(
      "--parent-page-url only applies to notion-child-page-created automations",
    );
  }
  const pageUrl = options.pageUrl?.trim();
  const databaseUrl = options.databaseUrl?.trim();
  const invalidScopeMessage =
    'notion-page-content-updated automations require exactly one of --page-url "https://www.notion.so/..." or --database-url "https://www.notion.so/..."';
  if (pageUrl && databaseUrl) {
    throw new Error(invalidScopeMessage);
  }

  if (pageUrl) {
    return {
      kind: "event",
      eventType: "notion-page-content-updated",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        pageUrl,
      },
    };
  }
  if (!databaseUrl) {
    throw new Error(invalidScopeMessage);
  }
  return {
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      databaseUrl,
    },
  };
}

function parseChatRunFinishedStatuses(
  value: string,
): ChatRunFinishedRunStatus[] {
  const statuses = value
    .split(",")
    .map((status) => {
      return status.trim();
    })
    .filter((status) => {
      return status.length > 0;
    });
  if (statuses.length === 0) {
    throw new Error(
      `--run-status requires at least one of: ${CHAT_RUN_FINISHED_STATUSES.join(", ")}`,
    );
  }
  return statuses.map((status) => {
    const match = CHAT_RUN_FINISHED_STATUSES.find((candidate) => {
      return candidate === status;
    });
    if (!match) {
      throw new Error(
        `Invalid --run-status value "${status}"; expected one of: ${CHAT_RUN_FINISHED_STATUSES.join(", ")}`,
      );
    }
    return match;
  });
}

function buildChatRunFinishedCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options) ||
    hasCalendarAutomationOptions(options) ||
    hasGoogleFormsAutomationOptions(options) ||
    hasNotionAutomationOptions(options)
  ) {
    throw new Error(
      "Only --chat-thread-id, --run-status, and --output-pattern apply to chat-run-finished automations",
    );
  }
  const chatThreadId = options.chatThreadId?.trim();
  if (!chatThreadId) {
    throw new Error(
      "chat-run-finished automations require --chat-thread-id <uuid>",
    );
  }
  const runStatuses =
    options.runStatus === undefined
      ? undefined
      : parseChatRunFinishedStatuses(options.runStatus);
  const outputPattern = options.outputPattern?.trim();
  return {
    kind: "event",
    eventType: "chat-run-finished",
    eventConfig: {
      provider: "chat",
      event: "run_finished",
      chatThreadId,
      ...(runStatuses ? { runStatuses } : {}),
      ...(outputPattern ? { outputPattern } : {}),
    },
  };
}

function buildWebhookCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasEventAddOptions(options)) {
    throw new Error("Event automation flags only apply to event automations");
  }
  return {
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
  };
}

function parseStripeInvoiceBillingReasons(
  value: string,
): StripeInvoiceBillingReason[] {
  const values = value.split(",").map((billingReason) => {
    return billingReason.trim();
  });
  if (
    values.some((billingReason) => {
      return billingReason.length === 0;
    })
  ) {
    throw new Error("--billing-reason cannot contain empty values");
  }

  const billingReasons: StripeInvoiceBillingReason[] = [];
  for (const value of values) {
    const billingReason = STRIPE_INVOICE_BILLING_REASONS.find((candidate) => {
      return candidate === value;
    });
    if (!billingReason) {
      throw new Error(
        `Invalid --billing-reason value "${value}"; expected one of: ${STRIPE_INVOICE_BILLING_REASONS.join(", ")}`,
      );
    }
    if (!billingReasons.includes(billingReason)) {
      billingReasons.push(billingReason);
    }
  }
  return billingReasons;
}

function buildStripeInvoicePaidCreateRequest(
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  assertNoScheduleAddOptions(options);
  if (hasEventAddOptions(options)) {
    throw new Error(
      "Only --billing-reason applies to stripe-invoice-paid automations",
    );
  }
  const billingReasons =
    options.billingReason === undefined
      ? undefined
      : parseStripeInvoiceBillingReasons(options.billingReason);
  return {
    kind: "event",
    eventType: "stripe-invoice-paid",
    eventConfig: {
      provider: "stripe",
      event: "invoice_paid",
      ...(billingReasons ? { billingReasons } : {}),
    },
  };
}

function buildScheduleCreateRequest(
  kind: string,
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  if (hasEventAddOptions(options)) {
    throw new Error("Event automation flags only apply to event automations");
  }
  return { schedule: buildSchedule(kind, options) };
}

function buildNonStripeCreateRequest(
  kind: string,
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  switch (kind) {
    case "gmail-new-message":
      return buildGmailNewMessageCreateRequest(options);
    case "gmail-label-applied":
      return buildGmailLabelAppliedCreateRequest(options);
    case "github-pull-request":
      return buildGithubPullRequestCreateRequest(options);
    case "github-workflow-run-completed":
      return buildGithubWorkflowRunCompletedCreateRequest(options);
    case "github-workflow-job-completed":
      return buildGithubWorkflowJobCompletedCreateRequest(options);
    case "github-pull-request-review-submitted":
      return buildGithubPullRequestReviewSubmittedCreateRequest(options);
    case "github-deployment-status-created":
      return buildGithubDeploymentStatusCreatedCreateRequest(options);
    case "github-issue-comment-created":
      return buildGithubIssueCommentCreatedCreateRequest(options);
    case "google-calendar-event-created":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "google-calendar-event-updated":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "google-calendar-event-cancelled":
      return buildGoogleCalendarEventCreateRequest(kind, options);
    case "google-forms-response-submitted":
      return buildGoogleFormsResponseSubmittedCreateRequest(options);
    case "google-meet-transcript-generated":
      return buildGoogleMeetTranscriptGeneratedCreateRequest(options);
    case "notion-child-page-created":
      return buildNotionChildPageCreatedCreateRequest(options);
    case "notion-database-item-created":
      return buildNotionDatabaseItemCreatedCreateRequest(options);
    case "notion-page-content-updated":
      return buildNotionPageContentUpdatedCreateRequest(options);
    case "chat-run-finished":
      return buildChatRunFinishedCreateRequest(options);
    case "webhook":
      return buildWebhookCreateRequest(options);
    default:
      return buildScheduleCreateRequest(kind, options);
  }
}

function buildCreateRequest(
  kind: string,
  options: AddOptions,
): WorkflowAutomationCreateRequest {
  if (kind === "stripe-invoice-paid") {
    return buildStripeInvoicePaidCreateRequest(options);
  }
  if (options.billingReason !== undefined) {
    throw new Error(
      "--billing-reason only applies to stripe-invoice-paid automations",
    );
  }
  return buildNonStripeCreateRequest(kind, options);
}

function buildGithubAutomationEventUpdate(
  options: UpdateOptions,
  existing: Extract<WorkflowAutomationSummary, { readonly kind: "event" }>,
): WorkflowAutomationUpdateRequest | undefined {
  switch (existing.eventType) {
    case "github-pull-request": {
      if (hasGmailAutomationOptions(options)) {
        throw new Error(
          "Gmail match flags only apply to Gmail event automations",
        );
      }
      const allowed = [
        "repository",
        "action",
        "merged",
        "baseBranch",
        "author",
        "prNumber",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (
        !hasAnyGithubAutomationOption(options, allowed) &&
        !hasGmailLabelOption(options)
      ) {
        throw new Error(
          "Provide a github-pull-request filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubPullRequestEventConfig(options, existing),
      };
    }
    case "github-workflow-run-completed": {
      if (
        hasGmailAutomationOptions(options) ||
        hasGmailLabelOption(options) ||
        options.subject !== undefined
      ) {
        throw new Error(
          "Gmail, label, and subject flags do not apply to GitHub workflow run automations",
        );
      }
      if (!hasGithubAutomationOptions(options)) {
        throw new Error(
          "Provide a GitHub workflow run filter flag; use any to clear a filter",
        );
      }
      assertOnlyGithubAutomationOptions(options, [
        "repository",
        "workflow",
        "conclusion",
        "branch",
        "triggeringEvent",
        "actor",
      ]);
      return {
        eventConfig: buildGithubWorkflowRunCompletedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-workflow-job-completed": {
      const allowed = [
        "repository",
        "workflow",
        "job",
        "conclusion",
        "branch",
        "runnerLabel",
        "runnerGroup",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub workflow job filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubWorkflowJobCompletedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-pull-request-review-submitted": {
      const allowed = [
        "repository",
        "reviewState",
        "baseBranch",
        "headBranch",
        "trustedAuthor",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub pull request review filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubPullRequestReviewSubmittedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-deployment-status-created": {
      const allowed = [
        "repository",
        "environment",
        "deploymentState",
        "ref",
        "productionEnvironment",
        "creator",
        "app",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub deployment status filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubDeploymentStatusCreatedEventConfig(
          options,
          existing,
        ),
      };
    }
    case "github-issue-comment-created": {
      const allowed = [
        "repository",
        "subject",
        "trustedAuthor",
        "commentPrefix",
      ] as const;
      assertOnlyGithubAutomationOptions(options, allowed);
      if (!hasAnyGithubAutomationOption(options, allowed)) {
        throw new Error(
          "Provide a GitHub issue comment filter flag; use any to clear a filter",
        );
      }
      return {
        eventConfig: buildGithubIssueCommentCreatedEventConfig(
          options,
          existing,
        ),
      };
    }
    default:
      return undefined;
  }
}

function buildEventUpdate(
  options: UpdateOptions,
  existing: Extract<WorkflowAutomationSummary, { readonly kind: "event" }>,
): WorkflowAutomationUpdateRequest {
  const hasGmailOptions = hasGmailAutomationOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  const hasGithubOptions = hasGithubAutomationOptions(options);

  if (
    existing.eventType === "google-calendar-event-created" ||
    existing.eventType === "google-calendar-event-updated" ||
    existing.eventType === "google-calendar-event-cancelled"
  ) {
    throw new Error("Google Calendar event automations cannot be updated");
  }

  if (existing.eventType === "google-forms-response-submitted") {
    throw new Error(
      "this trigger has no updatable fields; delete it and create a new one",
    );
  }

  if (existing.eventType === "stripe-invoice-paid") {
    throw new Error(
      "Stripe billing reasons cannot be updated; delete and recreate the automation",
    );
  }

  const githubWorkflowUpdate = buildGithubAutomationEventUpdate(
    options,
    existing,
  );
  if (githubWorkflowUpdate) {
    return githubWorkflowUpdate;
  }

  if (hasGithubOptions) {
    throw new Error(
      "GitHub automation flags only apply to GitHub event automations",
    );
  }

  if (existing.eventType === "gmail-label-applied") {
    if (!hasLabelOption || hasGmailOptions) {
      throw new Error("Use --label for gmail-label-applied automations");
    }
    return { eventConfig: buildGmailLabelAppliedEventConfig(options) };
  }

  if (existing.eventType !== "gmail-new-message") {
    throw new Error("This event automation cannot be updated");
  }
  if (!hasGmailOptions || hasLabelOption) {
    throw new Error(
      "Use Gmail match options for gmail-new-message automations",
    );
  }
  return {
    eventConfig: buildGmailNewMessageEventConfig(options, existing.eventConfig),
  };
}

function buildScheduleUpdate(
  options: UpdateOptions,
): WorkflowAutomationUpdateRequest {
  const hasGmailOptions = hasGmailAutomationOptions(options);
  const hasLabelOption = hasGmailLabelOption(options);
  if (hasGmailOptions || hasLabelOption) {
    throw new Error(
      "Gmail automation flags only apply to Gmail event automations",
    );
  }
  const flagCount = scheduleUpdateFlagCount(options);
  if (flagCount !== 1) {
    throw new Error(EXACTLY_ONE_FLAG_MESSAGE);
  }
  if (options.timezone && !options.expr && !options.at) {
    throw new Error("--timezone only applies to --expr and --at");
  }
  if (options.expr) {
    return { schedule: buildSchedule("cron", options) };
  }
  if (options.at) {
    return { schedule: buildSchedule("once", options) };
  }
  return { schedule: buildSchedule("loop", options) };
}

function buildUpdate(
  options: UpdateOptions,
  existing: WorkflowAutomationSummary,
): WorkflowAutomationUpdateRequest {
  const hasEventOptions =
    hasGmailAutomationOptions(options) ||
    hasGmailLabelOption(options) ||
    hasGithubAutomationOptions(options);
  if (hasScheduleUpdateOptions(options) && hasEventOptions) {
    throw new Error("Use either schedule flags or event automation options");
  }
  if (hasGmailAutomationOptions(options) && hasGmailLabelOption(options)) {
    throw new Error("Use either Gmail match options or --label");
  }

  if (existing.kind === "event") {
    if (hasScheduleUpdateOptions(options)) {
      throw new Error("Schedule flags only apply to schedule automations");
    }
    return buildEventUpdate(options, existing);
  }

  if (hasGithubAutomationOptions(options)) {
    throw new Error(
      "GitHub automation flags only apply to GitHub event automations",
    );
  }
  return buildScheduleUpdate(options);
}

function stripeBillingReasonOption(stripeInvoicePaidEnabled: boolean): Option {
  const option = new Option(
    "--billing-reason <reasons>",
    "Comma-separated Stripe invoice billing reasons (default: any)",
  );
  if (!stripeInvoicePaidEnabled) {
    option.hideHelp();
  }
  return option;
}

export function createAutomationAddCommand(
  commandOptions: {
    readonly featureSwitchOverrides?: FeatureSwitchContext["overrides"];
  } = {},
): Command {
  const stripeInvoicePaidEnabledForHelp =
    stripeInvoicePaidWorkflowAutomationsEnabled(
      commandOptions.featureSwitchOverrides,
    );
  const stripeExample = stripeInvoicePaidEnabledForHelp
    ? "  okou workflow automation add invoice-follow-up --agent <agent-id> stripe-invoice-paid --billing-reason subscription_create,subscription_cycle\n"
    : "";

  return addGithubAutomationOptions(
    addGmailAutomationOptions(
      new Command()
        .name("add")
        .description("Add an automation to a workflow")
        .argument("<workflow>", "Workflow ID or name")
        .argument(
          "<kind>",
          `Automation type: ${automationKinds(stripeInvoicePaidEnabledForHelp).join(" | ")}`,
        )
        .option("--expr <expression>", 'Cron expression for kind "cron"')
        .option("--at <iso-time>", 'Fire time for kind "once"')
        .option(
          "--every <duration>",
          'Interval for kind "loop" (e.g. 15m, 1h, 90s)',
        )
        .option(
          "-z, --timezone <tz>",
          "IANA timezone for cron/once (default: UTC)",
        ),
    ),
  )
    .option(
      "--calendar-id <id>",
      "Google Calendar ID for Google Calendar event automations (default: primary)",
    )
    .option(
      "--form-url <url>",
      "Google Form edit-page URL or bare form ID for response automations",
    )
    .option(
      "--page-url <url>",
      "Notion page URL for notion-page-content-updated automations",
    )
    .option(
      "--parent-page-url <url>",
      "Parent Notion page URL for notion-child-page-created automations",
    )
    .option(
      "--database-url <url>",
      "Notion database URL for notion-database-item-created or notion-page-content-updated automations",
    )
    .option(
      "--chat-thread-id <uuid>",
      "Watched chat thread ID for chat-run-finished automations",
    )
    .option(
      "--run-status <statuses>",
      "Comma-separated finish statuses for chat-run-finished automations: completed, failed, cancelled (default: all)",
    )
    .option(
      "--output-pattern <pattern>",
      "Optional * wildcard matched against the finished run's final assistant text",
    )
    .addOption(stripeBillingReasonOption(stripeInvoicePaidEnabledForHelp))
    .option("--agent <id>", "Agent ID for resolving a workflow name")
    .addHelpText(
      "after",
      `
Examples:
  okou workflow automation add tell-a-joke --agent <agent-id> cron --expr "0 9 * * *" -z Asia/Shanghai
  okou workflow automation add tell-a-joke --agent <agent-id> once --at "2026-06-10T09:00" -z Asia/Shanghai
  okou workflow automation add tell-a-joke --agent <agent-id> loop --every 15m
  okou workflow automation add triage --agent <agent-id> gmail-new-message --from-contains "@example.com"
  okou workflow automation add triage --agent <agent-id> gmail-new-message --config ./gmail-automation.json
  okou workflow automation add triage --agent <agent-id> gmail-label-applied --label "Support"
  okou workflow automation add merge-follow-up --agent <agent-id> github-pull-request --repository vm0-ai/vm0 --action closed --merged yes --base-branch main
  okou workflow automation add pr-triage --agent <agent-id> github-pull-request --repository vm0-ai/vm0 --action labeled --label "triage"
  okou workflow automation add ci-triage --agent <agent-id> github-workflow-run-completed --repository vm0-ai/vm0 --workflow Turbo --conclusion failure,timed_out --branch main --triggering-event push --actor dependabot[bot]
  okou workflow automation add triage --agent <agent-id> google-calendar-event-created
  okou workflow automation add triage --agent <agent-id> google-calendar-event-updated
  okou workflow automation add triage --agent <agent-id> google-calendar-event-cancelled
  okou workflow trigger add triage --agent <agent-id> google-forms-response-submitted --form-url "https://docs.google.com/forms/d/<form-id>/edit"
  okou workflow automation add meeting-notes --agent <agent-id> google-meet-transcript-generated
  okou workflow automation add research-notes --agent <agent-id> notion-child-page-created --parent-page-url "https://www.notion.so/workspace/Page-title-1234567890abcdef1234567890abcdef"
  okou workflow automation add research-notes --agent <agent-id> notion-database-item-created --database-url "https://www.notion.so/1234567890abcdef1234567890abcdef?v=abcdef1234567890abcdef1234567890"
  okou workflow automation add research-notes --agent <agent-id> notion-page-content-updated --page-url "https://www.notion.so/workspace/Page-title-1234567890abcdef1234567890abcdef"
  okou workflow automation add research-notes --agent <agent-id> notion-page-content-updated --database-url "https://www.notion.so/1234567890abcdef1234567890abcdef?v=abcdef1234567890abcdef1234567890"
${stripeExample}  okou workflow automation add triage --agent <agent-id> webhook
  okou workflow automation add follow-up --agent <agent-id> chat-run-finished --chat-thread-id <thread-uuid> --run-status completed,failed --output-pattern "*deploy failed*"

Notes:
  - Workflow names resolve under --agent, then OKOU_AGENT_ID
  - Gmail automations match all inbound messages when no text match rules are provided
  - GitHub automations require the GitHub App installation in the workspace
  - GitHub workflow run filters accept comma-separated values; omit a filter to match any value
  - Google Meet automations run only when a meeting you organize generates a transcript
  - chat-run-finished watches the user-owned thread, not one run ID; status defaults to completed,failed,cancelled
  - chat-run-finished --output-pattern is a case-insensitive * wildcard match against final assistant text
  - Each match starts a new run in the workflow's automation thread; it does not resume the watched or creating run
  - An automation stays enabled for future matches until explicitly disabled or removed
  - Webhook automations print the signing secret only once after creation
  - Use the workflow ID when a name is ambiguous`,
    )
    .action(
      withErrorHandler(
        async (workflowRef: string, kind: string, options: AddOptions) => {
          if (
            kind === "stripe-invoice-paid" &&
            !stripeInvoicePaidWorkflowAutomationsEnabled(
              commandOptions.featureSwitchOverrides,
            )
          ) {
            throw new Error(
              "Stripe invoice-paid workflow automations are not enabled for this workspace",
            );
          }
          if (
            options.timezone &&
            kind !== "cron" &&
            kind !== "once" &&
            kind !== "gmail-new-message"
          ) {
            throw new Error(
              "--timezone only applies to cron and once automations",
            );
          }
          const workflowId = await resolveWorkflowRef(workflowRef, options);
          const body = buildCreateRequest(kind, options);
          const automation = await createWorkflowAutomation(workflowId, body);

          console.log(
            chalk.green(`✓ Automation added to workflow "${workflowRef}"`),
          );
          const threadModel =
            await tryLoadWorkflowAutomationThreadModel(automation);
          printWorkflowAutomationDetails(automation, {
            workflowRef,
            workflowId,
            threadModel,
          });
        },
      ),
    );
}

const addCommand = createAutomationAddCommand();

const updateCommand = addGithubAutomationOptions(
  addGmailAutomationOptions(
    new Command()
      .name("update")
      .description(
        "Replace a workflow automation's schedule or event filter config",
      )
      .argument("<automation>", "Workflow automation ID")
      .option("--expr <expression>", 'New cron schedule (e.g. "0 9 * * *")')
      .option("--at <iso-time>", 'New one-time fire (e.g. "2026-06-10T09:00")')
      .option("--every <duration>", "New loop interval (e.g. 15m, 1h, 90s)")
      .option("-z, --timezone <tz>", "IANA timezone for --expr / --at"),
  ),
)
  .addHelpText(
    "after",
    `
Examples:
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --expr "0 9 * * *" -z Asia/Shanghai
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --at "2026-06-10T09:00" -z UTC
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --every 10m
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --from-contains "@example.com"
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --config ./gmail-automation.json
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --label "Support"
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --actor anyone
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --conclusion failure,timed_out --branch main
  okou workflow automation update 22222222-2222-4222-8222-222222222222 --actor any`,
  )
  .action(
    withErrorHandler(async (id: string, options: UpdateOptions) => {
      const existing = await getWorkflowAutomation(id);
      const body = buildUpdate(options, existing);
      const automation = await updateWorkflowAutomation(id, body);

      console.log(chalk.green(`✓ Automation ${automation.id} updated`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationDetails(automation, { threadModel });
    }),
  );

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List a workflow's automations")
  .argument("<workflow>", "Workflow ID or name")
  .option("--agent <id>", "Agent ID for resolving a workflow name")
  .addHelpText(
    "after",
    `
Examples:
  okou workflow automation list tell-a-joke --agent <agent-id>
  okou workflow automation list <workflow-id>`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string, options: WorkflowRefOptions) => {
        const workflowId = await resolveWorkflowRef(workflowRef, options);
        const automations = await listWorkflowAutomations(workflowId);

        if (automations.length === 0) {
          console.log(chalk.dim("No automations"));
          console.log(
            chalk.dim(
              `  Add one with: okou workflow automation add ${workflowRef} cron --expr "0 9 * * *"`,
            ),
          );
          return;
        }

        printWorkflowAutomationsTable(automations, {
          showStripeDetails: true,
        });
      },
    ),
  );

const showCommand = new Command()
  .name("show")
  .description("Show a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await getWorkflowAutomation(id);
      const entries = await listWorkspaceWorkflowAutomations();
      const entry = entries.find(({ automation }) => {
        return automation.id === id;
      });
      if (!entry) {
        printWorkflowAutomationDetails(automation);
        return;
      }
      const threadModel = await loadWorkflowAutomationThreadModel(
        entry.automation,
      );
      printWorkflowAutomationDetails(entry.automation, {
        workflowRef: entry.workflow.name,
        workflowId: entry.workflow.id,
        threadModel,
      });
    }),
  );

const rmCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      await deleteWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${id} removed`));
    }),
  );

const enableCommand = new Command()
  .name("enable")
  .description("Enable a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await enableWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${automation.id} enabled`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationThreadModel(threadModel);
    }),
  );

const disableCommand = new Command()
  .name("disable")
  .description("Disable a workflow automation")
  .argument("<automation>", "Workflow automation ID")
  .action(
    withErrorHandler(async (id: string) => {
      const automation = await disableWorkflowAutomation(id);
      console.log(chalk.green(`✓ Automation ${automation.id} disabled`));
      const threadModel =
        await tryLoadWorkflowAutomationThreadModel(automation);
      printWorkflowAutomationThreadModel(threadModel);
    }),
  );

export const automationCommand = new Command()
  .name("automation")
  .alias("trigger")
  .description("Manage a workflow's automations")
  .addCommand(addCommand)
  .addCommand(updateCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(rmCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addHelpText(
    "after",
    `
Examples:
  Add an automation:     okou workflow automation add <workflow-id> cron --expr "0 9 * * *"
  Add a Notion page:     okou workflow automation add <workflow-id> notion-child-page-created --parent-page-url "https://www.notion.so/..."
  Add a webhook:         okou workflow automation add <workflow-id> webhook
  Update a schedule:     okou workflow automation update <automation-id> --every 10m
  List automations:      okou workflow automation list <workflow-id>
  Inspect an automation: okou workflow automation show <automation-id>
  Pause one automation:  okou workflow automation disable <automation-id>

chat-run-finished:
  Watches one user-owned chat thread, not one run ID. It can filter terminal
  status and a case-insensitive * wildcard over final assistant text. A match
  starts a new run in the workflow's automation thread rather than resuming the
  watched run. It remains enabled for future matches until disabled or removed.
  chat messages is only a point-in-time read; use this event when completion
  should trigger work instead of polling.`,
  );
