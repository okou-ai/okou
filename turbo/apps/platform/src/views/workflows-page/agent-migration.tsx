// What members see after legacy agents become workflows: row labels, the
// one-time notice, the "How workflows work" dialog and the account picker for
// automations whose former agent used a different connector account.
import type { FormEvent, ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  ArrowLeftRight,
  CalendarClock,
  Info,
  MessageSquare,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Radio,
  RadioGroup,
} from "@okouai/ui";
import { Alert } from "@okouai/ui/components/ui/alert";
import { useTranslation } from "react-i18next";

import { nowDate } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import {
  accountConflictTarget$,
  agentMigrationNoticeVisible$,
  closeAccountConflict$,
  dismissAgentMigrationNotice$,
  howWorkflowsWorkOpen$,
  migratedAgentWorkflows$,
  removeWorkflowInclude$,
  resolveAccountConflict$,
  selectConflictConnection$,
  selectedConflictConnectionId$,
  setHowWorkflowsWorkOpen$,
  workflowMigrationBadge,
  type AccountConflictTarget,
  type MigratedAgentWorkflow,
} from "../../signals/workflows-page/agent-migration.ts";
import { locale$ } from "../../signals/locale.ts";
import { singleAgentWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import { InlineSettingsRow } from "../okou-page/components/inline-settings-row.tsx";

function agentNameList(
  workflows: readonly MigratedAgentWorkflow[],
  locale: string,
): string {
  return new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(
    workflows.map((workflow) => {
      return workflow.title;
    }),
  );
}

/** "From agent" / "From <Agent>" on a migrated workflow's row. */
export function WorkflowMigrationBadge({
  workflow,
}: {
  readonly workflow: Pick<WorkflowSummary, "migration">;
}) {
  const { t } = useTranslation();
  const badge = workflowMigrationBadge(workflow, nowDate());
  if (!badge) {
    return null;
  }
  return (
    <Badge className="shrink-0 text-xs text-muted-foreground">
      {"fromAgent" in badge
        ? t(($) => {
            return $.workflows.migration.fromAgent;
          })
        : t(
            ($) => {
              return $.workflows.migration.fromNamedAgent;
            },
            { agent: badge.agent },
          )}
    </Badge>
  );
}

/** One-time notice at the top of the Workflows page for migrated members. */
export function AgentMigrationNotice() {
  const { t } = useTranslation();
  const visible = useLastResolved(agentMigrationNoticeVisible$) ?? false;
  const migrated = useLastResolved(migratedAgentWorkflows$) ?? [];
  const locale = useGet(locale$);
  const openHowWorkflowsWork = useSet(setHowWorkflowsWorkOpen$);
  const dismiss = useSet(dismissAgentMigrationNotice$);
  const pageSignal = useGet(pageSignal$);
  const [first] = migrated;
  if (!visible || !first) {
    return null;
  }
  return (
    <Alert
      role="status"
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground">
          {t(($) => {
            return $.workflows.migration.notice.title;
          })}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t(
            ($) => {
              return $.workflows.migration.notice.description;
            },
            {
              count: migrated.length,
              agents: agentNameList(migrated, locale),
              slug: first.slug,
            },
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            openHowWorkflowsWork(true);
          }}
        >
          {t(($) => {
            return $.workflows.migration.notice.seeHow;
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDomEventFn(async () => {
            await dismiss(pageSignal);
          })}
        >
          {t(($) => {
            return $.workflows.migration.notice.gotIt;
          })}
        </Button>
      </div>
    </Alert>
  );
}

function HowItem({
  icon,
  title,
  body,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="block text-sm text-muted-foreground">{body}</span>
      </span>
    </li>
  );
}

/** Opened from the notice's "See how"; explains workflows after migration. */
export function HowWorkflowsWorkDialog() {
  const { t } = useTranslation();
  const open = useGet(howWorkflowsWorkOpen$);
  const setOpen = useSet(setHowWorkflowsWorkOpen$);
  const migrated = useLastResolved(migratedAgentWorkflows$) ?? [];
  const locale = useGet(locale$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth="md">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.workflows.migration.howItWorks.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.workflows.migration.howItWorks.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-4">
          <HowItem
            icon={<MessageSquare size={16} />}
            title={t(($) => {
              return $.workflows.migration.howItWorks.useTitle;
            })}
            body={t(($) => {
              return $.workflows.migration.howItWorks.useBody;
            })}
          />
          <HowItem
            icon={<CalendarClock size={16} />}
            title={t(($) => {
              return $.workflows.migration.howItWorks.automateTitle;
            })}
            body={t(($) => {
              return $.workflows.migration.howItWorks.automateBody;
            })}
          />
          <HowItem
            icon={<Users size={16} />}
            title={t(($) => {
              return $.workflows.migration.howItWorks.shareTitle;
            })}
            body={t(($) => {
              return $.workflows.migration.howItWorks.shareBody;
            })}
          />
          {migrated.length > 0 ? (
            <HowItem
              icon={<ArrowLeftRight size={16} />}
              title={t(($) => {
                return $.workflows.migration.notice.title;
              })}
              body={t(
                ($) => {
                  return $.workflows.migration.howItWorks.migratedBody;
                },
                {
                  count: migrated.length,
                  agents: agentNameList(migrated, locale),
                },
              )}
            />
          ) : null}
        </ul>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t(($) => {
              return $.workflows.migration.notice.gotIt;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountConflictForm({
  target,
}: {
  readonly target: AccountConflictTarget;
}) {
  const { t } = useTranslation();
  const close = useSet(closeAccountConflict$);
  const pageSignal = useGet(pageSignal$);
  const [submit, resolve] = useLoadableSet(resolveAccountConflict$);
  const { conflict } = target;
  const selected = useGet(selectedConflictConnectionId$) ?? "";
  const select = useSet(selectConflictConnection$);
  const submitting = submit.state === "loading";
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={onDomEventFn(async (event: FormEvent) => {
        // The form owns submission; the dialog stays in the SPA.
        event.preventDefault();
        await resolve(
          { automationId: target.automationId, connectionId: selected },
          pageSignal,
        );
      })}
    >
      <DialogHeader>
        <DialogTitle>
          {t(
            ($) => {
              return $.workflows.migration.accountConflict.title;
            },
            { connector: conflict.connectorLabel },
          )}
        </DialogTitle>
        <DialogDescription>
          {t(
            ($) => {
              return $.workflows.migration.accountConflict.description;
            },
            {
              workflow: target.workflowTitle,
              agent: conflict.agentDisplayName,
              connector: conflict.connectorLabel,
            },
          )}
        </DialogDescription>
      </DialogHeader>
      <RadioGroup
        value={selected}
        onValueChange={(value) => {
          select(String(value));
        }}
        className="flex flex-col gap-2"
      >
        {conflict.options.map((option) => {
          return (
            <label
              key={option.connectionId}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-state-hover has-[[data-checked]]:border-primary"
            >
              <Radio value={option.connectionId} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {option.accountLabel}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {option.source === "agent"
                    ? t(
                        ($) => {
                          return $.workflows.migration.accountConflict
                            .usedByAgent;
                        },
                        { agent: conflict.agentDisplayName },
                      )
                    : t(($) => {
                        return $.workflows.migration.accountConflict
                          .connectedToOkou;
                      })}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            close();
          }}
        >
          {t(($) => {
            return $.workflows.migration.accountConflict.later;
          })}
        </Button>
        <Button type="submit" disabled={!selected || submitting}>
          {t(($) => {
            return $.workflows.migration.accountConflict.confirm;
          })}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Opened from an automation's "Action required". Until the owner picks an
 * account the automation skips its runs.
 */
export function AccountConflictDialog() {
  const target = useGet(accountConflictTarget$);
  const close = useSet(closeAccountConflict$);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent smMaxWidth="md">
        {target ? (
          <AccountConflictForm key={target.automationId} target={target} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Under the slug field when migration had to prefix the old slug. */
export function WorkflowRenamedFromNote({
  detail,
}: {
  readonly detail: Pick<WorkflowDetailResponse, "migration">;
}) {
  const { t } = useTranslation();
  const singleAgent = useLastResolved(singleAgentWorkflows$);
  const renamedFrom = detail.migration?.renamedFrom;
  if (!singleAgent || !renamedFrom) {
    return null;
  }
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {t(
        ($) => {
          return $.workflows.migration.renamedFrom;
        },
        { slug: renamedFrom },
      )}
    </p>
  );
}

function WorkflowIncludeRow({
  detail,
  includeName,
  agent,
  disabled,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly includeName: string;
  readonly agent: string;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [removal, remove] = useLoadableSet(removeWorkflowInclude$);
  const removing = removal.state === "loading";
  return (
    <InlineSettingsRow
      label={t(($) => {
        return $.workflows.migration.includes.label;
      })}
      description={t(
        ($) => {
          return $.workflows.migration.includes.description;
        },
        { agent },
      )}
      alignControls="center"
      wideControls
    >
      <div className="flex w-full items-center justify-between gap-3">
        <Badge className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          /{includeName}
        </Badge>
        {detail.canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || removing}
            aria-label={t(
              ($) => {
                return $.workflows.migration.includes.removeAria;
              },
              { slug: includeName },
            )}
            onClick={onDomEventFn(async () => {
              await remove({ workflowId: detail.id, includeName }, pageSignal);
            })}
          >
            {t(($) => {
              return $.workflows.migration.includes.remove;
            })}
          </Button>
        ) : null}
      </div>
    </InlineSettingsRow>
  );
}

/**
 * Workflows that used to run as an agent keep loading that agent's workflow
 * so their behavior is unchanged; each row lets the owner drop it.
 */
export function WorkflowIncludesRows({
  detail,
  disabled,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly disabled: boolean;
}) {
  const singleAgent = useLastResolved(singleAgentWorkflows$);
  const migration = detail.migration;
  if (!singleAgent || !migration) {
    return null;
  }
  return migration.includes.map((includeName) => {
    return (
      <WorkflowIncludeRow
        key={includeName}
        detail={detail}
        includeName={includeName}
        agent={migration.agentDisplayName}
        disabled={disabled}
      />
    );
  });
}
