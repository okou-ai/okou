import type { ReactElement, ReactNode } from "react";
import { Avatar } from "@base-ui/react/avatar";
import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  WorkflowOwnerProfile,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  ArrowUpDown,
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  Filter,
  Lock,
  Plus,
  Route,
  Search,
  User,
  Globe,
} from "lucide-react";
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
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { currentOrgInfo$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  loadWorkflowOwnerProfile$,
  workflowOwnerProfileIdentity$,
} from "../../signals/workflows-page/workflow-owner-profile.ts";
import { i18n } from "../../i18n/index.ts";
import { openCreateWorkflowDialog$ } from "../../signals/automation-page/workflow-automation-dialog.ts";
import { brandName$ } from "../../signals/branding.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { openSkillImportDialog$ } from "../../signals/skill-import/skill-import-dialog.ts";
import {
  allVisibleWorkflows$,
  allWorkflowAutomationEntries$,
  isGoogleCalendarWorkflowAutomation,
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
import {
  CreateWorkflowAutomationDialog,
  humanReadableAutomationRuleLabel,
  AutomationListIcon,
  automationTypeLabel,
  WorkflowAutomationEnabledSwitch,
} from "../okou-page/workflow-automations-page.tsx";
import { labelInitials, workflowTitle } from "./workflow-shared.tsx";
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
    "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/80 bg-white px-2 text-[11px] font-medium leading-none shadow-[0_0_2px_rgba(0,0,0,0.06)]",
    muted ? "text-muted-foreground" : "text-foreground/70",
    interactive &&
      "transition-colors hover:border-border hover:bg-state-hover hover:text-foreground",
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

const MEMBER_AVATAR_FALLBACK_DELAY_MS = 600;

function MemberAvatar({
  label,
  imageUrl,
}: {
  readonly label?: string;
  readonly imageUrl?: string | null;
}) {
  return (
    <Avatar.Root className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-gray-50 text-[10px] font-semibold text-muted-foreground">
      {imageUrl && (
        <Avatar.Image
          src={imageUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
      )}

      <Avatar.Fallback
        aria-hidden="true"
        delay={imageUrl ? MEMBER_AVATAR_FALLBACK_DELAY_MS : undefined}
      >
        {label ? labelInitials(label) : <User className="size-3" />}
      </Avatar.Fallback>
    </Avatar.Root>
  );
}

function VisibilityIcon({ workflow }: { readonly workflow: WorkflowSummary }) {
  const org = useLastResolved(currentOrgInfo$);
  const isPublic = workflow.visibility === "public";
  const Icon = isPublic ? Globe : Lock;
  const label = isPublic
    ? i18n.t(
        ($) => {
          return $.workflows.workspace.sharedWith;
        },
        { workspace: org?.name ?? "" },
      )
    : i18n.t(($) => {
        return $.workflows.common.private;
      });
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span aria-label={label} className="flex shrink-0">
              <Icon
                size={15}
                className={isPublic ? "text-blue-500" : "text-[#45A7A8]"}
              />
            </span>
          }
        />
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
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
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
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
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
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
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
                    <span className="truncate">
                      {actionRequiredEntry
                        ? i18n.t(($) => {
                            return $.workflows.list.actionRequired;
                          })
                        : connectorNames(entries)}
                    </span>
                    {!actionRequiredEntry && remaining > 0 ? (
                      <span className="shrink-0 text-muted-foreground">
                        +{remaining}
                      </span>
                    ) : null}
                  </button>
                }
              />
            }
          />
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

function WorkflowHoverContent({
  workflow,
  profile,
  failed,
}: {
  readonly workflow: WorkflowSummary;
  readonly profile?: WorkflowOwnerProfile;
  readonly failed: boolean;
}) {
  useTranslation();

  const title = workflowTitle(workflow);
  const loading = !profile && !failed;
  const ownerLabel =
    profile?.displayName || profile?.imageUrl
      ? profile.displayName?.trim() || workflow.ownerUserId
      : undefined;
  const ownerStatus = failed
    ? i18n.t(($) => {
        return $.workflows.list.ownerUnavailable;
      })
    : profile
      ? i18n.t(($) => {
          return $.workflows.list.ownerUnavailable;
        })
      : i18n.t(($) => {
          return $.workflows.list.ownerLoading;
        });
  return (
    <div className="min-w-0 wrap-anywhere">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {workflow.description ?? workflow.name}
      </p>
      <div className="mt-2.5 flex flex-col gap-3 border-t border-border/60 pt-2.5 text-xs text-foreground/80">
        <div
          data-slot="workflow-owner"
          className="flex h-6 min-w-0 items-center gap-2"
        >
          <span className="w-16 shrink-0 text-muted-foreground">
            {i18n.t(($) => {
              return $.workflows.list.createdBy;
            })}
          </span>
          {loading ? (
            <Skeleton
              aria-hidden="true"
              className="size-6 shrink-0 rounded-full animate-none motion-safe:animate-pulse"
            />
          ) : (
            <MemberAvatar label={ownerLabel} imageUrl={profile?.imageUrl} />
          )}
          <div
            role="status"
            aria-busy={loading}
            className="flex h-6 min-w-0 flex-1 items-center"
          >
            {loading ? (
              <>
                <Skeleton
                  aria-hidden="true"
                  className="h-3 w-24 max-w-full animate-none motion-safe:animate-pulse"
                />
                <span className="sr-only">{ownerStatus}</span>
              </>
            ) : (
              <span
                className={cn(
                  "block min-w-0 truncate",
                  !ownerLabel && "text-muted-foreground",
                )}
              >
                {ownerLabel ?? ownerStatus}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Both title surfaces use the tooltip's actual pointer/keyboard open event. */
export function WorkflowTooltip({
  workflow,
  children,
}: {
  readonly workflow: WorkflowSummary;
  readonly children: ReactElement;
}) {
  const scope = useLoadable(workflowOwnerProfileIdentity$);
  const pageSignal = useGet(pageSignal$);
  const [result, load] = useLoadableSet(loadWorkflowOwnerProfile$);
  const profile =
    scope.state === "hasData" &&
    result.state === "hasData" &&
    result.data.scopeKey === scope.data &&
    result.data.workflowId === workflow.id
      ? result.data.profile
      : undefined;
  return (
    <TooltipProvider delay={200}>
      <Tooltip
        onOpenChange={(open) => {
          if (open) {
            detach(load(workflow.id, pageSignal), Reason.DomCallback);
          }
        }}
      >
        <TooltipTrigger render={children} />
        <TooltipContent
          role="tooltip"
          side="bottom"
          align="start"
          collisionPadding={8}
          className="w-80 max-w-(--available-width) rounded-lg border border-[hsl(var(--gray-400))] p-3 bg-card! text-card-foreground! shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)]"
        >
          <WorkflowHoverContent
            workflow={workflow}
            profile={profile}
            failed={result.state === "hasError"}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nested-fill text-muted-foreground">
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
        <ConnectorCell entries={entries} displayTimezone={displayTimezone} />
        <VisibilityIcon workflow={workflow} />
      </div>
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

function WorkflowRowList({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly WorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowAutomationEntryMap;
  readonly displayTimezone: string;
}) {
  const rows = (
    <>
      {workflows.map((workflow) => {
        return (
          <WorkflowRow
            key={workflow.id}
            workflow={workflow}
            entries={entriesByWorkflowId.get(workflow.id) ?? []}
            displayTimezone={displayTimezone}
          />
        );
      })}
    </>
  );
  return (
    <div
      className={surfaceVariants({
        className: "flex flex-col gap-1 overflow-hidden p-2",
      })}
    >
      {rows}
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

function FilterOptions<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={onChange}
      aria-label={label}
    >
      <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{label}</p>
      {options.map((option) => {
        return (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            closeOnClick={false}
            className="justify-between gap-4"
          >
            {option.label}
            <DropdownMenuRadioItemIndicator>
              <Check size={14} aria-hidden />
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
            className="gap-2 rounded-lg px-3"
            aria-label={t(($) => {
              return $.workflows.list.filter;
            })}
          />
        }
      >
        <Filter size={16} aria-hidden />
        {t(($) => {
          return $.workflows.list.filters;
        })}
        {count > 0 ? (
          <span className="flex size-5 items-center justify-center rounded-md bg-nested-fill text-xs tabular-nums">
            {count}
          </span>
        ) : null}
        <ChevronDown size={14} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <FilterOptions
          label={t(($) => {
            return $.workflows.list.visibility;
          })}
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
        <FilterOptions
          label={t(($) => {
            return $.workflows.list.automations;
          })}
          value={automationFilter}
          onChange={setAutomationFilter}
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
        {count > 0 ? (
          <DropdownMenuItem
            onClick={clearFilters}
            className="mt-1 text-muted-foreground"
          >
            {t(($) => {
              return $.workflows.list.clearFilters;
            })}
          </DropdownMenuItem>
        ) : null}
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
            size="sm"
            className="h-9 shrink-0 gap-2 rounded-lg"
            aria-label={i18n.t(($) => {
              return $.workflows.list.sort.label;
            })}
          />
        }
      >
        <ArrowUpDown size={15} aria-hidden />
        {current?.label ??
          i18n.t(($) => {
            return $.workflows.list.sort.label;
          })}
        <ChevronDown size={14} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => {
            return (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                closeOnClick
                className="justify-between gap-4"
              >
                {option.label}
                <DropdownMenuRadioItemIndicator>
                  <Check size={14} aria-hidden />
                </DropdownMenuRadioItemIndicator>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
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
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative w-full min-w-0 sm:w-72 sm:max-w-sm sm:flex-1">
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
      <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
        <FilterDropdown />
        <SortDropdown value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
}

/** Opens the import skills dialog. */
function useImportSkills(): () => void {
  const openSkillImportDialog = useSet(openSkillImportDialog$);
  return () => {
    openSkillImportDialog();
  };
}

function WorkflowsHeaderActions({
  onImportSkills,
}: {
  readonly onImportSkills: () => void;
}) {
  const { t } = useTranslation();
  const openCreateWorkflowDialog = useSet(openCreateWorkflowDialog$);

  return (
    <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="neutral"
        size="sm"
        className="h-9 shrink-0 gap-2 rounded-lg"
        onClick={onImportSkills}
      >
        <Download size={14} />
        {t(($) => {
          return $.workflows.skillImport.action;
        })}
      </Button>
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

export function WorkflowsPage() {
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
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="hidden min-w-0 md:block">
                <h1 className="text-lg font-semibold tracking-tight text-foreground">
                  {t(($) => {
                    return $.workflows.list.title;
                  })}
                </h1>
              </div>
              <WorkflowsHeaderActions onImportSkills={importSkills} />
            </div>
            <p className="hidden text-sm leading-relaxed text-muted-foreground md:block">
              {t(($) => {
                return $.workflows.list.description;
              })}
            </p>
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
      className={surfaceVariants({
        className: "flex flex-col gap-1 overflow-hidden p-2",
      })}
      data-testid="workflows-loading"
    >
      {[0, 1, 2, 3].map((rowIndex) => {
        return (
          <div key={rowIndex} className="flex items-center gap-3 px-3 py-3">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="h-4 w-40 max-w-full rounded bg-muted/50" />
              <div className="h-3 w-56 max-w-full rounded bg-muted/40" />
            </div>
            <div className="ml-auto h-8 w-32 rounded-full bg-muted/40" />
            <div className="h-5 w-5 rounded-full bg-muted/40" />
            <div className="h-6 w-6 rounded-md bg-muted/40" />
          </div>
        );
      })}
    </div>
  );
}
