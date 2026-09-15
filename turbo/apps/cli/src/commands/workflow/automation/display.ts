import chalk from "chalk";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { GmailNewMessageEventConfig } from "@okouai/api-contracts/contracts/workflows";
import type { WorkflowAutomationSummary } from "../../../lib/api/domains/workflows";
import { formatRelativeTime } from "../../../lib/domain/relative-time";
import { formatDurationSeconds } from "../../shared/duration";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export interface WorkflowAutomationThreadModel {
  readonly id: string;
  readonly label: string;
  readonly serviceTier: ChatThreadServiceTier | null;
}

interface WorkflowAutomationDetailsOptions {
  readonly workflowRef?: string;
  readonly workflowId?: string;
  readonly threadModel?: WorkflowAutomationThreadModel;
}

interface WorkflowAutomationsTableOptions {
  readonly showStripeDetails?: boolean;
}

const GMAIL_TEXT_FIELDS: readonly GmailTextField[] = [
  "from",
  "subject",
  "body",
  "to",
  "cc",
];

type WorkflowWebhookAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "webhook-received" }
>;
type WorkflowNotionChildPageAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "notion-child-page-created" }
>;
type WorkflowNotionDatabaseItemAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "notion-database-item-created";
  }
>;
type WorkflowNotionPageContentUpdatedAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "notion-page-content-updated";
  }
>;
function chatRunFinishedKindLabel(eventConfig: {
  readonly chatThreadId: string;
  readonly runStatuses?: readonly string[];
  readonly outputPattern?: string;
}): string {
  const statuses = eventConfig.runStatuses?.join(",") ?? "any";
  const pattern = eventConfig.outputPattern
    ? ` matching "${eventConfig.outputPattern}"`
    : "";
  return `Chat run finished (${statuses})${pattern}: ${eventConfig.chatThreadId}`;
}

type WorkflowStripeInvoicePaidAutomationSummary = Extract<
  WorkflowAutomationSummary,
  { readonly kind: "event"; readonly eventType: "stripe-invoice-paid" }
>;
type WorkflowGoogleFormsAutomationSummary = Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType: "google-forms-response-submitted";
  }
>;

function isWebhookAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowWebhookAutomationSummary {
  return (
    automation.kind === "event" && automation.eventType === "webhook-received"
  );
}

function isNotionChildPageAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowNotionChildPageAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-child-page-created"
  );
}

function isNotionDatabaseItemAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowNotionDatabaseItemAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-database-item-created"
  );
}

function isNotionPageContentUpdatedAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowNotionPageContentUpdatedAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "notion-page-content-updated"
  );
}

function isGoogleCalendarAutomation(
  automation: WorkflowAutomationSummary,
): automation is Extract<
  WorkflowAutomationSummary,
  {
    readonly kind: "event";
    readonly eventType:
      | "google-calendar-event-created"
      | "google-calendar-event-updated"
      | "google-calendar-event-cancelled";
  }
> {
  return (
    automation.kind === "event" &&
    (automation.eventType === "google-calendar-event-created" ||
      automation.eventType === "google-calendar-event-updated" ||
      automation.eventType === "google-calendar-event-cancelled")
  );
}

function isGoogleFormsAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowGoogleFormsAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "google-forms-response-submitted"
  );
}

function isStripeInvoicePaidAutomation(
  automation: WorkflowAutomationSummary,
): automation is WorkflowStripeInvoicePaidAutomationSummary {
  return (
    automation.kind === "event" &&
    automation.eventType === "stripe-invoice-paid"
  );
}

function stripeBillingReasons(
  automation: WorkflowStripeInvoicePaidAutomationSummary,
): string {
  const billingReasons = automation.eventConfig.billingReasons;
  return billingReasons && billingReasons.length > 0
    ? billingReasons.join(", ")
    : "any";
}

const STRIPE_DELIVERY_FAILURE_WARNING =
  "The latest Stripe workflow delivery failed.";

function formatStripeInvoicePaidAutomationEntry(
  automation: WorkflowStripeInvoicePaidAutomationSummary,
): string {
  const billingReasons = stripeBillingReasons(automation);
  const billingReasonSummary =
    billingReasons === "any"
      ? "any billing reason"
      : `billing reasons: ${billingReasons}`;
  return [
    `Stripe invoice paid: ${automation.eventConfig.stripeAccountId} (${automation.eventConfig.mode})`,
    billingReasonSummary,
    `last matched: ${formatRelativeTime(automation.health.lastMatchingEventReceivedAt)}`,
    `delivery: ${automation.health.lastDeliveryStatus ?? "-"} at ${formatRelativeTime(automation.health.lastDeliveryStatusAt)}`,
  ].join("; ");
}

function printStripeDeliveryWarning(
  automation: WorkflowStripeInvoicePaidAutomationSummary,
): void {
  if (automation.health.warning === "delivery_failed") {
    console.warn(chalk.yellow(STRIPE_DELIVERY_FAILURE_WARNING));
  }
}

function printStripeInvoicePaidAutomationDetails(
  automation: WorkflowAutomationSummary,
): void {
  if (!isStripeInvoicePaidAutomation(automation)) {
    return;
  }
  console.log(
    `${"Stripe account ID:".padEnd(20)}${automation.eventConfig.stripeAccountId}`,
  );
  console.log(`${"Mode:".padEnd(20)}${automation.eventConfig.mode}`);
  console.log(
    `${"Billing reasons:".padEnd(20)}${stripeBillingReasons(automation)}`,
  );
  console.log(
    `${"Last matched:".padEnd(20)}${formatRunTime(automation.health.lastMatchingEventReceivedAt)}`,
  );
  console.log(
    `${"Delivery:".padEnd(20)}${automation.health.lastDeliveryStatus ?? chalk.dim("-")}`,
  );
  console.log(
    `${"Delivery at:".padEnd(20)}${formatRunTime(automation.health.lastDeliveryStatusAt)}`,
  );
  printStripeDeliveryWarning(automation);
}

function quote(value: string): string {
  return `"${value}"`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(", ");
}

function textMatcherParts(
  field: GmailTextField,
  matcher: GmailTextMatcher,
): string[] {
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(`${field} contains ${quote(matcher.contains)}`);
  }
  if (matcher.containsAny) {
    parts.push(`${field} contains any of ${quoteList(matcher.containsAny)}`);
  }
  if (matcher.doesNotContain) {
    parts.push(`${field} does not contain ${quote(matcher.doesNotContain)}`);
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      `${field} does not contain any of ${quoteList(matcher.doesNotContainAny)}`,
    );
  }
  return parts;
}

function formatGmailMatchSummary(config: GmailNewMessageEventConfig): string {
  const parts: string[] = config.threadId
    ? [`Thread ID is ${quote(config.threadId)}`]
    : [];
  const match = config.match;
  if (match) {
    for (const field of GMAIL_TEXT_FIELDS) {
      const matcher = match[field];
      if (matcher) {
        parts.push(...textMatcherParts(field, matcher));
      }
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

function formatGithubSubject(subject: string): string {
  if (subject === "pull_requests") {
    return "pull requests";
  }
  return subject;
}

function formatWebhookAutomationEntry(
  automation: WorkflowWebhookAutomationSummary,
): string {
  return `Webhook: ${automation.webhookUrl ?? "hidden"}`;
}

function formatNotionParentPage(
  automation: WorkflowNotionChildPageAutomationSummary,
): string {
  return (
    automation.eventConfig.parentPage.title ??
    automation.eventConfig.parentPage.url
  );
}

function formatNotionDatabase(
  automation: WorkflowNotionDatabaseItemAutomationSummary,
): string {
  return (
    automation.eventConfig.dataSource.title ??
    automation.eventConfig.dataSource.url
  );
}

function formatNotionContentUpdatedScope(
  automation: WorkflowNotionPageContentUpdatedAutomationSummary,
): string {
  return automation.eventConfig.scope.type === "page"
    ? (automation.eventConfig.scope.page.title ??
        automation.eventConfig.scope.page.url)
    : (automation.eventConfig.scope.dataSource.title ??
        automation.eventConfig.scope.dataSource.url);
}

function formatNotionContentUpdatedScopeUrl(
  automation: WorkflowNotionPageContentUpdatedAutomationSummary,
): string {
  return automation.eventConfig.scope.type === "page"
    ? automation.eventConfig.scope.page.url
    : automation.eventConfig.scope.dataSource.url;
}

function formatGoogleAutomationEntry(
  automation: WorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "google-calendar-event-created":
      return `Google Calendar event created: ${automation.eventConfig.calendarId}`;
    case "google-calendar-event-updated":
      return `Google Calendar event updated: ${automation.eventConfig.calendarId}`;
    case "google-calendar-event-cancelled":
      return `Google Calendar event cancelled: ${automation.eventConfig.calendarId}`;
    case "google-forms-response-submitted":
      return `Google Forms response submitted: ${automation.eventConfig.form.title}`;
    case "google-meet-transcript-generated":
      return "Google Meet transcript ready: meetings you organize";
    default:
      return null;
  }
}

function formatWorkflowAutomationEntry(
  automation: WorkflowAutomationSummary,
  options: WorkflowAutomationsTableOptions = {},
): string {
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-new-message"
  ) {
    return `Gmail new message: ${formatGmailMatchSummary(automation.eventConfig)}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-label-applied"
  ) {
    return `Gmail label applied: ${quote(automation.eventConfig.labelName)}`;
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "github-pull-request"
  ) {
    const { action, merged, repository } = automation.eventConfig;
    const mergedSuffix =
      merged === undefined ? "" : merged ? ", merged" : ", not merged";
    return `GitHub pull request ${action}: ${repository}${mergedSuffix}`;
  }
  const googleEntry = formatGoogleAutomationEntry(automation);
  if (googleEntry !== null) {
    return googleEntry;
  }
  if (isWebhookAutomation(automation)) {
    return formatWebhookAutomationEntry(automation);
  }
  if (options.showStripeDetails && isStripeInvoicePaidAutomation(automation)) {
    return formatStripeInvoicePaidAutomationEntry(automation);
  }

  if (automation.kind !== "schedule") {
    return workflowAutomationKindLabel(automation);
  }

  const { schedule } = automation;
  switch (schedule.type) {
    case "cron":
      return `${schedule.cronExpression} (${schedule.timezone})`;
    case "once":
      return `at ${schedule.atTime} (${schedule.timezone})`;
    case "loop":
      return `every ${formatDurationSeconds(schedule.intervalSeconds)}`;
  }
}

function formatRunTime(value: string | null): string {
  return value ? formatRelativeTime(value) : chalk.dim("-");
}

function formatRunTimestamp(value: string | null): string {
  if (value === null) {
    return chalk.dim("-");
  }

  const timestamp = new Date(value);
  const offsetMinutes = -timestamp.getTimezoneOffset();
  const localTimestamp = new Date(timestamp.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .replace(/(?:\.000)?Z$/, "");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
    2,
    "0",
  );
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `${localTimestamp}${sign}${hours}:${minutes}`;
}

function printRunTimeGuidance(value: string | null): void {
  if (value === null) {
    return;
  }
  const timestamp = formatRunTimestamp(value);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log("");
  console.log(chalk.bold("Time display guidance:"));
  console.log(
    "  If you show a run time to the user, use a <time> tag directly in prose:",
  );
  console.log(`    <time datetime="${timestamp}">${timestamp}</time>`);
  console.log(
    `  Use the current environment timezone (${timezone}) for datetime and`,
  );
  console.log(
    "  visible text, retaining the numeric UTC offset for that date.",
  );
  console.log("  Do not wrap the tag in inline code or a code block.");
}

function workflowAutomationKindLabel(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind !== "event") {
    return formatWorkflowAutomationEntry(automation);
  }
  const googleLabel = googleAutomationKindLabel(automation);
  if (googleLabel !== null) {
    return googleLabel;
  }
  switch (automation.eventType) {
    case "chat-run-finished":
      return chatRunFinishedKindLabel(automation.eventConfig);
    case "gmail-new-message":
      return "Gmail new message";
    case "gmail-label-applied":
      return "Gmail label applied";
    case "github-pull-request":
      return "GitHub pull request";
    case "github-deployment-status-created":
      return "GitHub deployment status created";
    case "github-issue-comment-created":
      return "GitHub issue comment created";
    case "github-pull-request-review-submitted":
      return "GitHub pull request review submitted";
    case "github-workflow-job-completed":
      return "GitHub workflow job completed";
    case "github-workflow-run-completed":
      return "GitHub workflow completed";
    case "notion-child-page-created":
      return `New Notion child page: ${formatNotionParentPage(automation)}`;
    case "notion-database-item-created":
      return `New Notion database item: ${formatNotionDatabase(automation)}`;
    case "notion-page-content-updated":
      return `Notion page content updated: ${formatNotionContentUpdatedScope(automation)}`;
    case "stripe-invoice-paid":
      return "Stripe invoice paid";
    case "webhook-received":
      return "Webhook";
  }
  throw new Error("Unsupported workflow automation event");
}

function googleAutomationKindLabel(
  automation: Extract<WorkflowAutomationSummary, { kind: "event" }>,
): string | null {
  switch (automation.eventType) {
    case "google-calendar-event-created":
      return "Google Calendar event created";
    case "google-calendar-event-updated":
      return "Google Calendar event updated";
    case "google-calendar-event-cancelled":
      return "Google Calendar event cancelled";
    case "google-forms-response-submitted":
      return `Google Forms response submitted: ${automation.eventConfig.form.title}`;
    case "google-meet-transcript-generated":
      return "Google Meet transcript ready";
    default:
      return null;
  }
}

function signedCurlExample(
  automation: WorkflowWebhookAutomationSummary,
): string {
  const secret = automation.webhookSecret ?? "<signing-secret>";
  const webhookUrl = automation.webhookUrl ?? "<webhook-url>";
  return [
    `BODY='{"hello":"world"}'`,
    "TIMESTAMP=$(date +%s)",
    `SIGNATURE=$(printf "%s.%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $2}')`,
    `curl -X POST "${webhookUrl}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "X-Okou-Timestamp: $TIMESTAMP" \\',
    '  -H "X-Okou-Signature: $SIGNATURE" \\',
    '  --data "$BODY"',
  ].join("\n");
}

export function printWorkflowAutomationsTable(
  automations: readonly WorkflowAutomationSummary[],
  options: WorkflowAutomationsTableOptions = {},
): void {
  const idWidth = Math.max(
    2,
    ...automations.map((automation) => {
      return automation.id.length;
    }),
  );
  const scheduleWidth = Math.max(
    7,
    ...automations.map((automation) => {
      return formatWorkflowAutomationEntry(automation, options).length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "STATUS".padEnd(8),
        "AUTOMATION".padEnd(scheduleWidth),
        "NEXT RUN",
      ].join("  "),
    ),
  );

  for (const automation of automations) {
    const status = automation.enabled
      ? chalk.green("enabled")
      : chalk.yellow("disabled");
    console.log(
      [
        automation.id.padEnd(idWidth),
        status.padEnd(8 + (automation.enabled ? 0 : 2)),
        formatWorkflowAutomationEntry(automation, options).padEnd(
          scheduleWidth,
        ),
        formatRunTimestamp(automation.nextRunAt),
      ].join("  "),
    );
  }
  printRunTimeGuidance(
    automations.find((automation) => {
      return automation.nextRunAt !== null;
    })?.nextRunAt ?? null,
  );
  if (!options.showStripeDetails) {
    return;
  }
  for (const automation of automations) {
    if (
      isStripeInvoicePaidAutomation(automation) &&
      automation.health.warning === "delivery_failed"
    ) {
      console.warn(
        chalk.yellow(
          `Warning for automation ${automation.id}: ${STRIPE_DELIVERY_FAILURE_WARNING}`,
        ),
      );
    }
  }
}

function printGithubFilters(automation: WorkflowAutomationSummary): void {
  if (automation.kind !== "event") {
    return;
  }
  const printFilter = (
    label: string,
    values: readonly string[] | undefined,
  ) => {
    console.log(`${`${label}:`.padEnd(14)}${values?.join(", ") ?? "any"}`);
  };
  switch (automation.eventType) {
    case "github-pull-request": {
      const { filters } = automation.eventConfig;
      printFilter("Base branches", filters.baseBranches);
      printFilter("Authors", filters.authors);
      printFilter("PR numbers", filters.pullRequestNumbers);
      printFilter("Labels", filters.labels);
      return;
    }
    case "github-workflow-run-completed": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Workflows", filters.workflows);
      printFilter("Conclusions", filters.conclusions);
      printFilter("Branches", filters.branches);
      printFilter("Events", filters.events);
      printFilter("Actors", filters.actors);
      return;
    }
    case "github-workflow-job-completed": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Workflows", filters.workflows);
      printFilter("Jobs", filters.jobs);
      printFilter("Conclusions", filters.conclusions);
      printFilter("Branches", filters.branches);
      printFilter("Runner labels", filters.runnerLabels);
      printFilter("Runner groups", filters.runnerGroups);
      return;
    }
    case "github-pull-request-review-submitted": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Review states", filters.reviewStates);
      printFilter("Base branches", filters.baseBranches);
      printFilter("Head branches", filters.headBranches);
      printFilter("Authors", filters.trustedAuthors);
      return;
    }
    case "github-deployment-status-created": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      printFilter("Environments", filters.environments);
      printFilter("States", filters.states);
      printFilter("Refs", filters.refs);
      console.log(
        `${"Production:".padEnd(14)}${
          filters.productionEnvironment === undefined
            ? "any"
            : String(filters.productionEnvironment)
        }`,
      );
      printFilter("Creators", filters.creators);
      printFilter("Apps", filters.apps);
      return;
    }
    case "github-issue-comment-created": {
      const { filters } = automation.eventConfig;
      printFilter("Repositories", filters.repositories);
      console.log(
        `${"Subject:".padEnd(14)}${formatGithubSubject(filters.subject)}`,
      );
      printFilter("Authors", filters.trustedAuthors);
      printFilter("Prefixes", filters.commentPrefixes);
      return;
    }
    default: {
      return;
    }
  }
}

function printCommand(lines: readonly string[]): void {
  for (const line of lines) {
    console.log(chalk.cyan(`    ${line}`));
  }
}

function stripeRecreateCommand(
  automation: WorkflowStripeInvoicePaidAutomationSummary,
  workflowId: string,
): string {
  const billingReasons = automation.eventConfig.billingReasons;
  const billingReasonOption =
    billingReasons && billingReasons.length > 0
      ? ` --billing-reason ${billingReasons.join(",")}`
      : "";
  return `okou workflow automation add ${workflowId} stripe-invoice-paid${billingReasonOption}`;
}

function automationUpdateGuidance(
  automation: WorkflowAutomationSummary,
  workflowId: string,
): {
  readonly label: string;
  readonly command: readonly string[];
} {
  if (isStripeInvoicePaidAutomation(automation)) {
    return {
      label: "Change billing reasons (delete and recreate)",
      command: [
        `okou workflow automation rm ${automation.id}`,
        stripeRecreateCommand(automation, workflowId),
      ],
    };
  }
  if (automation.kind !== "schedule") {
    return {
      label: "Edit automation",
      command: ["okou workflow automation update --help"],
    };
  }

  switch (automation.schedule.type) {
    case "cron":
      return {
        label: "Change schedule",
        command: [
          "okou workflow automation update \\",
          `  ${automation.id} \\`,
          '  --expr "<cron-expression>" -z <timezone>',
        ],
      };
    case "loop":
      return {
        label: "Change interval",
        command: [
          "okou workflow automation update \\",
          `  ${automation.id} \\`,
          "  --every <duration>",
        ],
      };
    case "once":
      return {
        label: "Change run time",
        command: [
          "okou workflow automation update \\",
          `  ${automation.id} \\`,
          '  --at "<iso-time>" -z <timezone>',
        ],
      };
  }
}

function printManagementCommands(
  automation: WorkflowAutomationSummary,
  options: WorkflowAutomationDetailsOptions,
): void {
  if (!options.workflowId) {
    return;
  }

  const update = automationUpdateGuidance(automation, options.workflowId);
  const statusAction = automation.enabled
    ? {
        label: "Pause automation",
        command: "disable",
      }
    : {
        label: "Resume automation",
        command: "enable",
      };

  console.log("");
  console.log(chalk.bold("Manage with Okou CLI:"));
  console.log("  Edit workflow:");
  printCommand([
    `okou workflow edit ${options.workflowId} \\`,
    "  --instruction-file <path>",
  ]);
  console.log("");
  console.log(`  ${update.label}:`);
  printCommand(update.command);
  console.log("");
  console.log(`  ${statusAction.label}:`);
  printCommand([
    `okou workflow automation ${statusAction.command} \\`,
    `  ${automation.id}`,
  ]);
  console.log("");
  console.log("  More automation options:");
  printCommand(["okou workflow automation --help"]);

  if (!automation.chatThreadId || !options.threadModel) {
    return;
  }

  console.log("");
  console.log(chalk.bold("About model selection:"));
  console.log(
    "  The selected model affects run behavior, output quality, and cost.",
  );
  console.log(
    "  Automations do not store a separate model. All automations on this workflow",
  );
  console.log(
    "  share one chat thread and use that thread's model. Changing the thread model",
  );
  console.log("  changes the model used by all of them.");
  console.log("");
  console.log(chalk.bold("Model commands:"));
  console.log("  Show:");
  printCommand(["okou chat model \\", `  --thread ${automation.chatThreadId}`]);
  console.log("");
  console.log("  Change:");
  printCommand([
    "okou chat model \\",
    `  --thread ${automation.chatThreadId} \\`,
    "  <model-id>",
  ]);
  console.log("");
  console.log("  Options:");
  printCommand(["okou model list"]);
}

export function printWorkflowAutomationThreadModel(
  model: WorkflowAutomationThreadModel | undefined,
): void {
  if (!model) {
    return;
  }
  console.log(
    `${"Thread model:".padEnd(14)}${model.label} ${chalk.dim(`(${model.id})`)}`,
  );
  const priority = model.serviceTier === "priority" ? "enabled" : "disabled";
  console.log(`${"Thread priority:".padEnd(18)}${priority}`);
}

function printGoogleFormsAutomationDetails(
  automation: WorkflowAutomationSummary,
): void {
  if (!isGoogleFormsAutomation(automation)) {
    return;
  }
  console.log(`${"Form:".padEnd(14)}${automation.eventConfig.form.title}`);
  console.log(`${"Form ID:".padEnd(14)}${automation.eventConfig.form.id}`);
  console.log(`${"Form URL:".padEnd(14)}${automation.eventConfig.form.url}`);
  if (automation.warning) {
    console.warn(`${"Warning:".padEnd(14)}${chalk.yellow(automation.warning)}`);
  }
}

function printGithubPullRequestDetails(
  automation: WorkflowAutomationSummary,
): void {
  if (
    automation.kind !== "event" ||
    automation.eventType !== "github-pull-request"
  ) {
    return;
  }
  console.log(
    `${"Repository:".padEnd(14)}${automation.eventConfig.repository}`,
  );
  console.log(`${"Action:".padEnd(14)}${automation.eventConfig.action}`);
  console.log(
    `${"Merged:".padEnd(14)}${
      automation.eventConfig.merged === undefined
        ? "any"
        : automation.eventConfig.merged
          ? "yes"
          : "no"
    }`,
  );
}

export function printWorkflowAutomationDetails(
  automation: WorkflowAutomationSummary,
  options: WorkflowAutomationDetailsOptions = {},
): void {
  const status = automation.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");

  console.log(`${"Kind:".padEnd(14)}${automation.kind}`);
  console.log(`${"ID:".padEnd(14)}${automation.id}`);
  if (options?.workflowRef) {
    console.log(`${"Workflow:".padEnd(14)}${options.workflowRef}`);
  }
  console.log(`${"Status:".padEnd(14)}${status}`);
  console.log(
    `${"Automation:".padEnd(14)}${workflowAutomationKindLabel(automation)}`,
  );
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-new-message"
  ) {
    console.log(
      `${"Match:".padEnd(14)}${formatGmailMatchSummary(automation.eventConfig)}`,
    );
  }
  if (
    automation.kind === "event" &&
    automation.eventType === "gmail-label-applied"
  ) {
    console.log(`${"Label:".padEnd(14)}${automation.eventConfig.labelName}`);
  }
  printGithubPullRequestDetails(automation);
  printGithubFilters(automation);
  if (isGoogleCalendarAutomation(automation)) {
    console.log(
      `${"Calendar:".padEnd(14)}${automation.eventConfig.calendarId}`,
    );
  }
  printGoogleFormsAutomationDetails(automation);
  if (isNotionChildPageAutomation(automation)) {
    console.log(
      `${"Parent page:".padEnd(14)}${formatNotionParentPage(automation)}`,
    );
    console.log(
      `${"Parent URL:".padEnd(14)}${automation.eventConfig.parentPage.url}`,
    );
  }
  if (isNotionDatabaseItemAutomation(automation)) {
    console.log(`${"Database:".padEnd(14)}${formatNotionDatabase(automation)}`);
    console.log(
      `${"Database URL:".padEnd(14)}${automation.eventConfig.dataSource.url}`,
    );
  }
  if (isNotionPageContentUpdatedAutomation(automation)) {
    const scopeLabel =
      automation.eventConfig.scope.type === "page" ? "Page" : "Database";
    console.log(`${"Scope:".padEnd(14)}${scopeLabel}`);
    console.log(
      `${`${scopeLabel}:`.padEnd(14)}${formatNotionContentUpdatedScope(automation)}`,
    );
    console.log(
      `${`${scopeLabel} URL:`.padEnd(14)}${formatNotionContentUpdatedScopeUrl(automation)}`,
    );
  }
  if (isWebhookAutomation(automation)) {
    console.log(
      `${"Webhook URL:".padEnd(14)}${automation.webhookUrl ?? "hidden"}`,
    );
    console.log(
      `${"Secret:".padEnd(14)}${chalk.dim(`ends with ${automation.secretLastFour}`)}`,
    );
    console.log(
      `${"Last received:".padEnd(14)}${formatRunTime(automation.lastReceivedAt)}`,
    );
    if (automation.webhookSecret) {
      console.log(
        `${"Signing key:".padEnd(14)}${automation.webhookSecret} ${chalk.dim(
          "(shown only once)",
        )}`,
      );
      console.log("");
      console.log(chalk.bold("Signed curl example:"));
      console.log(signedCurlExample(automation));
    }
  }
  printStripeInvoicePaidAutomationDetails(automation);
  console.log(`${"Owner:".padEnd(14)}${automation.ownerUserId}`);
  console.log(
    `${"Chat thread:".padEnd(14)}${automation.chatThreadId ?? chalk.dim("-")}`,
  );
  printWorkflowAutomationThreadModel(options.threadModel);
  console.log(
    `${"Next run:".padEnd(14)}${formatRunTimestamp(automation.nextRunAt)}`,
  );
  console.log(
    `${"Last run:".padEnd(14)}${formatRunTimestamp(automation.lastRunAt)}`,
  );
  printRunTimeGuidance(automation.nextRunAt ?? automation.lastRunAt);
  printManagementCommands(automation, options);
}
