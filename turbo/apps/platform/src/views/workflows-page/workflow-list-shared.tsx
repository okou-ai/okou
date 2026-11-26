import type { ReactElement } from "react";
import { Avatar } from "@base-ui/react/avatar";
import { useGet, useLoadable, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  WorkflowOwnerProfile,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  AlertTriangle,
  Download,
  Lock,
  Plus,
  Route,
  User,
  Globe,
} from "lucide-react";
import {
  Button,
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
import { ROUTES } from "../../signals/route-paths.ts";
import { openSkillImportDialog$ } from "../../signals/skill-import/skill-import-dialog.ts";
import {
  isGoogleCalendarWorkflowAutomation,
  type WorkflowAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import { Link } from "../router/link.tsx";
import {
  humanReadableAutomationRuleLabel,
  AutomationListIcon,
  automationTypeLabel,
  WorkflowAutomationEnabledSwitch,
} from "../okou-page/workflow-automations-page.tsx";
import { labelInitials, workflowTitle } from "./workflow-shared.tsx";

export type WorkflowAutomationEntryMap = ReadonlyMap<
  string,
  readonly WorkflowAutomationEntry[]
>;

export function workflowAutomationEntryMap(
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
  redesigned = false,
}: {
  readonly interactive?: boolean;
  readonly muted?: boolean;
  readonly redesigned?: boolean;
}) {
  return cn(
    "inline-flex h-6 items-center gap-1.5 rounded-full border border-border/80 bg-white px-2 text-[11px] font-medium leading-none shadow-[0_0_2px_rgba(0,0,0,0.06)]",
    redesigned ? "min-w-0 max-w-full" : "shrink-0",
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

export function VisibilityIcon({
  workflow,
}: {
  readonly workflow: WorkflowSummary;
}) {
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

export function ConnectorCell({
  entries,
  displayTimezone,
  redesigned = false,
}: {
  readonly entries: readonly WorkflowAutomationEntry[];
  readonly displayTimezone: string;
  readonly redesigned?: boolean;
}) {
  if (entries.length === 0) {
    return (
      <span className={connectorPillClassName({ muted: true, redesigned })}>
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
                      connectorPillClassName({ interactive: true, redesigned }),
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
                    <span className={redesigned ? "truncate" : undefined}>
                      {actionRequiredEntry
                        ? i18n.t(($) => {
                            return $.workflows.list.actionRequired;
                          })
                        : connectorNames(entries)}
                    </span>
                    {!actionRequiredEntry && remaining > 0 ? (
                      <span
                        className={cn(
                          "text-muted-foreground",
                          redesigned && "shrink-0",
                        )}
                      >
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

export function WorkflowRowIcon({
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

export function hasAutomations(
  workflowId: string,
  entriesByWorkflowId: WorkflowAutomationEntryMap,
): boolean {
  return (entriesByWorkflowId.get(workflowId)?.length ?? 0) > 0;
}

/** Opens the import skills dialog. */
export function useImportSkills(): () => void {
  const openSkillImportDialog = useSet(openSkillImportDialog$);
  return () => {
    openSkillImportDialog();
  };
}

export function WorkflowsHeaderActions({
  onImportSkills,
  redesigned = false,
  className,
}: {
  readonly onImportSkills: () => void;
  readonly redesigned?: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const openCreateWorkflowDialog = useSet(openCreateWorkflowDialog$);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        redesigned && "max-w-full flex-wrap",
        className,
      )}
    >
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
