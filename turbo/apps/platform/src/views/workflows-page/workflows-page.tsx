// Workflow list surfaces for agent-scoped tabs and the workspace index page.
import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  ArrowUpDown,
  AlertTriangle,
  BadgeCheck,
  ChevronDown,
  Lock,
  Plus,
  Route,
  User,
  Globe,
} from "lucide-react";
import {
  surfaceVariants,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import { nowDate } from "../../lib/time.ts";
import { openCreateWorkflowDialog$ } from "../../signals/automation-page/workflow-automation-dialog.ts";
import { brandName$ } from "../../signals/branding.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  allWorkflowAutomationEntries$,
  isGoogleCalendarWorkflowAutomation,
  setWorkflowAgentFilter$,
  setWorkflowFilter$,
  setWorkflowSortMode$,
  workflowAgentFilter$,
  workflowFilter$,
  workflowSortMode$,
  WORKFLOW_ALL_AGENTS,
  type WorkflowFilter,
  type WorkflowSortMode,
  type WorkflowAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { AgentAvatarImg } from "../okou-page/sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { emptyWorkflowImg } from "../okou-page/platform-assets.ts";
import {
  CreateWorkflowAutomationDialog,
  humanReadableAutomationRuleLabel,
  AutomationListIcon,
  automationTypeLabel,
  WorkflowAutomationEnabledSwitch,
} from "../okou-page/workflow-automations-page.tsx";
import {
  agentLabel,
  labelInitials,
  workflowTitle,
} from "./workflow-shared.tsx";
import { WorkflowWebhookUpgradeDialog } from "./workflow-webhook-upgrade-dialog.tsx";

type WorkflowAutomationEntryMap = ReadonlyMap<
  string,
  readonly WorkflowAutomationEntry[]
>;

function workflowAutomationEntryMap(
  entries: readonly WorkflowAutomationEntry[],
): WorkflowAutomationEntryMap {
  const grouped = new Map<string, WorkflowAutomationEntry[]>();
  for (const entry of entries) {
    const workflowEntries = grouped.get(entry.workflow.id) ?? [];
    workflowEntries.push(entry);
    grouped.set(entry.workflow.id, workflowEntries);
  }
  return grouped;
}

function ownerLabel(workflow: WorkflowSummary): string {
  return workflow.ownerUserDisplayName?.trim() || workflow.ownerUserId;
}

function automationDotClass(entry: WorkflowAutomationEntry): string {
  const automation = entry.automation;
  if (
    isGoogleCalendarWorkflowAutomation(automation) &&
    automation.warning !== undefined
  ) {
    return "bg-amber-500";
  }
  if (automation.kind === "schedule") {
    return "bg-blue-500";
  }
  return automation.eventType === "webhook-received"
    ? "bg-amber-500"
    : "bg-emerald-500";
}

function isActionRequiredEntry(entry: WorkflowAutomationEntry): boolean {
  return (
    isGoogleCalendarWorkflowAutomation(entry.automation) &&
    entry.automation.warning !== undefined
  );
}

function connectorNames(entries: readonly WorkflowAutomationEntry[]): string {
  return entries
    .slice(0, 2)
    .map((entry) => {
      return automationTypeLabel(entry.automation);
    })
    .join(", ");
}

function connectorPillClassName({
  interactive = false,
  muted = false,
}: {
  readonly interactive?: boolean;
  readonly muted?: boolean;
}) {
  return cn(
    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-white px-2 text-[11px] font-medium leading-none shadow-[0_0_2px_rgba(0,0,0,0.06)]",
    muted ? "text-muted-foreground" : "text-foreground/70",
    interactive &&
      "cursor-pointer transition-colors hover:border-border hover:bg-state-hover hover:text-foreground",
  );
}

function ConnectorPillMarker({
  dotClassName,
}: {
  readonly dotClassName: string;
}) {
  return (
    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClassName)} />
  );
}

/** The agent that runs the workflow, drawn as its real avatar. */
function AgentAvatar({ workflow }: { readonly workflow: WorkflowSummary }) {
  const label = agentLabel(workflow);
  return (
    <AgentAvatarImg
      name={workflow.agentId}
      alt={i18n.t(
        ($) => {
          return $.workflows.list.runsAsAria;
        },
        { agent: label },
      )}
      className="h-6 w-6 shrink-0 rounded-md"
      size={24}
    />
  );
}

function MemberAvatar({ workflow }: { readonly workflow: WorkflowSummary }) {
  const label = ownerLabel(workflow);
  if (workflow.ownerUserImageUrl) {
    return (
      <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-border/60 bg-gray-50">
        <img
          src={workflow.ownerUserImageUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-gray-50 text-[10px] font-semibold text-muted-foreground">
      {labelInitials(label)}
    </span>
  );
}

function VisibilityIcon({ workflow }: { readonly workflow: WorkflowSummary }) {
  const isPublic = workflow.visibility === "public";
  const Icon = isPublic ? Globe : Lock;
  const label = isPublic
    ? i18n.t(($) => {
        return $.workflows.common.public;
      })
    : i18n.t(($) => {
        return $.workflows.common.private;
      });
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-label={label} className="flex shrink-0">
            <Icon
              size={15}
              className={isPublic ? "text-blue-500" : "text-[#45A7A8]"}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The connector pill's list of automations, shown when the pill is clicked. */
function ConnectorPopoverList({
  entries,
  displayTimezone,
}: {
  readonly entries: readonly WorkflowAutomationEntry[];
  readonly displayTimezone: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1 text-xs font-semibold text-muted-foreground">
        <span>
          {i18n.t(($) => {
            return $.workflows.list.automations;
          })}
        </span>
        <span className="font-normal text-muted-foreground/70">
          {entries.length}
        </span>
      </div>
      {entries.map((entry) => {
        const ruleLabel = humanReadableAutomationRuleLabel(
          entry.automation,
          displayTimezone,
        );
        const actionRequired = isActionRequiredEntry(entry);
        const title = workflowTitle(entry.workflow);
        return (
          <div
            key={entry.automation.id}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-state-hover"
          >
            {actionRequired ? (
              <Link
                pathname={ROUTES.workflowDetailAutomations}
                options={{
                  pathParams: { workflowId: entry.workflow.id },
                  searchParams: new URLSearchParams({
                    automationId: entry.automation.id,
                  }),
                }}
                aria-label={i18n.t(
                  ($) => {
                    return $.workflows.list.openRecovery;
                  },
                  { title },
                )}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span
                  className={cn(
                    connectorPillClassName({}),
                    "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400",
                  )}
                >
                  <ConnectorPillMarker
                    dotClassName={automationDotClass(entry)}
                  />
                  {i18n.t(($) => {
                    return $.workflows.list.actionRequired;
                  })}
                </span>
                <span
                  title={ruleLabel}
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                >
                  {ruleLabel}
                </span>
                <AlertTriangle
                  size={13}
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                />
              </Link>
            ) : (
              <>
                <span className={connectorPillClassName({})}>
                  <ConnectorPillMarker
                    dotClassName={automationDotClass(entry)}
                  />
                  {automationTypeLabel(entry.automation)}
                </span>
                <span
                  title={ruleLabel}
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                >
                  {ruleLabel}
                </span>
              </>
            )}
            <WorkflowAutomationEnabledSwitch entry={entry} size="sm" />
          </div>
        );
      })}
    </div>
  );
}

function ConnectorCell({
  entries,
  displayTimezone,
}: {
  readonly entries: readonly WorkflowAutomationEntry[];
  readonly displayTimezone: string;
}) {
  if (entries.length === 0) {
    return (
      <span className={connectorPillClassName({ muted: true })}>
        <ConnectorPillMarker dotClassName="bg-muted-foreground/40" />
        {i18n.t(($) => {
          return $.workflows.common.manual;
        })}
      </span>
    );
  }

  const [lead] = entries;
  const actionRequiredEntry = entries.find(isActionRequiredEntry);
  const remaining = entries.length - 2;
  return (
    <Popover>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  connectorPillClassName({ interactive: true }),
                  actionRequiredEntry &&
                    "border-amber-300/80 bg-amber-50 text-amber-700 hover:border-amber-400 hover:bg-amber-100 hover:text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50",
                )}
              >
                {actionRequiredEntry ? (
                  <ConnectorPillMarker dotClassName="bg-amber-500" />
                ) : lead ? (
                  <ConnectorPillMarker
                    dotClassName={automationDotClass(lead)}
                  />
                ) : null}
                <span>
                  {actionRequiredEntry
                    ? i18n.t(($) => {
                        return $.workflows.list.actionRequired;
                      })
                    : connectorNames(entries)}
                </span>
                {!actionRequiredEntry && remaining > 0 ? (
                  <span className="text-muted-foreground">+{remaining}</span>
                ) : null}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {i18n.t(($) => {
              return $.workflows.list.viewAutomations;
            })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        className="w-max min-w-[16rem] max-w-[min(28rem,var(--available-width))] p-1"
      >
        <ConnectorPopoverList
          entries={entries}
          displayTimezone={displayTimezone}
        />
      </PopoverContent>
    </Popover>
  );
}

export function WorkflowHoverContent({
  workflow,
}: {
  readonly workflow: WorkflowSummary;
}) {
  useTranslation();
  const title = workflowTitle(workflow);
  return (
    <div className="max-w-xs">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {workflow.description ?? workflow.name}
      </p>
      <div className="mt-2.5 flex flex-col gap-3 border-t border-border/60 pt-2.5 text-xs text-foreground/80">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.list.createdBy;
            })}
          </span>
          <MemberAvatar workflow={workflow} />
          <span className="truncate">{ownerLabel(workflow)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.list.runsAs;
            })}
          </span>
          <AgentAvatar workflow={workflow} />
          <span className="truncate">{agentLabel(workflow)}</span>
        </div>
      </div>
    </div>
  );
}

function WorkflowRowIcon({
  entries,
}: {
  readonly entries: readonly WorkflowAutomationEntry[];
}) {
  const [lead] = entries;
  if (lead) {
    return <AutomationListIcon automation={lead.automation} size="sm" />;
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-muted-foreground">
      <Route size={16} />
    </span>
  );
}

function WorkflowRow({
  workflow,
  entries,
  displayTimezone,
}: {
  readonly workflow: WorkflowSummary;
  readonly entries: readonly WorkflowAutomationEntry[];
  readonly displayTimezone: string;
}) {
  const title = workflowTitle(workflow);
  return (
    <article className="flex items-center gap-3 px-5 py-3.5 text-left text-foreground transition-colors hover:bg-state-hover">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              pathname={ROUTES.workflowDetailAutomations}
              options={{ pathParams: { workflowId: workflow.id } }}
              aria-label={i18n.t(
                ($) => {
                  return $.workflows.list.open;
                },
                { title },
              )}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <WorkflowRowIcon entries={entries} />
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium underline decoration-dotted decoration-foreground/40 decoration-[1px] underline-offset-2">
                  {title}
                </span>
                {workflow.official ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                      workflow.official.definitionLifecycle === "retired"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-blue-50 text-blue-700",
                    )}
                  >
                    <BadgeCheck size={11} />
                    {workflow.official.definitionLifecycle === "retired"
                      ? i18n.t(($) => {
                          return $.workflows.official.retiredBadge;
                        })
                      : i18n.t(($) => {
                          return $.workflows.official.badge;
                        })}
                  </span>
                ) : null}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className="rounded-lg border border-[hsl(var(--gray-400))] p-3"
            style={{
              backgroundColor: "hsl(var(--card))",
              color: "hsl(var(--card-foreground))",
              boxShadow:
                "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
            }}
          >
            <WorkflowHoverContent workflow={workflow} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ConnectorCell entries={entries} displayTimezone={displayTimezone} />
      <VisibilityIcon workflow={workflow} />
      <AgentAvatar workflow={workflow} />
    </article>
  );
}

function hasAutomations(
  workflowId: string,
  entriesByWorkflowId: WorkflowAutomationEntryMap,
): boolean {
  return (entriesByWorkflowId.get(workflowId)?.length ?? 0) > 0;
}

function applyWorkflowFilters(
  workflows: readonly WorkflowSummary[],
  entriesByWorkflowId: WorkflowAutomationEntryMap,
  filter: WorkflowFilter,
): readonly WorkflowSummary[] {
  return workflows.filter((workflow) => {
    const automated = hasAutomations(workflow.id, entriesByWorkflowId);
    switch (filter) {
      case "automated": {
        return automated;
      }
      case "without": {
        return !automated;
      }
      case "private": {
        return workflow.visibility === "private";
      }
      case "public": {
        return workflow.visibility === "public";
      }
      default: {
        return true;
      }
    }
  });
}

interface AgentFilterOption {
  readonly agentId: string;
  readonly label: string;
}

/** The distinct agents that own at least one workflow, sorted by label. */
function agentFilterOptions(
  workflows: readonly WorkflowSummary[],
): readonly AgentFilterOption[] {
  const labelsByAgentId = new Map<string, string>();
  for (const workflow of workflows) {
    if (!labelsByAgentId.has(workflow.agentId)) {
      labelsByAgentId.set(workflow.agentId, agentLabel(workflow));
    }
  }
  return [...labelsByAgentId]
    .map(([agentId, label]) => {
      return { agentId, label };
    })
    .sort((a, b) => {
      return a.label.localeCompare(b.label, i18n.resolvedLanguage);
    });
}

function applyAgentFilter(
  workflows: readonly WorkflowSummary[],
  agentFilter: string,
): readonly WorkflowSummary[] {
  if (agentFilter === WORKFLOW_ALL_AGENTS) {
    return workflows;
  }
  return workflows.filter((workflow) => {
    return workflow.agentId === agentFilter;
  });
}

function emptyDescriptionForFilter(filter: WorkflowFilter): string {
  switch (filter) {
    case "without": {
      return i18n.t(($) => {
        return $.workflows.list.empty.without;
      });
    }
    case "automated": {
      return i18n.t(($) => {
        return $.workflows.list.empty.automated;
      });
    }
    case "private": {
      return i18n.t(($) => {
        return $.workflows.list.empty.private;
      });
    }
    case "public": {
      return i18n.t(($) => {
        return $.workflows.list.empty.public;
      });
    }
    default: {
      return i18n.t(($) => {
        return $.workflows.list.empty.all;
      });
    }
  }
}

type NextRunBucket = "today" | "week" | "later" | "event" | "manual";

function nextRunSections(): readonly {
  readonly key: NextRunBucket;
  readonly label: string;
}[] {
  return [
    {
      key: "today",
      label: i18n.t(($) => {
        return $.workflows.list.section.today;
      }),
    },
    {
      key: "week",
      label: i18n.t(($) => {
        return $.workflows.list.section.week;
      }),
    },
    {
      key: "later",
      label: i18n.t(($) => {
        return $.workflows.list.section.later;
      }),
    },
    {
      key: "event",
      label: i18n.t(($) => {
        return $.workflows.list.section.event;
      }),
    },
    {
      key: "manual",
      label: i18n.t(($) => {
        return $.workflows.list.section.manual;
      }),
    },
  ];
}

function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function workflowNextRunBucket(
  entries: readonly WorkflowAutomationEntry[],
  now: Date,
  timezone: string,
): NextRunBucket {
  if (entries.length === 0) {
    return "manual";
  }
  const upcoming = entries
    .filter((entry) => {
      return (
        entry.automation.kind === "schedule" &&
        entry.automation.enabled &&
        entry.automation.nextRunAt !== null
      );
    })
    .map((entry) => {
      return new Date(entry.automation.nextRunAt as string);
    });
  if (upcoming.length === 0) {
    return "event";
  }
  const soonest = upcoming.reduce((earliest, candidate) => {
    return candidate < earliest ? candidate : earliest;
  });
  if (dayKey(soonest, timezone) === dayKey(now, timezone)) {
    return "today";
  }
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return soonest <= weekAhead ? "week" : "later";
}

function WorkflowSectionHeader({ label }: { readonly label: string }) {
  return (
    <div className="px-5 pb-1.5 pt-4">
      <span className="text-[13px] font-medium leading-4 text-foreground/50">
        {label}
      </span>
    </div>
  );
}

function WorkflowRowDivider() {
  return <div className="mx-5 h-px bg-divider/50" />;
}

function WorkflowRowList({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
  framed = true,
}: {
  readonly workflows: readonly WorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowAutomationEntryMap;
  readonly displayTimezone: string;
  readonly framed?: boolean;
}) {
  const rows = (
    <>
      {workflows.map((workflow, index) => {
        return (
          <div key={workflow.id}>
            {index > 0 ? <WorkflowRowDivider /> : null}
            <WorkflowRow
              workflow={workflow}
              entries={entriesByWorkflowId.get(workflow.id) ?? []}
              displayTimezone={displayTimezone}
            />
          </div>
        );
      })}
    </>
  );
  if (!framed) {
    return <div>{rows}</div>;
  }
  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      {rows}
    </div>
  );
}

function WorkflowNextRunGroups({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly WorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowAutomationEntryMap;
  readonly displayTimezone: string;
}) {
  const now = nowDate();
  const buckets = new Map<NextRunBucket, WorkflowSummary[]>();
  for (const workflow of workflows) {
    const entries = entriesByWorkflowId.get(workflow.id) ?? [];
    const bucket = workflowNextRunBucket(entries, now, displayTimezone);
    const list = buckets.get(bucket) ?? [];
    list.push(workflow);
    buckets.set(bucket, list);
  }
  const visibleSections = nextRunSections().flatMap((section) => {
    const sectionWorkflows = buckets.get(section.key);
    if (!sectionWorkflows || sectionWorkflows.length === 0) {
      return [];
    }
    return [{ section, sectionWorkflows }];
  });

  return (
    <div className={surfaceVariants({ className: "overflow-hidden" })}>
      {visibleSections.map(({ section, sectionWorkflows }, index) => {
        return (
          <section key={section.key}>
            {index > 0 ? <WorkflowRowDivider /> : null}
            <WorkflowSectionHeader label={section.label} />
            <WorkflowRowList
              workflows={sectionWorkflows}
              entriesByWorkflowId={entriesByWorkflowId}
              displayTimezone={displayTimezone}
              framed={false}
            />
          </section>
        );
      })}
    </div>
  );
}

function WorkflowListPanel({
  workflows,
  loading,
  emptyDescription,
  sortMode = "next-run",
  automationEntriesByWorkflowId,
  displayTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly workflows: readonly WorkflowSummary[] | null;
  readonly loading: boolean;
  readonly emptyDescription: string;
  readonly sortMode?: WorkflowSortMode;
  readonly automationEntriesByWorkflowId?: WorkflowAutomationEntryMap;
  readonly displayTimezone?: string;
}) {
  const entriesByWorkflowId =
    automationEntriesByWorkflowId ??
    new Map<string, readonly WorkflowAutomationEntry[]>();

  return (
    <section className="min-h-[520px]">
      {loading ? (
        <WorkflowIndexSkeleton />
      ) : workflows && workflows.length > 0 ? (
        sortMode === "next-run" ? (
          <WorkflowNextRunGroups
            workflows={workflows}
            entriesByWorkflowId={entriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        ) : (
          <WorkflowRowList
            workflows={workflows}
            entriesByWorkflowId={entriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        )
      ) : (
        <div
          className={surfaceVariants({
            className:
              "flex min-h-[20rem] flex-col items-center justify-center px-6 text-center",
          })}
        >
          <img
            src={emptyWorkflowImg}
            alt={i18n.t(($) => {
              return $.workflows.list.noWorkflows;
            })}
            className="h-24 w-24 object-contain opacity-80"
          />
          <p className="mt-3 text-sm font-medium text-foreground">
            {i18n.t(($) => {
              return $.workflows.list.noWorkflows;
            })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {emptyDescription}
          </p>
        </div>
      )}
    </section>
  );
}

function FilterPills<T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: ReactNode;
  }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              active
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </>
  );
}

function sortOptions(): readonly {
  readonly value: WorkflowSortMode;
  readonly label: string;
}[] {
  return [
    {
      value: "alphabetical",
      label: i18n.t(($) => {
        return $.workflows.list.sort.alphabetical;
      }),
    },
    {
      value: "created",
      label: i18n.t(($) => {
        return $.workflows.list.sort.created;
      }),
    },
    {
      value: "next-run",
      label: i18n.t(($) => {
        return $.workflows.list.sort.nextRun;
      }),
    },
  ];
}

function SortDropdown({
  value,
  onChange,
}: {
  readonly value: WorkflowSortMode;
  readonly onChange: (value: WorkflowSortMode) => void;
}) {
  const options = sortOptions();
  const current = options.find((option) => {
    return option.value === value;
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          className="h-9 shrink-0 gap-1.5 rounded-lg"
        >
          <ArrowUpDown size={15} className="" />
          {current?.label ??
            i18n.t(($) => {
              return $.workflows.list.sort.label;
            })}
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => {
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => {
                onChange(option.value);
              }}
            >
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentFilterDropdown({
  value,
  options,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly AgentFilterOption[];
  readonly onChange: (value: string) => void;
}) {
  const selected = options.find((option) => {
    return option.agentId === value;
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          className="h-9 shrink-0 gap-1.5 rounded-lg"
        >
          {selected ? (
            <AgentAvatarImg
              name={selected.agentId}
              alt={selected.label}
              className="h-4 w-4 shrink-0 rounded"
              size={16}
            />
          ) : (
            <User size={15} className="" />
          )}
          <span className="max-w-[8rem] truncate">
            {selected?.label ??
              i18n.t(($) => {
                return $.workflows.list.allAgents;
              })}
          </span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(20rem,var(--available-height))] overflow-y-auto"
      >
        <DropdownMenuItem
          onSelect={() => {
            onChange(WORKFLOW_ALL_AGENTS);
          }}
        >
          <User size={15} className="" />
          {i18n.t(($) => {
            return $.workflows.list.allAgents;
          })}
        </DropdownMenuItem>
        {options.map((option) => {
          return (
            <DropdownMenuItem
              key={option.agentId}
              onSelect={() => {
                onChange(option.agentId);
              }}
            >
              <AgentAvatarImg
                name={option.agentId}
                alt={option.label}
                className="h-4 w-4 shrink-0 rounded"
                size={16}
              />
              <span className="min-w-0 truncate">{option.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sortWorkflows(
  workflows: readonly WorkflowSummary[],
  sortMode: WorkflowSortMode,
): readonly WorkflowSummary[] {
  if (sortMode === "created") {
    return [...workflows].sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
  if (sortMode === "alphabetical") {
    return [...workflows].sort((a, b) => {
      return workflowTitle(a).localeCompare(
        workflowTitle(b),
        i18n.resolvedLanguage,
      );
    });
  }
  return workflows;
}

function WorkflowFilterBar({
  filter,
  sortMode,
  agentFilter,
  agentOptions,
}: {
  readonly filter: WorkflowFilter;
  readonly sortMode: WorkflowSortMode;
  readonly agentFilter: string;
  readonly agentOptions: readonly AgentFilterOption[];
}) {
  const { t } = useTranslation();
  const setFilter = useSet(setWorkflowFilter$);
  const setSortMode = useSet(setWorkflowSortMode$);
  const setAgentFilter = useSet(setWorkflowAgentFilter$);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FilterPills
        value={filter}
        onChange={setFilter}
        options={[
          {
            value: "all",
            label: t(($) => {
              return $.workflows.list.all;
            }),
          },
          {
            value: "automated",
            label: t(($) => {
              return $.workflows.list.automated;
            }),
          },
          {
            value: "without",
            label: t(($) => {
              return $.workflows.common.manual;
            }),
          },
          {
            value: "private",
            label: t(($) => {
              return $.workflows.common.private;
            }),
          },
          {
            value: "public",
            label: t(($) => {
              return $.workflows.common.public;
            }),
          },
        ]}
      />
      <div className="ml-auto flex items-center gap-1.5">
        {agentOptions.length > 1 ? (
          <AgentFilterDropdown
            value={agentFilter}
            options={agentOptions}
            onChange={setAgentFilter}
          />
        ) : null}
        <SortDropdown value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const filter = useGet(workflowFilter$);
  const sortMode = useGet(workflowSortMode$);
  const agentFilter = useGet(workflowAgentFilter$);
  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const automationEntriesLoadable = useLastLoadable(
    allWorkflowAutomationEntries$,
  );
  const preferences = useLastResolved(userPreferences$);
  const openCreateWorkflowDialog = useSet(openCreateWorkflowDialog$);
  const features = useGet(featureSwitch$);
  const officialWorkflowsEnabled =
    features[FeatureSwitchKey.OfficialWorkflows] ?? false;
  const loading =
    workflowsLoadable.state === "loading" ||
    automationEntriesLoadable.state === "loading";
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : null;
  const automationEntries =
    automationEntriesLoadable.state === "hasData"
      ? automationEntriesLoadable.data
      : [];
  const automationEntriesByWorkflowId =
    workflowAutomationEntryMap(automationEntries);
  const displayTimezone =
    preferences?.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const agentOptions = workflows ? agentFilterOptions(workflows) : [];
  const filteredWorkflows = workflows
    ? sortWorkflows(
        applyAgentFilter(
          applyWorkflowFilters(
            workflows,
            automationEntriesByWorkflowId,
            filter,
          ),
          agentFilter,
        ),
        sortMode,
      )
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>{`${t(($) => {
        return $.workflows.common.workflows;
      })} | ${brandName}`}</title>
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-end justify-between gap-4">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {t(($) => {
                return $.workflows.list.title;
              })}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.workflows.list.description;
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {officialWorkflowsEnabled ? (
              <Button
                asChild
                type="button"
                variant="neutral"
                size="sm"
                className="h-9 shrink-0 gap-2 rounded-lg"
              >
                <Link pathname={ROUTES.officialWorkflows}>
                  <BadgeCheck size={14} />
                  {t(($) => {
                    return $.workflows.official.browse;
                  })}
                </Link>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="neutral"
              size="sm"
              className="h-9 shrink-0 gap-2 rounded-lg"
              onClick={() => {
                openCreateWorkflowDialog();
              }}
            >
              <Plus size={14} />
              {t(($) => {
                return $.workflows.list.createInChat;
              })}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-[max(2rem,var(--sab))] pt-3 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <WorkflowFilterBar
            filter={filter}
            sortMode={sortMode}
            agentFilter={agentFilter}
            agentOptions={agentOptions}
          />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            sortMode={sortMode}
            emptyDescription={
              agentFilter === WORKFLOW_ALL_AGENTS
                ? emptyDescriptionForFilter(filter)
                : t(($) => {
                    return $.workflows.list.agentEmpty;
                  })
            }
            automationEntriesByWorkflowId={automationEntriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        </div>
      </main>

      <CreateWorkflowAutomationDialog />
      <WorkflowWebhookUpgradeDialog />
    </div>
  );
}

function WorkflowIndexSkeleton() {
  return (
    <div
      className={surfaceVariants({ className: "overflow-hidden" })}
      data-testid="workflows-loading"
    >
      {[0, 1, 2, 3].map((rowIndex) => {
        return (
          <div key={rowIndex}>
            {rowIndex > 0 ? <WorkflowRowDivider /> : null}
            <div className="flex items-center gap-3 px-5 py-3.5">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
              <div className="h-4 w-40 rounded bg-muted/50" />
              <div className="ml-auto h-8 w-32 rounded-full bg-muted/40" />
              <div className="h-5 w-5 rounded-full bg-muted/40" />
              <div className="h-6 w-6 rounded-md bg-muted/40" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
