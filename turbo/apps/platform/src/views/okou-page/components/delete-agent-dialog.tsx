import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  surfaceVariants,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { AlertTriangle, Trash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isNetworkRequestError } from "../../../lib/network-error.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { reloadAgents$ } from "../../../signals/agent.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import {
  deleteAgent$,
  agentDeleteSession$,
  agentDeleteResult$,
  setAgentDeleteCopyChoices$,
  setAgentDeleteDialogOpen$,
  reloadAgentDeleteWorkflows$,
  type AgentDeleteWorkflow,
  type AgentDeleteSession,
} from "../../../signals/okou-page/settings/settings-tab.ts";

export interface AgentDeleteCopyTarget {
  readonly id: string;
  readonly displayName: string | null;
}

/** Sentinel Select value meaning "let this workflow be deleted with the agent". */
const DELETE_WITH_AGENT = "__delete_with_agent__";

function DeleteDangerHeader({ agentName }: { agentName: string }) {
  const { t } = useTranslation("agents");

  return (
    <>
      <DialogHeader className="space-y-0 text-left">
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="shrink-0 text-destructive" />
          <DialogTitle>
            {t(
              ($) => {
                return $.delete.title;
              },
              { agentName },
            )}
          </DialogTitle>
        </div>
        <DialogDescription className="mt-3">
          {t(($) => {
            return $.delete.description;
          })}
        </DialogDescription>
      </DialogHeader>
      <p className="mt-3 text-sm font-semibold text-foreground">
        {t(($) => {
          return $.delete.irreversible;
        })}
      </p>
    </>
  );
}

function DeleteDangerZoneHeader() {
  const { t } = useTranslation("agents");
  return (
    <div className="min-w-0 sm:max-w-[46%]">
      <h3 className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.delete.dangerZone;
        })}
      </h3>
      <p className="text-xs text-muted-foreground mt-1 leading-snug">
        {t(($) => {
          return $.delete.dangerZoneDescription;
        })}
      </p>
    </div>
  );
}

interface DeleteConfirmButtonProps {
  deleting: boolean;
  copying: boolean;
  workflowsReady: boolean;
  onDelete: () => void;
  className?: string;
}

function DeleteConfirmButton({
  deleting,
  copying,
  workflowsReady,
  onDelete,
  className,
}: DeleteConfirmButtonProps) {
  const { t } = useTranslation("agents");
  const label = copying
    ? t(($) => {
        return $.actions.copying;
      })
    : deleting
      ? t(($) => {
          return $.actions.deleting;
        })
      : t(($) => {
          return $.actions.delete;
        });
  return (
    <Button
      variant="destructive"
      size="sm"
      className={className}
      disabled={deleting || copying || !workflowsReady}
      onClick={onDelete}
    >
      {label}
    </Button>
  );
}

interface AgentDeleteReconcileViewProps {
  agentName: string;
  deleting: boolean;
  copying: boolean;
  workflowsReady: boolean;
  onDelete: () => void;
  deleteWorkflows: readonly AgentDeleteWorkflow[];
  deleteCopyTargets: readonly AgentDeleteCopyTarget[];
  copyChoices: Record<string, string>;
  setCopyChoices: (choices: Record<string, string>) => void;
}

function AgentDeleteReconcileView({
  agentName,
  deleting,
  copying,
  workflowsReady,
  onDelete,
  deleteWorkflows,
  deleteCopyTargets,
  copyChoices,
  setCopyChoices,
}: AgentDeleteReconcileViewProps) {
  const { t } = useTranslation("agents");
  const reloadAgents = useSet(reloadAgents$);

  return (
    <div className="grid grid-cols-[264px_1fr]">
      <div className="flex flex-col border-r border-[hsl(var(--gray-400))]/40 bg-muted/40 px-6 py-6">
        <DeleteDangerHeader agentName={agentName} />
        <div className="mt-auto flex flex-col gap-2 pt-8">
          <DeleteConfirmButton
            deleting={deleting}
            copying={copying}
            workflowsReady={workflowsReady}
            onDelete={onDelete}
            className="w-full"
          />
          {deleting || copying ? null : (
            <DialogClose
              render={
                <Button variant="outline" size="sm" className="w-full">
                  {t(($) => {
                    return $.actions.cancel;
                  })}
                </Button>
              }
            />
          )}
        </div>
      </div>
      <div className="flex flex-col px-6 py-6">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.delete.workflows.title;
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.delete.workflows.description;
          })}
        </p>
        <div className="mt-3 flex max-h-[320px] flex-col gap-1 overflow-y-auto">
          {deleteWorkflows.map((workflow) => {
            return (
              <div
                key={workflow.id}
                className="grid grid-cols-[1fr_200px] items-center gap-6"
              >
                <span
                  className="min-w-0 truncate text-sm text-foreground"
                  title={workflow.title}
                >
                  {workflow.title}
                </span>
                <Select
                  value={copyChoices[workflow.id] ?? DELETE_WITH_AGENT}
                  disabled={deleting || copying || !workflowsReady}
                  onOpenChange={(open) => {
                    if (open) {
                      reloadAgents();
                    }
                  }}
                  onValueChange={(value) => {
                    setCopyChoices({ ...copyChoices, [workflow.id]: value });
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t(
                      ($) => {
                        return $.delete.workflows.handle;
                      },
                      { workflowTitle: workflow.title },
                    )}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DELETE_WITH_AGENT}>
                      {t(($) => {
                        return $.delete.workflows.deleteWithAgent;
                      })}
                    </SelectItem>
                    {deleteCopyTargets.map((target) => {
                      return (
                        <SelectItem key={target.id} value={target.id}>
                          {t(
                            ($) => {
                              return $.delete.workflows.copyTo;
                            },
                            { agentName: target.displayName ?? target.id },
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface AgentDeleteSimpleViewProps {
  agentName: string;
  deleting: boolean;
  copying: boolean;
  workflowsReady: boolean;
  onDelete: () => void;
}

function AgentDeleteSimpleView({
  agentName,
  deleting,
  copying,
  workflowsReady,
  onDelete,
}: AgentDeleteSimpleViewProps) {
  const { t } = useTranslation("agents");

  return (
    <div className="flex flex-col px-6 py-6">
      <DeleteDangerHeader agentName={agentName} />
      <DialogFooter className="mt-6">
        {deleting || copying ? null : (
          <DialogClose
            render={
              <Button variant="outline" size="sm">
                {t(($) => {
                  return $.actions.cancel;
                })}
              </Button>
            }
          />
        )}
        <DeleteConfirmButton
          deleting={deleting}
          copying={copying}
          workflowsReady={workflowsReady}
          onDelete={onDelete}
        />
      </DialogFooter>
    </div>
  );
}

interface AgentDeleteDialogProps {
  agentId: string;
  /** Agent name shown in the confirmation copy. */
  resolvedAgentName: string;
  /** Callback to delete the agent. */
  onDelete: () => Promise<void>;
  /** Workflows bound to this agent, offered for rescue in the delete dialog. */
  deleteWorkflows?: readonly AgentDeleteWorkflow[];
  deleteWorkflowsState: "loading" | "error" | "ready";
  /** Agents the caller can copy a workflow onto before deleting this agent. */
  deleteCopyTargets?: readonly AgentDeleteCopyTarget[];
  /** Copy a workflow onto another agent before the agent is deleted. */
  onCopyWorkflowBeforeDelete?: (
    workflowId: string,
    toAgentId: string,
  ) => Promise<void>;
}

function AgentDeleteError({ error }: { error: unknown }) {
  const { t } = useTranslation("common");
  if (error === null) {
    return null;
  }
  return (
    <p role="alert" className="px-6 pb-6 text-sm text-destructive">
      {error instanceof Error && !isNetworkRequestError(error)
        ? error.message
        : t(($) => {
            return $.global.errors.requestFailed;
          })}
    </p>
  );
}

function AgentDeleteFeedback({
  session,
  deleteWorkflowsState,
  deleteCopyTargets,
  onRetry,
}: {
  session: AgentDeleteSession | null;
  deleteWorkflowsState: "loading" | "error" | "ready";
  deleteCopyTargets: readonly AgentDeleteCopyTarget[];
  onRetry: (sessionId: symbol) => void;
}) {
  const { t } = useTranslation("agents");
  const result = useLoadable(agentDeleteResult$);
  const busy = session !== null && session.phase !== "idle";
  return (
    <>
      {deleteWorkflowsState === "loading" && (
        <p role="status" className="px-6 pb-6 text-sm text-muted-foreground">
          {t(($) => {
            return $.delete.workflows.loading;
          })}
        </p>
      )}
      {deleteWorkflowsState === "error" ? (
        <div
          role="alert"
          className="space-y-3 px-6 pb-6 text-sm text-destructive"
        >
          <p>
            {t(($) => {
              return $.delete.workflows.loadFailed;
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (session) {
                onRetry(session.id);
              }
            }}
            disabled={busy}
          >
            {t(($) => {
              return $.actions.retry;
            })}
          </Button>
        </div>
      ) : (
        <AgentDeleteError
          error={session && result.state === "hasError" ? result.error : null}
        />
      )}
      {session && session.completedRescues.length > 0 && (
        <div role="status" className="space-y-2 px-6 pb-6 text-sm">
          <p className="font-medium">
            {t(($) => {
              return $.delete.workflows.copiedTitle;
            })}
          </p>
          <ul className="space-y-1 break-words text-muted-foreground">
            {session.completedRescues.map(([workflowId, targetId]) => {
              const workflowTitle =
                session.workflows.find((workflow) => {
                  return workflow.id === workflowId;
                })?.title ??
                t(($) => {
                  return $.delete.workflows.untitled;
                });
              const agentName =
                deleteCopyTargets.find((target) => {
                  return target.id === targetId;
                })?.displayName ??
                t(($) => {
                  return $.fallbackName;
                });
              return (
                <li key={`${workflowId}:${targetId}`}>
                  {t(
                    ($) => {
                      return $.delete.workflows.copiedTo;
                    },
                    { workflowTitle, agentName },
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

export function AgentDeleteDialog({
  agentId,
  resolvedAgentName,
  onDelete,
  deleteWorkflows,
  deleteWorkflowsState,
  deleteCopyTargets = [],
  onCopyWorkflowBeforeDelete,
}: AgentDeleteDialogProps) {
  const { t } = useTranslation("agents");
  const pageSignal = useGet(pageSignal$);

  const deleteAgentFn = useSet(deleteAgent$);
  const currentSession = useGet(agentDeleteSession$);
  const session =
    currentSession?.agentId === agentId && currentSession.owner === pageSignal
      ? currentSession
      : null;
  const setOpen = useSet(setAgentDeleteDialogOpen$);
  const updateCopyChoices = useSet(setAgentDeleteCopyChoices$);
  const reloadWorkflows = useSet(reloadAgentDeleteWorkflows$);
  const copyChoices = session?.choices ?? {};
  // Retain this confirmation's last known workflow rows if a refresh fails.
  const workflows = deleteWorkflows ?? session?.workflows ?? [];
  const copying = session?.phase === "copying";
  const deleting = session?.phase === "deleting";
  const workflowsReady = deleteWorkflowsState === "ready";
  const setCopyChoices = (choices: Record<string, string>) => {
    if (session) {
      updateCopyChoices(session.id, choices, workflows);
    }
  };
  const canReconcile =
    workflows.length > 0 && onCopyWorkflowBeforeDelete !== undefined;

  const handleDelete = () => {
    if (!session || !workflowsReady) {
      return;
    }
    detach(
      deleteAgentFn(
        {
          sessionId: session.id,
          deleteFn: onDelete,
          copyWorkflow: onCopyWorkflowBeforeDelete,
          workflowIds: workflows.map((workflow) => {
            return workflow.id;
          }),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <Card className={surfaceVariants({ className: "overflow-hidden mt-4" })}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <DeleteDangerZoneHeader />
          <div className="flex w-full shrink-0 justify-end sm:w-auto">
            <Dialog
              open={session?.open ?? false}
              onOpenChange={(open, eventDetails) => {
                if (
                  !setOpen(
                    { agentId, workflows: deleteWorkflows },
                    open,
                    pageSignal,
                  )
                ) {
                  eventDetails.cancel();
                }
              }}
            >
              <DialogTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash size={14} />
                    {t(($) => {
                      return $.actions.delete;
                    })}
                  </Button>
                }
              />
              <DialogContent
                showCloseButton={!deleting && !copying}
                closeLabel={t(($) => {
                  return $.actions.close;
                })}
                maxWidth="3xl"
                contentClassName="gap-0 overflow-hidden p-0"
              >
                {canReconcile ? (
                  <AgentDeleteReconcileView
                    agentName={resolvedAgentName}
                    deleting={deleting}
                    copying={copying}
                    workflowsReady={workflowsReady}
                    onDelete={handleDelete}
                    deleteWorkflows={workflows}
                    deleteCopyTargets={deleteCopyTargets}
                    copyChoices={copyChoices}
                    setCopyChoices={setCopyChoices}
                  />
                ) : (
                  <AgentDeleteSimpleView
                    agentName={resolvedAgentName}
                    deleting={deleting}
                    copying={copying}
                    workflowsReady={workflowsReady}
                    onDelete={handleDelete}
                  />
                )}
                <AgentDeleteFeedback
                  session={session}
                  deleteWorkflowsState={deleteWorkflowsState}
                  deleteCopyTargets={deleteCopyTargets}
                  onRetry={reloadWorkflows}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
