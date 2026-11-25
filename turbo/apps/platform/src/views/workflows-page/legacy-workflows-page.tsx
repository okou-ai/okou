import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { ArrowUpDown, ChevronDown, Download } from "lucide-react";
import {
  surfaceVariants,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import { nowDate } from "../../lib/time.ts";
import { brandName$ } from "../../signals/branding.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  allWorkflowAutomationEntries$,
  legacySetWorkflowFilter$ as setWorkflowFilter$,
  legacySetWorkflowSortMode$ as setWorkflowSortMode$,
  legacyWorkflowFilter$ as workflowFilter$,
  legacyWorkflowSortMode$ as workflowSortMode$,
  type LegacyWorkflowFilter as WorkflowFilter,
  type WorkflowSortMode,
  type WorkflowAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import { userPreferences$ } from "../../signals/okou-page/settings/user-preferences.ts";
import { Link } from "../router/link.tsx";
import { emptyWorkflowImg } from "../okou-page/platform-assets.ts";
import { CreateWorkflowAutomationDialog } from "../okou-page/workflow-automations-page.tsx";
import { workflowTitle } from "./workflow-shared.tsx";
import { WorkflowWebhookUpgradeDialog } from "./workflow-webhook-upgrade-dialog.tsx";
import {
  type WorkflowAutomationEntryMap,
  workflowAutomationEntryMap,
  WorkflowTooltip,
  VisibilityIcon,
  ConnectorCell,
  WorkflowRowIcon,
  hasAutomations,
  useImportSkills,
  WorkflowsHeaderActions,
} from "./workflow-list-shared.tsx";

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
      <WorkflowTooltip workflow={workflow}>
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
            {workflow.shadowedBy ? (
              <Badge className="shrink-0 text-xs text-muted-foreground">
                {i18n.t(($) => {
                  return $.workflows.workspace.overridden;
                })}
              </Badge>
            ) : null}
            {!workflow.shadowedBy ? (
              <span className="truncate text-xs text-muted-foreground">
                {i18n.t(
                  ($) => {
                    return $.workflows.workspace.usedFor;
                  },
                  { name: workflow.name },
                )}
              </span>
            ) : null}
            {workflow.importSource ? (
              <Badge className="shrink-0 text-xs font-medium text-muted-foreground">
                {workflow.importSource === "codex"
                  ? i18n.t(($) => {
                      return $.workflows.skillImport.source.codex;
                    })
                  : i18n.t(($) => {
                      return $.workflows.skillImport.source.claudeCode;
                    })}
              </Badge>
            ) : null}
          </span>
        </Link>
      </WorkflowTooltip>
      <ConnectorCell entries={entries} displayTimezone={displayTimezone} />
      <VisibilityIcon workflow={workflow} />
    </article>
  );
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
  emptyAction,
  sortMode = "next-run",
  automationEntriesByWorkflowId,
  displayTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly workflows: readonly WorkflowSummary[] | null;
  readonly loading: boolean;
  readonly emptyDescription: string;
  /** Offered under the description when the list is empty. */
  readonly emptyAction?: ReactNode;
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
            className="h-24 w-36 object-contain"
          />
          <p className="mt-3 text-sm font-medium text-foreground">
            {i18n.t(($) => {
              return $.workflows.list.noWorkflows;
            })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {emptyDescription}
          </p>
          {emptyAction}
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
            aria-pressed={active}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
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
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="h-9 shrink-0 gap-1.5 rounded-lg"
          />
        }
      >
        <ArrowUpDown size={15} className="" />
        {current?.label ??
          i18n.t(($) => {
            return $.workflows.list.sort.label;
          })}
        <ChevronDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => {
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => {
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
}: {
  readonly filter: WorkflowFilter;
  readonly sortMode: WorkflowSortMode;
}) {
  const { t } = useTranslation();
  const setFilter = useSet(setWorkflowFilter$);
  const setSortMode = useSet(setWorkflowSortMode$);

  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.workflows.common.workflows;
      })}
      className="flex flex-wrap items-center gap-1.5"
    >
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
        <SortDropdown value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
}

export function LegacyWorkflowsPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const filter = useGet(workflowFilter$);
  const sortMode = useGet(workflowSortMode$);

  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const automationEntriesLoadable = useLastLoadable(
    allWorkflowAutomationEntries$,
  );
  const preferences = useLastResolved(userPreferences$);
  const importSkills = useImportSkills();
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
  const filteredWorkflows = workflows
    ? sortWorkflows(
        applyWorkflowFilters(workflows, automationEntriesByWorkflowId, filter),
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
          <div className="hidden min-w-0 md:block md:flex-1">
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
          <WorkflowsHeaderActions onImportSkills={importSkills} />
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-safe-or-8 pt-3 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <WorkflowFilterBar filter={filter} sortMode={sortMode} />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            sortMode={sortMode}
            emptyDescription={emptyDescriptionForFilter(filter)}
            emptyAction={
              filter === "all" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4 gap-2"
                  onClick={importSkills}
                >
                  <Download size={14} />
                  {t(($) => {
                    return $.workflows.skillImport.emptyAction;
                  })}
                </Button>
              ) : undefined
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
