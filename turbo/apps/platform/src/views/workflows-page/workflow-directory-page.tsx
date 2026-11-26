import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { ArrowUpDown, Check, Download, Filter, Search } from "lucide-react";
import {
  surfaceVariants,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import { brandName$ } from "../../signals/branding.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  allWorkflowAutomationEntries$,
  setWorkflowFilter$,
  setWorkflowAutomationFilter$,
  clearWorkflowFilters$,
  workflowAutomationFilter$,
  setWorkflowSortMode$,
  setWorkflowSearchQuery$,
  workflowFilter$,
  workflowSortMode$,
  workflowSearchQuery$,
  type WorkflowFilter,
  type WorkflowAutomationFilter,
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
    <article className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3 py-3 text-left text-foreground transition-colors hover:bg-state-hover sm:flex-nowrap">
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
          className="flex min-w-0 flex-1 basis-full items-center gap-3 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:basis-auto"
        >
          <WorkflowRowIcon entries={entries} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {title}
              </span>
              {workflow.shadowedBy ? (
                <Badge className="shrink-0 text-xs text-muted-foreground">
                  {i18n.t(($) => {
                    return $.workflows.workspace.overridden;
                  })}
                </Badge>
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
          </span>
        </Link>
      </WorkflowTooltip>
      <div className="ml-11 flex min-w-0 items-center gap-3 sm:ml-auto sm:max-w-[45%] sm:shrink-0">
        <ConnectorCell
          entries={entries}
          displayTimezone={displayTimezone}
          redesigned
        />
        <VisibilityIcon workflow={workflow} />
      </div>
    </article>
  );
}

function applyWorkflowFilters(
  workflows: readonly WorkflowSummary[],
  entriesByWorkflowId: WorkflowAutomationEntryMap,
  filter: WorkflowFilter,
  automationFilter: WorkflowAutomationFilter,
  searchQuery: string,
): readonly WorkflowSummary[] {
  const query = searchQuery.trim().toLocaleLowerCase(i18n.resolvedLanguage);
  return workflows.filter((workflow) => {
    if (
      query &&
      ![
        workflowTitle(workflow),
        workflow.name,
        `/${workflow.name}`,
        workflow.description,
      ].some((value) => {
        return value?.toLocaleLowerCase(i18n.resolvedLanguage).includes(query);
      })
    ) {
      return false;
    }
    const automated = hasAutomations(workflow.id, entriesByWorkflowId);
    if (automationFilter === "automated" && !automated) {
      return false;
    }
    if (automationFilter === "without" && automated) {
      return false;
    }
    switch (filter) {
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

function WorkflowRowDivider() {
  return <div className="mx-3 h-px bg-divider/50" />;
}

function WorkflowRowList({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly WorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowAutomationEntryMap;
  readonly displayTimezone: string;
}) {
  return (
    <div className={surfaceVariants({ className: "overflow-hidden p-2" })}>
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
    </div>
  );
}

function WorkflowListPanel({
  workflows,
  loading,
  emptyDescription,
  emptyTitle,
  emptyAction,
  automationEntriesByWorkflowId,
  displayTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly workflows: readonly WorkflowSummary[] | null;
  readonly loading: boolean;
  readonly emptyDescription: string;
  readonly emptyTitle: string;
  /** Offered under the description when the list is empty. */
  readonly emptyAction?: ReactNode;
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
        <WorkflowRowList
          workflows={workflows}
          entriesByWorkflowId={entriesByWorkflowId}
          displayTimezone={displayTimezone}
        />
      ) : (
        <div
          className={surfaceVariants({
            className:
              "flex min-h-[20rem] flex-col items-center justify-center px-6 text-center",
          })}
        >
          <img
            src={emptyWorkflowImg}
            alt=""
            className="h-24 w-36 object-contain"
          />
          <p className="mt-3 text-sm font-medium text-foreground">
            {emptyTitle}
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

/**
 * Toolbar menu triggers share the search field's frame: `neutral` already
 * draws `Input`'s height, radius and hairline, and `bg-input` takes its fill in
 * every theme, so the toolbar reads as one row of controls and stays lighter
 * than the header's page actions. The fill is opaque, so the open state is an
 * overlay like `neutral`'s hover and press.
 *
 * Below a 520px toolbar the labels drop out and each trigger becomes a 36px
 * square beside the search field (`min-w-9` with `px-2`); the active filter
 * count stays visible.
 */
const TOOLBAR_TRIGGER_CLASS =
  "min-w-9 shrink-0 gap-1.5 bg-input px-2 aria-expanded:bg-state-hover-overlay @[520px]:px-3";
const TOOLBAR_LABEL_CLASS = "hidden @[520px]:inline";

function MenuRadioSection<T extends string>({
  label,
  value,
  options,
  onChange,
  closeOnClick,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly closeOnClick: boolean;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={onChange}
      aria-label={label}
    >
      <div
        aria-hidden
        className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground/80"
      >
        {label}
      </div>
      {options.map((option) => {
        return (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            closeOnClick={closeOnClick}
            className="justify-between gap-4"
          >
            {option.label}
            <DropdownMenuRadioItemIndicator>
              <Check size={16} aria-hidden />
            </DropdownMenuRadioItemIndicator>
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

function FilterDropdown() {
  const { t } = useTranslation();
  const filter = useGet(workflowFilter$);
  const automationFilter = useGet(workflowAutomationFilter$);
  const setFilter = useSet(setWorkflowFilter$);
  const setAutomationFilter = useSet(setWorkflowAutomationFilter$);
  const clearFilters = useSet(clearWorkflowFilters$);
  const count = Number(filter !== "all") + Number(automationFilter !== "all");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="neutral"
            className={TOOLBAR_TRIGGER_CLASS}
            aria-label={t(($) => {
              return $.workflows.list.filter;
            })}
          />
        }
      >
        <Filter size={16} aria-hidden />
        <span className={TOOLBAR_LABEL_CLASS}>
          {t(($) => {
            return $.workflows.list.filters;
          })}
        </span>
        {count > 0 ? (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-nested-fill px-1 text-xs font-medium tabular-nums">
            {count}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuRadioSection
          label={t(($) => {
            return $.workflows.list.visibility;
          })}
          value={filter}
          onChange={setFilter}
          closeOnClick={false}
          options={[
            {
              value: "all",
              label: t(($) => {
                return $.workflows.list.all;
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
                return $.workflows.list.workspaceShared;
              }),
            },
          ]}
        />
        <DropdownMenuSeparator />
        <MenuRadioSection
          label={t(($) => {
            return $.workflows.list.automations;
          })}
          value={automationFilter}
          onChange={setAutomationFilter}
          closeOnClick={false}
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
                return $.workflows.list.withAutomations;
              }),
            },
            {
              value: "without",
              label: t(($) => {
                return $.workflows.list.withoutAutomations;
              }),
            },
          ]}
        />
        <DropdownMenuSeparator />
        {/* Always present so the menu keeps its height while choices stay open. */}
        <DropdownMenuItem
          disabled={count === 0}
          onClick={clearFilters}
          className="text-muted-foreground"
        >
          {t(($) => {
            return $.workflows.list.clearFilters;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sortOptions(): readonly {
  readonly value: WorkflowSortMode;
  readonly label: string;
}[] {
  return [
    {
      value: "created",
      label: i18n.t(($) => {
        return $.workflows.list.sort.created;
      }),
    },
    {
      value: "alphabetical",
      label: i18n.t(($) => {
        return $.workflows.list.sort.alphabetical;
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
            className={TOOLBAR_TRIGGER_CLASS}
            aria-label={i18n.t(($) => {
              return $.workflows.list.sort.label;
            })}
          />
        }
      >
        <ArrowUpDown size={16} aria-hidden />
        <span className={TOOLBAR_LABEL_CLASS}>
          {current?.label ??
            i18n.t(($) => {
              return $.workflows.list.sort.label;
            })}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <MenuRadioSection
          label={i18n.t(($) => {
            return $.workflows.list.sort.heading;
          })}
          value={value}
          onChange={onChange}
          closeOnClick
          options={options}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function nextWorkflowRun(entries: readonly WorkflowAutomationEntry[]): number {
  return entries.reduce((next, { automation }) => {
    if (
      automation.kind !== "schedule" ||
      !automation.enabled ||
      !automation.nextRunAt
    ) {
      return next;
    }
    return Math.min(next, Date.parse(automation.nextRunAt));
  }, Number.POSITIVE_INFINITY);
}

function sortWorkflows(
  workflows: readonly WorkflowSummary[],
  sortMode: WorkflowSortMode,
  entriesByWorkflowId: WorkflowAutomationEntryMap,
): readonly WorkflowSummary[] {
  return [...workflows].sort((a, b) => {
    const alphabetical = workflowTitle(a).localeCompare(
      workflowTitle(b),
      i18n.resolvedLanguage,
    );
    if (sortMode === "created") {
      return Date.parse(b.createdAt) - Date.parse(a.createdAt) || alphabetical;
    }
    if (sortMode === "next-run") {
      const aNext = nextWorkflowRun(entriesByWorkflowId.get(a.id) ?? []);
      const bNext = nextWorkflowRun(entriesByWorkflowId.get(b.id) ?? []);
      return aNext === bNext ? alphabetical : aNext < bNext ? -1 : 1;
    }
    return alphabetical;
  });
}

function WorkflowFilterBar({
  sortMode,
}: {
  readonly sortMode: WorkflowSortMode;
}) {
  const { t } = useTranslation();
  const setSortMode = useSet(setWorkflowSortMode$);
  const searchQuery = useGet(workflowSearchQuery$);
  const setSearchQuery = useSet(setWorkflowSearchQuery$);
  const searchLabel = t(($) => {
    return $.workflows.list.search;
  });

  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.workflows.common.workflows;
      })}
      className="@container flex items-center gap-2"
    >
      <div className="relative min-w-0 flex-1 @[520px]:max-w-sm">
        <Search
          size={15}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={searchQuery}
          onChange={(event) => {
            setSearchQuery(event.target.value);
          }}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="pl-9"
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <FilterDropdown />
        <SortDropdown value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
}

function WorkflowEmptyAction({
  onImportSkills,
}: {
  readonly onImportSkills: () => void;
}) {
  const { t } = useTranslation();
  const searching = useGet(workflowSearchQuery$).trim().length > 0;
  const filter = useGet(workflowFilter$);
  const automationFilter = useGet(workflowAutomationFilter$);
  const filtered = filter !== "all" || automationFilter !== "all";
  const setSearchQuery = useSet(setWorkflowSearchQuery$);
  const clearFilters = useSet(clearWorkflowFilters$);
  return searching || filtered ? (
    <Button
      type="button"
      variant="neutral"
      size="sm"
      className="mt-4"
      onClick={() => {
        if (searching) {
          setSearchQuery("");
        } else {
          clearFilters();
        }
      }}
    >
      {t(($) => {
        return searching
          ? $.workflows.list.clearSearch
          : $.workflows.list.clearFilters;
      })}
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-4 gap-2"
      onClick={onImportSkills}
    >
      <Download size={14} />
      {t(($) => {
        return $.workflows.skillImport.emptyAction;
      })}
    </Button>
  );
}

export function WorkflowDirectoryPage() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const filter = useGet(workflowFilter$);
  const automationFilter = useGet(workflowAutomationFilter$);
  const filtered = filter !== "all" || automationFilter !== "all";
  const sortMode = useGet(workflowSortMode$);
  const searchQuery = useGet(workflowSearchQuery$);
  const searching = searchQuery.trim().length > 0;

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
        applyWorkflowFilters(
          workflows,
          automationEntriesByWorkflowId,
          filter,
          automationFilter,
          searchQuery,
        ),
        sortMode,
        automationEntriesByWorkflowId,
      )
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>{`${t(($) => {
        return $.workflows.common.workflows;
      })} | ${brandName}`}</title>
      <main className="flex-1 overflow-auto px-4 pb-safe-or-8 pt-3 [scrollbar-gutter:stable] sm:px-6 md:pt-10">
        <div className="mx-auto flex max-w-[900px] flex-col gap-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            {/* Title and description share a column so the description wraps
                before it reaches the actions; the column wraps above the
                actions when there is no room for both. */}
            <div className="hidden min-w-0 flex-[1_1_16rem] flex-col gap-2 md:flex">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                {t(($) => {
                  return $.workflows.list.title;
                })}
              </h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(($) => {
                  return $.workflows.list.description;
                })}
              </p>
            </div>
            {/* h-9 actions sit 4px above the 28px title line so both share a
                vertical center. */}
            <div className="max-w-full md:-mt-1">
              <WorkflowsHeaderActions
                onImportSkills={importSkills}
                redesigned
              />
            </div>
          </header>
          <WorkflowFilterBar sortMode={sortMode} />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            emptyTitle={t(($) => {
              return searching || filtered
                ? $.workflows.list.noResults
                : $.workflows.list.noWorkflows;
            })}
            emptyDescription={
              searching || filtered
                ? t(($) => {
                    return $.workflows.list.empty.search;
                  })
                : t(($) => {
                    return $.workflows.list.empty.all;
                  })
            }
            emptyAction={<WorkflowEmptyAction onImportSkills={importSkills} />}
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
      className={surfaceVariants({ className: "overflow-hidden p-2" })}
      data-testid="workflows-loading"
    >
      {[0, 1, 2, 3].map((rowIndex) => {
        return (
          <div key={rowIndex}>
            {rowIndex > 0 ? <WorkflowRowDivider /> : null}
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="h-4 w-40 max-w-full rounded bg-muted/50" />
                <div className="h-3 w-56 max-w-full rounded bg-muted/40" />
              </div>
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
