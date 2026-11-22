// Shared presentational helpers for the workflow list, index, and detail views.
import type {
  ChatRunFinishedEventConfig,
  ChatRunFinishedRunStatus,
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
  GithubDeploymentState,
  GithubPullRequestReviewState,
  GithubWorkflowRunConclusion,
  WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";

import { currentLocale, i18n } from "../../i18n/index.ts";

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function labelInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .slice(0, 2)
      .map((word) => {
        return word.charAt(0);
      })
      .join("")
      .toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "??").toUpperCase();
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

const WORKFLOW_INTERVAL_SECONDS_OPTIONS = [5, 15, 30, 60].map((minutes) => {
  return minutes * 60;
});

export function getWorkflowIntervalSecondOptions(
  currentSeconds?: number,
): readonly number[] {
  if (
    currentSeconds === undefined ||
    WORKFLOW_INTERVAL_SECONDS_OPTIONS.includes(currentSeconds)
  ) {
    return WORKFLOW_INTERVAL_SECONDS_OPTIONS;
  }
  return [...WORKFLOW_INTERVAL_SECONDS_OPTIONS, currentSeconds].sort((a, b) => {
    return a - b;
  });
}

export function formatWorkflowIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return i18n.t(
      ($) => {
        return $.workflows.automations.duration.hour;
      },
      { count: hours },
    );
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return i18n.t(
      ($) => {
        return $.workflows.automations.duration.minute;
      },
      { count: minutes },
    );
  }
  return i18n.t(
    ($) => {
      return $.workflows.automations.duration.second;
    },
    { count: seconds },
  );
}

export function automationKindLabel(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return i18n.t(($) => {
      return $.workflows.automations.common.scheduleAutomation;
    });
  }
  return automation.eventType === "webhook-received"
    ? i18n.t(($) => {
        return $.workflows.automations.common.webhookAutomation;
      })
    : i18n.t(($) => {
        return $.workflows.automations.common.eventAutomation;
      });
}

export function githubAutomationFilterValueLabel(
  value:
    | GithubDeploymentState
    | GithubPullRequestReviewState
    | GithubWorkflowRunConclusion,
): string {
  switch (value) {
    case "success": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.success;
      });
    }
    case "failure": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.failure;
      });
    }
    case "cancelled": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.cancelled;
      });
    }
    case "timed_out": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.timedOut;
      });
    }
    case "action_required": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.actionRequired;
      });
    }
    case "neutral": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.neutral;
      });
    }
    case "skipped": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.skipped;
      });
    }
    case "stale": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.stale;
      });
    }
    case "startup_failure": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.startupFailure;
      });
    }
    case "approved": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.approved;
      });
    }
    case "changes_requested": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.changesRequested;
      });
    }
    case "commented": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.commented;
      });
    }
    case "error": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.error;
      });
    }
    case "pending": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.pending;
      });
    }
    case "in_progress": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.inProgress;
      });
    }
    case "queued": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.queued;
      });
    }
    case "waiting": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.waiting;
      });
    }
    case "inactive": {
      return i18n.t(($) => {
        return $.workflows.automations.github.option.inactive;
      });
    }
  }
}

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export const GMAIL_TEXT_FIELDS: readonly {
  readonly field: GmailTextField;
  readonly label: string;
}[] = [
  {
    field: "from",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.from;
      });
    },
  },
  {
    field: "subject",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.subject;
      });
    },
  },
  {
    field: "body",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.body;
      });
    },
  },
  {
    field: "to",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.to;
      });
    },
  },
  {
    field: "cc",
    get label() {
      return i18n.t(($) => {
        return $.workflows.automations.gmail.field.cc;
      });
    },
  },
];

export function formTextValue(
  form: FormData,
  name: string,
): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formTextValues(
  form: FormData,
  name: string,
): readonly string[] | undefined {
  const value = formTextValue(form, name);
  if (!value) {
    return undefined;
  }
  const values = value
    .split(",")
    .map((entry) => {
      return entry.trim();
    })
    .filter((entry) => {
      return entry.length > 0;
    });
  return values.length > 0 ? values : undefined;
}

export function buildGmailNewMessageEventConfig(
  form: FormData,
  baseConfig?: GmailNewMessageEventConfig,
): GmailNewMessageEventConfig {
  const baseMatch = baseConfig?.match;
  const threadId = formTextValue(form, "threadId");
  const match: GmailMatchRules = {};
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const existing = baseMatch?.[field];
    const contains = formTextValue(form, `${field}Contains`);
    const containsAny = formTextValues(form, `${field}ContainsAny`);
    const doesNotContain = formTextValue(form, `${field}DoesNotContain`);
    const matcher: GmailTextMatcher = {};
    if (existing?.doesNotContainAny) {
      matcher.doesNotContainAny = existing.doesNotContainAny;
    }
    if (contains) {
      matcher.contains = contains;
    }
    if (containsAny) {
      matcher.containsAny = [...containsAny];
    }
    if (doesNotContain) {
      matcher.doesNotContain = doesNotContain;
    }
    if (Object.keys(matcher).length > 0) {
      match[field] = matcher;
    }
  }
  return {
    provider: "gmail",
    event: "new_message",
    ...(threadId ? { threadId } : {}),
    ...(Object.keys(match).length > 0 ? { match } : {}),
  };
}

export function buildGmailLabelAppliedEventConfig(
  form: FormData,
): GmailLabelAppliedEventConfig | null {
  const labelName = formTextValue(form, "labelName");
  if (!labelName) {
    return null;
  }
  return {
    provider: "gmail",
    event: "label_applied",
    labelName,
  };
}

export function chatRunFinishedStatusLabel(
  status: ChatRunFinishedRunStatus,
): string {
  switch (status) {
    case "completed": {
      return i18n.t(($) => {
        return $.workflows.automations.chat.statusCompleted;
      });
    }
    case "failed": {
      return i18n.t(($) => {
        return $.workflows.automations.chat.statusFailed;
      });
    }
    case "cancelled": {
      return i18n.t(($) => {
        return $.workflows.automations.chat.statusCancelled;
      });
    }
  }
}

function chatRunFinishedAutomationSummary(
  config: ChatRunFinishedEventConfig,
): string {
  const statusText = config.runStatuses
    ? config.runStatuses.map(chatRunFinishedStatusLabel).join(", ")
    : i18n.t(($) => {
        return $.workflows.automations.chat.anyStatus;
      });
  return config.outputPattern
    ? `${statusText} · ${quote(config.outputPattern)}`
    : statusText;
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
  const fieldOption = GMAIL_TEXT_FIELDS.find((candidate) => {
    return candidate.field === field;
  });
  if (!fieldOption) {
    throw new Error(`Unknown Gmail text field: ${field}`);
  }
  const fieldLabel = fieldOption.label.toLocaleLowerCase(currentLocale());
  if (matcher.contains) {
    parts.push(
      i18n.t(
        ($) => {
          return $.workflows.automations.gmail.summary.contains;
        },
        { field: fieldLabel, value: quote(matcher.contains) },
      ),
    );
  }
  if (matcher.containsAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.workflows.automations.gmail.summary.containsAny;
        },
        { field: fieldLabel, value: quoteList(matcher.containsAny) },
      ),
    );
  }
  if (matcher.doesNotContain) {
    parts.push(
      i18n.t(
        ($) => {
          return $.workflows.automations.gmail.summary.doesNotContain;
        },
        { field: fieldLabel, value: quote(matcher.doesNotContain) },
      ),
    );
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.workflows.automations.gmail.summary.doesNotContainAny;
        },
        { field: fieldLabel, value: quoteList(matcher.doesNotContainAny) },
      ),
    );
  }
  return parts;
}

function formatGmailMatchSummary(config: GmailNewMessageEventConfig): string {
  const parts: string[] = config.threadId
    ? [
        i18n.t(
          ($) => {
            return $.workflows.automations.gmail.summary.threadId;
          },
          { value: quote(config.threadId) },
        ),
      ]
    : [];
  const match = config.match;
  if (match) {
    for (const { field } of GMAIL_TEXT_FIELDS) {
      const matcher = match[field];
      if (matcher) {
        parts.push(...textMatcherParts(field, matcher));
      }
    }
  }
  return parts.length > 0
    ? parts.join("; ")
    : i18n.t(($) => {
        return $.workflows.automations.gmail.allInboundMessages;
      });
}

export function gmailAutomationTitle(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return automation.scheduleSummary;
  }
  if (automation.eventType === "chat-run-finished") {
    return i18n.t(($) => {
      return $.workflows.automations.chat.runFinishedTitle;
    });
  }
  if (automation.eventType === "gmail-label-applied") {
    return i18n.t(($) => {
      return $.workflows.automations.gmail.labelAppliedTitle;
    });
  }
  if (automation.eventType === "gmail-new-message") {
    return i18n.t(($) => {
      return $.workflows.automations.gmail.newMessageTitle;
    });
  }
  if (automation.eventType === "github-pull-request") {
    return i18n.t(($) => {
      return $.workflows.automations.github.pullRequestTitle;
    });
  }
  if (automation.eventType === "github-workflow-job-completed") {
    return i18n.t(($) => {
      return $.workflows.automations.github.workflowJobTitle;
    });
  }
  if (automation.eventType === "github-pull-request-review-submitted") {
    return i18n.t(($) => {
      return $.workflows.automations.github.reviewTitle;
    });
  }
  if (automation.eventType === "github-deployment-status-created") {
    return i18n.t(($) => {
      return $.workflows.automations.github.deploymentStatusTitle;
    });
  }
  if (automation.eventType === "github-issue-comment-created") {
    return i18n.t(($) => {
      return $.workflows.automations.github.issueCommentTitle;
    });
  }
  if (automation.eventType === "github-workflow-run-completed") {
    return i18n.t(($) => {
      return $.workflows.automations.github.workflowRunTitle;
    });
  }
  if (automation.eventType === "google-calendar-event-created") {
    return i18n.t(($) => {
      return $.workflows.automations.calendar.createdTitle;
    });
  }
  if (automation.eventType === "google-calendar-event-updated") {
    return i18n.t(($) => {
      return $.workflows.automations.calendar.updatedTitle;
    });
  }
  if (automation.eventType === "google-calendar-event-cancelled") {
    return i18n.t(($) => {
      return $.workflows.automations.calendar.cancelledTitle;
    });
  }
  if (automation.eventType === "google-forms-response-submitted") {
    return i18n.t(($) => {
      return $.workflows.automations.forms.responseSubmittedTitle;
    });
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return i18n.t(($) => {
      return $.workflows.automations.meet.transcriptReadyTitle;
    });
  }
  if (automation.eventType === "notion-child-page-created") {
    return i18n.t(($) => {
      return $.workflows.automations.notion.childPageTitle;
    });
  }
  if (automation.eventType === "notion-database-item-created") {
    return i18n.t(($) => {
      return $.workflows.automations.notion.databaseItemTitle;
    });
  }
  if (automation.eventType === "notion-page-content-updated") {
    return i18n.t(($) => {
      return $.workflows.automations.notion.contentUpdatedTitle;
    });
  }
  return i18n.t(($) => {
    return $.workflows.automations.common.webhookAutomation;
  });
}

function githubAutomationSummary(
  automation: Extract<WorkflowAutomationSummary, { readonly kind: "event" }>,
): string | null {
  switch (automation.eventType) {
    case "github-pull-request": {
      const config = automation.eventConfig;
      return [config.repository, config.action].join(" · ");
    }
    case "github-workflow-run-completed":
    case "github-workflow-job-completed": {
      return (
        automation.eventConfig.filters.conclusions
          ?.map(githubAutomationFilterValueLabel)
          .join(", ") ??
        i18n.t(($) => {
          return $.workflows.automations.github.anyResult;
        })
      );
    }
    case "github-pull-request-review-submitted": {
      return (
        automation.eventConfig.filters.reviewStates
          ?.map(githubAutomationFilterValueLabel)
          .join(", ") ??
        i18n.t(($) => {
          return $.workflows.automations.github.anyReview;
        })
      );
    }
    case "github-deployment-status-created": {
      return (
        automation.eventConfig.filters.states
          ?.map(githubAutomationFilterValueLabel)
          .join(", ") ??
        i18n.t(($) => {
          return $.workflows.automations.github.anyDeploymentState;
        })
      );
    }
    case "github-issue-comment-created": {
      return (
        automation.eventConfig.filters.commentPrefixes?.join(", ") ??
        i18n.t(($) => {
          return $.workflows.automations.github.anyComment;
        })
      );
    }
    default: {
      return null;
    }
  }
}

export function gmailAutomationSummary(
  automation: WorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  if (automation.eventType === "chat-run-finished") {
    return chatRunFinishedAutomationSummary(automation.eventConfig);
  }
  if (automation.eventType === "gmail-label-applied") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.gmail.labelSummary;
      },
      { label: quote(automation.eventConfig.labelName) },
    );
  }
  if (automation.eventType === "gmail-new-message") {
    return formatGmailMatchSummary(automation.eventConfig);
  }
  const githubSummary = githubAutomationSummary(automation);
  if (githubSummary) {
    return githubSummary;
  }
  if (
    automation.eventType === "google-calendar-event-created" ||
    automation.eventType === "google-calendar-event-updated" ||
    automation.eventType === "google-calendar-event-cancelled"
  ) {
    return i18n.t(
      ($) => {
        return $.workflows.automations.calendar.summary;
      },
      { calendar: quote(automation.eventConfig.calendarId) },
    );
  }
  if (automation.eventType === "google-forms-response-submitted") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.forms.summary;
      },
      { form: quote(automation.eventConfig.form.title) },
    );
  }
  if (automation.eventType === "google-meet-transcript-generated") {
    return i18n.t(($) => {
      return $.workflows.automations.meet.summary;
    });
  }
  if (automation.eventType === "notion-child-page-created") {
    const title = automation.eventConfig.parentPage.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.parentPageSummary;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.configuredParentPage;
        });
  }
  if (automation.eventType === "notion-database-item-created") {
    const title = automation.eventConfig.dataSource.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.databaseSummary;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.configuredDatabase;
        });
  }
  if (automation.eventType === "notion-page-content-updated") {
    if (automation.eventConfig.scope.type === "page") {
      const title = automation.eventConfig.scope.page.title;
      return title
        ? i18n.t(
            ($) => {
              return $.workflows.automations.notion.pageSummary;
            },
            { title: quote(title) },
          )
        : i18n.t(($) => {
            return $.workflows.automations.notion.configuredPage;
          });
    }
    const title = automation.eventConfig.scope.dataSource.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.databaseSummary;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.configuredDatabase;
        });
  }
  return null;
}

export function gmailMatcherDefaultValue(
  config: GmailNewMessageEventConfig,
  field: GmailTextField,
  key: "contains" | "containsAny" | "doesNotContain",
): string {
  const value = config.match?.[field]?.[key];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}
