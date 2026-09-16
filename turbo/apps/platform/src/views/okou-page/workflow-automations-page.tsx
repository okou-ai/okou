import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import type {
  WorkflowSummary,
  WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  CalendarClock,
  Clock,
  DatabasePlus,
  FilePen,
  FilePlus,
  Link,
  Mail,
  MessageCircle,
  Repeat,
  Tag,
  Video,
} from "lucide-react";
import { Button, Switch, cn, BrandGithub, BrandStripe } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { agents$ } from "../../signals/agent.ts";
import {
  selectedWorkflowAutomationAgentId$,
  setWorkflowAutomationAgentQuery$,
  setWorkflowAutomationDialogOpen$,
  startCreateWorkflowFromAutomationDialog$,
  workflowAutomationAgentSelectionLocked$,
  workflowAutomationAgentQuery$,
  workflowAutomationDialogIntent$,
  workflowAutomationDialogOpen$,
} from "../../signals/automation-page/workflow-automation-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  setWorkflowAutomationEnabled$,
  workflowWebhookUpgradeDialogSource$,
  type WorkflowAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/okou-page/cron.ts";
import { pinnedAgentIds$ } from "../../signals/okou-page/pinned-agents.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  AgentDialogAgentButton,
  agentDialogMatchesQuery,
  AgentDialogSearch,
  AgentDialogSection,
} from "./sidebar-dialogs.tsx";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import {
  agentLabel,
  formatWorkflowIntervalSeconds,
  githubAutomationFilterValueLabel,
  gmailAutomationSummary,
  gmailAutomationTitle,
  labelInitials,
  workflowTitle,
} from "../workflows-page/workflow-shared.tsx";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../signals/chat-page/workflow-prompt-action";

const CREATE_AUTOMATION_CHAT_PROMPT =
  "Help me create a workflow automation for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

function currentLocale(): string {
  return i18n.resolvedLanguage ?? "en-US";
}

function formatClockTime(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

function formatDateInTimezone(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(new Date(value));
}

function weekdayName(day: number): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 7 + day)));
}

function shiftedCronWeekdays(
  dayOfWeek: string,
  dayOffset: number,
): readonly number[] | null {
  const sourceDays =
    dayOfWeek === "1-5"
      ? [1, 2, 3, 4, 5]
      : dayOfWeek.split(",").map((day) => {
          return Number(day);
        });
  if (
    sourceDays.length === 0 ||
    sourceDays.some((day) => {
      return !Number.isInteger(day) || day < 0 || day > 6;
    })
  ) {
    return null;
  }
  return [
    ...new Set(
      sourceDays.map((day) => {
        return (day + dayOffset + 7) % 7;
      }),
    ),
  ].sort((left, right) => {
    return left - right;
  });
}

function cronRuleLabel(
  cronExpression: string,
  sourceTimezone: string,
  displayTimezone: string,
): string {
  const [minutePart, hourPart, dayOfMonth = "*", , dayOfWeek = "*"] =
    cronExpression.split(" ");
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return `${cronExpression} (${sourceTimezone})`;
  }
  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    sourceTimezone,
    displayTimezone,
  );
  const time = formatClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*") {
    const numericDay = Number(dayOfMonth);
    const shiftedDay = numericDay + converted.dayOffset;
    const displayDay =
      Number.isInteger(numericDay) && shiftedDay >= 1 && shiftedDay <= 31
        ? String(shiftedDay)
        : dayOfMonth;
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.everyMonthAt;
      },
      { day: displayDay, time },
    );
  }
  const shiftedDays =
    dayOfWeek === "*"
      ? null
      : shiftedCronWeekdays(dayOfWeek, converted.dayOffset);
  if (
    shiftedDays?.length === 5 &&
    shiftedDays.every((day, index) => {
      return day === index + 1;
    })
  ) {
    return i18n.t(
      ($) => {
        return $.workflows.automations.schedule.everyWeekdayAt;
      },
      { time },
    );
  }
  if (dayOfWeek !== "*") {
    const days = shiftedDays?.map(weekdayName).join(", ") ?? "";
    return days
      ? i18n.t(
          ($) => {
            return $.workflows.automations.schedule.everyWeekOn;
          },
          { days, time },
        )
      : i18n.t(
          ($) => {
            return $.workflows.automations.schedule.everyWeekAt;
          },
          { time },
        );
  }
  return i18n.t(
    ($) => {
      return $.workflows.automations.schedule.everyDayAt;
    },
    { time },
  );
}

function quote(value: string): string {
  return `"${value}"`;
}

function notionReadableAutomationRuleLabel(
  automation: WorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  if (automation.eventType === "notion-child-page-created") {
    const title = automation.eventConfig.parentPage.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.childPageRule;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.childPageRuleGeneric;
        });
  }
  if (automation.eventType === "notion-database-item-created") {
    const title = automation.eventConfig.dataSource.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.databaseItemRule;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.databaseItemRuleGeneric;
        });
  }
  if (automation.eventType !== "notion-page-content-updated") {
    return null;
  }
  if (automation.eventConfig.scope.type === "page") {
    const title = automation.eventConfig.scope.page.title;
    return title
      ? i18n.t(
          ($) => {
            return $.workflows.automations.notion.pageUpdatedRule;
          },
          { title: quote(title) },
        )
      : i18n.t(($) => {
          return $.workflows.automations.notion.pageUpdatedRuleGeneric;
        });
  }
  const title = automation.eventConfig.scope.dataSource.title;
  return title
    ? i18n.t(
        ($) => {
          return $.workflows.automations.notion.databaseUpdatedRule;
        },
        { title: quote(title) },
      )
    : i18n.t(($) => {
        return $.workflows.automations.notion.databaseUpdatedRuleGeneric;
      });
}

function githubAutomationRuleLabel(
  automation: Extract<WorkflowAutomationSummary, { readonly kind: "event" }>,
): string | null {
  if (automation.eventType === "github-pull-request") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.github.pullRequestRule;
      },
      {
        action: automation.eventConfig.action,
        repository: automation.eventConfig.repository,
      },
    );
  }
  if (automation.eventType === "github-workflow-run-completed") {
    const workflows = automation.eventConfig.filters.workflows;
    const conclusions = automation.eventConfig.filters.conclusions;
    const conclusionText = conclusions
      ? i18n.t(
          ($) => {
            return $.workflows.automations.github.withConclusions;
          },
          {
            values: conclusions
              .map(githubAutomationFilterValueLabel)
              .join(", "),
          },
        )
      : "";
    return i18n.t(
      ($) => {
        return $.workflows.automations.github.workflowRunRule;
      },
      {
        workflows:
          workflows?.join(", ") ??
          i18n.t(($) => {
            return $.workflows.automations.github.aWorkflow;
          }),
        conclusions: conclusionText,
      },
    );
  }
  if (automation.eventType === "github-workflow-job-completed") {
    const jobs = automation.eventConfig.filters.jobs;
    return i18n.t(
      ($) => {
        return $.workflows.automations.github.workflowJobRule;
      },
      {
        jobs:
          jobs?.join(", ") ??
          i18n.t(($) => {
            return $.workflows.automations.github.aJob;
          }),
      },
    );
  }
  if (automation.eventType === "github-pull-request-review-submitted") {
    return i18n.t(($) => {
      return $.workflows.automations.github.reviewRule;
    });
  }
  if (automation.eventType === "github-deployment-status-created") {
    return i18n.t(($) => {
      return $.workflows.automations.github.deploymentStatusRule;
    });
  }
  if (automation.eventType === "github-issue-comment-created") {
    return i18n.t(($) => {
      return $.workflows.automations.github.issueCommentRule;
    });
  }
  return null;
}

function googleAutomationRuleLabel(
  automation: WorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "google-calendar-event-created": {
      return i18n.t(
        ($) => {
          return $.workflows.automations.calendar.createdRule;
        },
        { calendar: quote(automation.eventConfig.calendarId) },
      );
    }
    case "google-calendar-event-updated": {
      return i18n.t(
        ($) => {
          return $.workflows.automations.calendar.updatedRule;
        },
        { calendar: quote(automation.eventConfig.calendarId) },
      );
    }
    case "google-calendar-event-cancelled": {
      return i18n.t(
        ($) => {
          return $.workflows.automations.calendar.cancelledRule;
        },
        { calendar: quote(automation.eventConfig.calendarId) },
      );
    }
    case "google-forms-response-submitted": {
      return i18n.t(
        ($) => {
          return $.workflows.automations.forms.rule;
        },
        { form: quote(automation.eventConfig.form.title) },
      );
    }
    case "google-meet-transcript-generated": {
      return i18n.t(($) => {
        return $.workflows.automations.meet.rule;
      });
    }
    default: {
      return null;
    }
  }
}

export function humanReadableAutomationRuleLabel(
  automation: WorkflowAutomationSummary,
  displayTimezone: string,
): string {
  if (
    automation.kind === "event" &&
    automation.eventType === "webhook-received" &&
    automation.disabledReason === "paid_plan_required"
  ) {
    return i18n.t(($) => {
      return $.workflows.automations.common.disabledPaidPlan;
    });
  }
  if (automation.kind === "schedule") {
    const schedule = automation.schedule;
    if (schedule.type === "loop") {
      return i18n.t(
        ($) => {
          return $.workflows.automations.schedule.repeatEvery;
        },
        {
          interval: formatWorkflowIntervalSeconds(schedule.intervalSeconds),
        },
      );
    }
    if (schedule.type === "once") {
      const { hour, minute } = atTimeInTimezone(
        schedule.atTime,
        displayTimezone,
      );
      return i18n.t(
        ($) => {
          return $.workflows.automations.schedule.onceOn;
        },
        {
          date: formatDateInTimezone(schedule.atTime, displayTimezone),
          time: formatClockTime(hour, minute),
        },
      );
    }
    return cronRuleLabel(
      schedule.cronExpression,
      schedule.timezone,
      displayTimezone,
    );
  }

  if (automation.eventType === "gmail-new-message") {
    const summary = gmailAutomationSummary(automation);
    const allInboundMessages = i18n.t(($) => {
      return $.workflows.automations.gmail.allInboundMessages;
    });
    return summary && summary !== allInboundMessages
      ? i18n.t(
          ($) => {
            return $.workflows.automations.gmail.messageMatchesRule;
          },
          { summary },
        )
      : i18n.t(($) => {
          return $.workflows.automations.gmail.anyMessageRule;
        });
  }
  if (automation.eventType === "gmail-label-applied") {
    return i18n.t(
      ($) => {
        return $.workflows.automations.gmail.labelAppliedRule;
      },
      { label: quote(automation.eventConfig.labelName) },
    );
  }
  const githubLabel = githubAutomationRuleLabel(automation);
  if (githubLabel) {
    return githubLabel;
  }
  const googleLabel = googleAutomationRuleLabel(automation);
  if (googleLabel !== null) {
    return googleLabel;
  }
  if (automation.eventType === "chat-run-finished") {
    return i18n.t(($) => {
      return $.workflows.automations.chat.runFinishedTitle;
    });
  }
  const notionLabel = notionReadableAutomationRuleLabel(automation);
  if (notionLabel) {
    return notionLabel;
  }
  if (automation.eventType === "webhook-received") {
    return i18n.t(($) => {
      return $.workflows.automations.rules.inboundWebhook;
    });
  }
  if (automation.eventType === "stripe-invoice-paid") {
    return i18n.t(($) => {
      return $.workflows.automations.stripe.rule;
    });
  }
  return gmailAutomationTitle(automation);
}

function googleAutomationTypeLabel(
  automation: WorkflowAutomationSummary,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "google-calendar-event-created":
    case "google-calendar-event-updated":
    case "google-calendar-event-cancelled": {
      return i18n.t(($) => {
        return $.workflows.automations.types.googleCalendar;
      });
    }
    case "google-forms-response-submitted": {
      return i18n.t(($) => {
        return $.workflows.automations.types.googleForms;
      });
    }
    case "google-meet-transcript-generated": {
      return i18n.t(($) => {
        return $.workflows.automations.types.googleMeet;
      });
    }
    default: {
      return null;
    }
  }
}

export function automationTypeLabel(
  automation: WorkflowAutomationSummary,
): string {
  if (automation.kind === "schedule") {
    return i18n.t(($) => {
      return $.workflows.automations.common.schedule;
    });
  }
  if (
    automation.eventType === "gmail-new-message" ||
    automation.eventType === "gmail-label-applied"
  ) {
    return i18n.t(($) => {
      return $.workflows.automations.types.gmail;
    });
  }
  if (
    automation.eventType === "github-pull-request" ||
    automation.eventType === "github-deployment-status-created" ||
    automation.eventType === "github-issue-comment-created" ||
    automation.eventType === "github-pull-request-review-submitted" ||
    automation.eventType === "github-workflow-job-completed" ||
    automation.eventType === "github-workflow-run-completed"
  ) {
    return i18n.t(($) => {
      return $.workflows.automations.types.github;
    });
  }
  const googleLabel = googleAutomationTypeLabel(automation);
  if (googleLabel !== null) {
    return googleLabel;
  }
  if (
    automation.eventType === "notion-child-page-created" ||
    automation.eventType === "notion-database-item-created" ||
    automation.eventType === "notion-page-content-updated"
  ) {
    return i18n.t(($) => {
      return $.workflows.automations.types.notion;
    });
  }
  if (automation.eventType === "webhook-received") {
    return i18n.t(($) => {
      return $.workflows.automations.types.webhook;
    });
  }
  if (automation.eventType === "stripe-invoice-paid") {
    return i18n.t(($) => {
      return $.workflows.automations.types.stripe;
    });
  }
  if (automation.eventType === "chat-run-finished") {
    return i18n.t(($) => {
      return $.workflows.automations.types.chat;
    });
  }
  return i18n.t(($) => {
    return $.workflows.automations.common.automation;
  });
}

function WorkflowAgentAvatar({
  agent,
  label,
}: {
  readonly agent: AgentResponse | undefined;
  readonly label: string;
}) {
  const className =
    "h-5 w-5 shrink-0 overflow-hidden rounded-full border border-border/60 bg-gray-50 object-cover object-top text-[9px] font-semibold text-muted-foreground";
  if (agent?.avatarUrl) {
    return (
      <AvatarFromUrl
        avatarUrl={agent.avatarUrl}
        alt={label}
        className={className}
        size={20}
      />
    );
  }
  return (
    <span className={cn("inline-flex items-center justify-center", className)}>
      {labelInitials(label)}
    </span>
  );
}

export function AutomationListIcon({
  automation,
  size = "md",
}: {
  readonly automation: WorkflowAutomationSummary;
  readonly size?: "sm" | "md";
}) {
  const Icon = (() => {
    if (automation.kind === "schedule") {
      if (automation.schedule.type === "loop") {
        return Repeat;
      }
      if (automation.schedule.type === "once") {
        return Clock;
      }
      return CalendarClock;
    }
    if (automation.eventType === "webhook-received") {
      return Link;
    }
    if (automation.eventType === "stripe-invoice-paid") {
      return BrandStripe;
    }
    if (
      automation.eventType === "github-pull-request" ||
      automation.eventType === "github-deployment-status-created" ||
      automation.eventType === "github-issue-comment-created" ||
      automation.eventType === "github-pull-request-review-submitted" ||
      automation.eventType === "github-workflow-job-completed" ||
      automation.eventType === "github-workflow-run-completed"
    ) {
      return BrandGithub;
    }
    if (automation.eventType === "google-meet-transcript-generated") {
      return Video;
    }
    if (automation.eventType === "notion-child-page-created") {
      return FilePlus;
    }
    if (automation.eventType === "notion-database-item-created") {
      return DatabasePlus;
    }
    if (automation.eventType === "notion-page-content-updated") {
      return FilePen;
    }
    if (automation.eventType === "gmail-label-applied") {
      return Tag;
    }
    if (automation.eventType === "chat-run-finished") {
      return MessageCircle;
    }
    return Mail;
  })();
  const tone =
    automation.kind === "schedule"
      ? "bg-blue-50 text-blue-600"
      : automation.eventType === "webhook-received"
        ? "bg-amber-50 text-amber-700"
        : automation.eventType === "stripe-invoice-paid"
          ? "bg-violet-50 text-violet-700"
          : "bg-emerald-50 text-emerald-700";

  const compact = size === "sm";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        compact
          ? "h-8 w-8 rounded-lg"
          : "h-14 w-14 rounded-2xl sm:h-16 sm:w-16",
        tone,
      )}
      aria-hidden="true"
    >
      <Icon size={compact ? 16 : 28} />
    </span>
  );
}

export function WorkflowAutomationEnabledSwitch({
  entry,
  size = "default",
}: {
  readonly entry: WorkflowAutomationEntry;
  readonly size?: "default" | "sm";
}) {
  const pageSignal = useGet(pageSignal$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowAutomationEnabled$,
  );
  const upgradeDialogSource = useGet(workflowWebhookUpgradeDialogSource$);
  const { t } = useTranslation();
  const busy =
    enabledLoadable.state === "loading" ||
    (upgradeDialogSource?.action === "enable" &&
      upgradeDialogSource.automationId === entry.automation.id);
  const title = workflowTitle(entry.workflow);

  return (
    <Switch
      checked={entry.automation.enabled}
      disabled={busy || !entry.workflow.canManage}
      size={size}
      aria-label={
        entry.automation.enabled
          ? t(
              ($) => {
                return $.workflows.automations.common.disable;
              },
              { title },
            )
          : t(
              ($) => {
                return $.workflows.automations.common.enable;
              },
              { title },
            )
      }
      className="data-checked:bg-primary data-unchecked:bg-muted"
      onCheckedChange={(enabled) => {
        detach(
          setEnabled(
            { automationId: entry.automation.id, enabled },
            pageSignal,
          ),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function WorkflowSelectionStep({
  workflows,
  agents,
  loading,
  onSelectWorkflow,
  onCreateWorkflow,
}: {
  readonly workflows: readonly WorkflowSummary[];
  readonly agents: readonly AgentResponse[];
  readonly loading: boolean;
  readonly onSelectWorkflow: (workflow: WorkflowSummary) => void;
  readonly onCreateWorkflow: () => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="grid gap-2 px-5 pb-4">
        {["a", "b", "c"].map((key) => {
          return (
            <div
              key={key}
              className="rounded-lg border border-border/60 px-3 py-3"
            >
              <Skeleton className="h-4 w-44 rounded-md" />
              <Skeleton className="mt-2 h-3 w-64 rounded-md" />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
      <button
        type="button"
        className="mb-3 flex w-full min-w-0 items-start gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-state-hover"
        onClick={onCreateWorkflow}
      >
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
          <MessageCircle size={16} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {t(($) => {
              return $.workflows.createDialog.createInChat;
            })}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {t(($) => {
              return $.workflows.createDialog.createInChatDescription;
            })}
          </span>
        </span>
      </button>

      {workflows.length > 0 ? (
        <div className="grid gap-2">
          {workflows.map((workflow) => {
            const label = agentLabel(workflow);
            const agent = agents.find((item) => {
              return item.agentId === workflow.agentId;
            });
            return (
              <button
                key={workflow.id}
                type="button"
                className="flex min-w-0 items-start gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-state-hover"
                onClick={() => {
                  onSelectWorkflow(workflow);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {workflowTitle(workflow)}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                    <WorkflowAgentAvatar agent={agent} label={label} />
                    <span className="max-w-[10rem] shrink-0 truncate">
                      {label}
                    </span>
                    {workflow.description ? (
                      <>
                        <span className="select-none text-muted-foreground/50">
                          ·
                        </span>
                        <span className="min-w-0 truncate">
                          {workflow.description}
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.workflows.createDialog.noWorkflows;
          })}
        </p>
      )}
    </div>
  );
}

function AgentSelectionStep({
  agents,
  onSelectAgent,
}: {
  readonly agents: readonly AgentResponse[];
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const query = useGet(workflowAutomationAgentQuery$);
  const setQuery = useSet(setWorkflowAutomationAgentQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinnedIdSet = new Set(pinnedIds);
  const pinned = agents.filter((agent) => {
    return pinnedIdSet.has(agent.agentId);
  });
  const unpinned = agents.filter((agent) => {
    return !pinnedIdSet.has(agent.agentId);
  });
  const trimmedQuery = query.trim().toLowerCase();
  const filteredPinned = trimmedQuery
    ? pinned.filter((agent) => {
        return agentDialogMatchesQuery(agent, trimmedQuery);
      })
    : pinned;
  const filteredUnpinned = trimmedQuery
    ? unpinned.filter((agent) => {
        return agentDialogMatchesQuery(agent, trimmedQuery);
      })
    : unpinned;

  if (agents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentDialogSearch query={query} setQuery={setQuery} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {t(($) => {
              return $.workflows.createDialog.noAgents;
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentDialogSearch query={query} setQuery={setQuery} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {filteredPinned.length > 0 ? (
          <AgentDialogSection
            label={t(($) => {
              return $.workflows.common.pinned;
            })}
          >
            {filteredPinned.map((agent) => {
              return (
                <div
                  key={agent.agentId}
                  className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-state-hover"
                >
                  <AgentDialogAgentButton
                    agent={agent}
                    onSelect={() => {
                      onSelectAgent(agent.agentId);
                    }}
                  />
                </div>
              );
            })}
          </AgentDialogSection>
        ) : null}

        {filteredUnpinned.length > 0 ? (
          <AgentDialogSection
            label={
              filteredPinned.length > 0
                ? t(($) => {
                    return $.workflows.common.others;
                  })
                : t(($) => {
                    return $.workflows.common.agents;
                  })
            }
            className="pb-3"
          >
            {filteredUnpinned.map((agent) => {
              return (
                <div
                  key={agent.agentId}
                  className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-state-hover"
                >
                  <AgentDialogAgentButton
                    agent={agent}
                    onSelect={() => {
                      onSelectAgent(agent.agentId);
                    }}
                  />
                </div>
              );
            })}
          </AgentDialogSection>
        ) : null}

        {trimmedQuery &&
        filteredPinned.length === 0 &&
        filteredUnpinned.length === 0 ? (
          <div className="px-5 pb-5">
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {t(($) => {
                return $.workflows.createDialog.noAgentsFound;
              })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowAutomationDialogFooter({
  onCancel,
}: {
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter className="shrink-0 border-t border-border/60 bg-card px-5 py-4">
      <Button type="button" variant="outline" onClick={onCancel}>
        {t(($) => {
          return $.workflows.common.cancel;
        })}
      </Button>
    </DialogFooter>
  );
}

export function CreateWorkflowAutomationDialog() {
  const { t } = useTranslation();
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : [];
  const workflowsLoading = workflowsLoadable.state === "loading";
  const open = useGet(workflowAutomationDialogOpen$);
  const setOpen = useSet(setWorkflowAutomationDialogOpen$);
  const intent = useGet(workflowAutomationDialogIntent$);
  const agentSelectionLocked = useGet(workflowAutomationAgentSelectionLocked$);
  const selectedAgentIdState = useGet(selectedWorkflowAutomationAgentId$);
  const startCreateWorkflow = useSet(startCreateWorkflowFromAutomationDialog$);
  const navigate = useSet(detachedNavigateTo$);
  const selectedAgentId = selectedAgentIdState;
  const selectedAgent =
    agents.find((agent) => {
      return agent.agentId === selectedAgentId;
    }) ?? null;

  const startChatCreation = (agentId: string, prompt: string) => {
    setOpen(false);
    navigate(ROUTES.agentChat, {
      pathParams: { agentId },
      searchParams: new URLSearchParams({ prompt }),
    });
  };

  const selectAgent = (agentId: string) => {
    startChatCreation(
      agentId,
      intent === "automation-chat"
        ? CREATE_AUTOMATION_CHAT_PROMPT
        : CREATE_WORKFLOW_WITH_CHAT_PROMPT,
    );
  };

  const openWorkflowAutomations = (workflow: WorkflowSummary) => {
    setOpen(false);
    navigate(ROUTES.workflowDetailAutomations, {
      pathParams: { workflowId: workflow.id },
    });
  };

  const creatingAutomationInChat = intent === "automation-chat";
  const creatingWorkflow = intent === "workflow";
  const selectingExistingWorkflow = intent === "automation";
  const agentChoices =
    agentSelectionLocked && selectedAgent ? [selectedAgent] : agents;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        smMaxWidth="xl"
        contentClassName="flex flex-col overflow-hidden gap-0 p-0"
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <DialogTitle className="text-base font-semibold">
            {creatingAutomationInChat
              ? t(($) => {
                  return $.workflows.createDialog.createAutomation;
                })
              : creatingWorkflow
                ? t(($) => {
                    return $.workflows.createDialog.createWorkflow;
                  })
                : t(($) => {
                    return $.workflows.createDialog.addAutomation;
                  })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            {selectingExistingWorkflow
              ? t(($) => {
                  return $.workflows.createDialog.chooseWorkflow;
                })
              : creatingAutomationInChat
                ? t(($) => {
                    return $.workflows.createDialog.chooseAgentAutomation;
                  })
                : t(($) => {
                    return $.workflows.createDialog.chooseAgentWorkflow;
                  })}
          </DialogDescription>
        </DialogHeader>

        {selectingExistingWorkflow ? (
          <WorkflowSelectionStep
            workflows={workflows}
            agents={agents}
            loading={workflowsLoading}
            onSelectWorkflow={openWorkflowAutomations}
            onCreateWorkflow={startCreateWorkflow}
          />
        ) : (
          <AgentSelectionStep
            agents={agentChoices}
            onSelectAgent={selectAgent}
          />
        )}

        <WorkflowAutomationDialogFooter
          onCancel={() => {
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
