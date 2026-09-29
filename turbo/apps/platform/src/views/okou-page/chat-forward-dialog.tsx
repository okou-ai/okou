import { createChatForwardComposerSignals } from "../../signals/chat-page/chat-forward-composer.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ChatThreadFeedbackSignals } from "../../signals/chat-page/chat-thread-feedback.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ChatForwardContext,
  ChatForwardSelection,
  ChatForwardTarget,
} from "../../signals/chat-page/chat-forward.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  subagents$,
} from "../../signals/agent.ts";
import {
  rankAgentsForSearch,
  workspaceSearchChatThreads$,
} from "../../signals/okou-page/workspace-chat-search.ts";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/okou-page/sidebar-state.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { ChatComposer } from "./chat-composer.tsx";
import { assistantName$ } from "../../signals/branding.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import {
  deliveryIntents$,
  type ExistingThreadDeliveryIntent,
} from "../../signals/chat-page/chat-delivery-intents.ts";
import { checkAndRetryPromptDelivery$ } from "../../signals/chat-page/chat-event-signals.ts";

function ForwardContent({ text }: { readonly text: string }) {
  const { t } = useTranslation();
  return (
    <div className="border-y border-border/60 bg-gray-50 px-5 py-4">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.forward.content;
        })}
      </div>
      <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-6 text-foreground">
        {text}
      </blockquote>
    </div>
  );
}

function ForwardTargetContent({
  target,
}: {
  readonly target: ChatForwardTarget;
}) {
  const avatarAgentId = target.kind === "agent" ? target.id : target.agentId;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentAvatarImg
        name={avatarAgentId}
        alt=""
        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
      />
      <span className="truncate text-foreground">{target.title}</span>
    </span>
  );
}

function ForwardTargetPicker({
  onSelect,
}: {
  readonly onSelect: (target: ChatForwardTarget) => void;
}) {
  const { t } = useTranslation();
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const signal = useGet(pageSignal$);
  const assistantName = useGet(assistantName$);
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const defaultAgentName = useLastResolved(defaultAgentName$) ?? assistantName;
  const subagents = useLastResolved(subagents$) ?? [];
  const threadResult = useGet(workspaceSearchChatThreads$);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingAgents = rankAgentsForSearch(
    [
      ...(defaultAgentId
        ? [{ agentId: defaultAgentId, displayName: defaultAgentName }]
        : []),
      ...subagents,
    ],
    normalizedQuery,
  );
  const threads =
    threadResult.query === normalizedQuery ? threadResult.chatThreads : [];
  return (
    <Command
      mode="none"
      autoHighlight
      loopFocus
      value={query}
      onValueChange={(value, eventDetails) => {
        if (eventDetails.reason === "item-press") {
          eventDetails.cancel();
          return;
        }
        detach(setQuery(value, signal), Reason.DomCallback);
      }}
      className="min-h-0"
    >
      <div className="relative px-5 pb-4 pt-3">
        <CommandInput
          autoFocus
          placeholder={t(($) => {
            return $.chat.forward.search;
          })}
        />
      </div>
      <CommandList className="max-h-[min(40vh,320px)] px-5 pb-3">
        {matchingAgents.length > 0 ? (
          <CommandGroup
            heading={
              <span className="block pb-2 text-sm font-medium leading-5 text-foreground">
                {t(($) => {
                  return $.chat.forward.agents;
                })}
              </span>
            }
          >
            {matchingAgents.map((agent) => {
              const title = agent.displayName ?? agent.agentId;
              return (
                <CommandItem
                  key={`agent-${agent.agentId}`}
                  value={`agent-${agent.agentId}`}
                  onClick={() => {
                    onSelect({ kind: "agent", id: agent.agentId, title });
                  }}
                  className="px-1 py-2"
                >
                  <ForwardTargetContent
                    target={{ kind: "agent", id: agent.agentId, title }}
                  />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {threads.length > 0 ? (
          <CommandGroup
            className={matchingAgents.length > 0 ? "mt-4" : undefined}
            heading={
              <span className="block pb-2 text-sm font-medium leading-5 text-foreground">
                {t(($) => {
                  return $.chat.forward.threads;
                })}
              </span>
            }
          >
            {threads.map((thread) => {
              const target: ChatForwardTarget = {
                kind: "thread",
                id: thread.id,
                agentId: thread.agentId,
                title: thread.title,
              };
              return (
                <CommandItem
                  key={`thread-${thread.id}`}
                  value={`thread-${thread.id}`}
                  onClick={() => {
                    onSelect(target);
                  }}
                  className="px-1 py-2"
                >
                  <ForwardTargetContent target={target} />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {matchingAgents.length === 0 && threads.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.forward.noResults;
            })}
          </p>
        ) : null}
      </CommandList>
    </Command>
  );
}

function createForwardContext(
  selection: ChatForwardSelection,
  sourceAgentId: string,
  sourceThreadTitle: string,
): ChatForwardContext {
  return {
    ...selection,
    agentId: sourceAgentId,
    titleSnapshot: sourceThreadTitle,
  };
}

function ForwardComposerSurface({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  return (
    <div className="w-full min-w-0 p-5" data-chat-composer>
      <ChatComposer signals={composer} showPendingItems={false} />
    </div>
  );
}

function ForwardDeliveryNotice({
  target,
  selection,
  onDismiss,
}: {
  readonly target: ChatForwardTarget;
  readonly selection: ChatForwardSelection;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const intents = useLastResolved(deliveryIntents$);
  const [checking, checkAndRetry] = useLoadableSet(
    checkAndRetryPromptDelivery$,
  );
  const signal = useGet(pageSignal$);
  if (target.kind !== "thread") {
    return null;
  }
  const pending = intents
    ?.filter((item): item is ExistingThreadDeliveryIntent => {
      return (
        item.kind === "existing-thread" &&
        item.threadId === target.id &&
        item.body.sourceRunId === selection.runId &&
        item.status !== "accepted"
      );
    })
    .sort((left, right) => {
      return left.createdAt.localeCompare(right.createdAt);
    })
    .at(-1);
  if (!pending) {
    return null;
  }
  const message =
    pending.status === "rejected"
      ? pending.rejection === "authentication"
        ? t(($) => {
            return $.chat.forward.delivery.notSentAuth;
          })
        : t(($) => {
            return $.chat.forward.delivery.notSentSaved;
          })
      : pending.status === "uncertain"
        ? t(($) => {
            return $.chat.forward.delivery.unconfirmed;
          })
        : t(($) => {
            return $.chat.forward.delivery.sending;
          });
  return (
    <div
      role={pending.status === "rejected" ? "alert" : "status"}
      className="mx-5 mb-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
    >
      <p>{message}</p>
      {pending.status !== "prepared" ? (
        <Button
          type="button"
          size="sm"
          variant="neutral"
          className="mt-2"
          disabled={checking.state === "loading" || !navigator.locks}
          onClick={() => {
            detach(
              (async () => {
                const accepted = await checkAndRetry(
                  { threadId: target.id, clientEventId: pending.clientEventId },
                  signal,
                );
                if (accepted) {
                  onDismiss();
                  toast.success(
                    t(($) => {
                      return $.chat.forward.delivery.confirmed;
                    }),
                  );
                }
              })(),
              Reason.DomCallback,
            );
          }}
        >
          {checking.state === "loading"
            ? t(($) => {
                return $.chat.delivery.checking;
              })
            : t(($) => {
                return $.chat.delivery.checkAndRetry;
              })}
        </Button>
      ) : null}
      {!navigator.locks ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.delivery.webLocksRequired;
          })}
        </p>
      ) : null}
    </div>
  );
}

export function ChatForwardDialog({
  selection,
  feedback,
  sourceAgentId,
  sourceThreadTitle,
  onDismiss,
}: {
  readonly selection: ChatForwardSelection;
  readonly feedback: ChatThreadFeedbackSignals;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const target = useGet(feedback.forwardTarget$);
  const [prepared, prepare] = useLoadableSet(feedback.prepareForwardComposer$);
  const resetTarget = useSet(feedback.resetForwardTarget$);
  const signal = useGet(pageSignal$);
  const handleTargetSelect = (nextTarget: ChatForwardTarget) => {
    const forward = createForwardContext(
      selection,
      sourceAgentId,
      sourceThreadTitle,
    );
    const notifyAccepted = () => {
      toast.success(
        t(($) => {
          return $.chat.forward.sent;
        }),
      );
    };
    const onOptimisticSend = () => {
      onDismiss();
      // A new agent thread is only prepared here; the prompt has not been accepted.
      if (nextTarget.kind === "thread") {
        notifyAccepted();
      }
    };
    const onAcceptedSend = () => {
      if (nextTarget.kind === "agent") {
        notifyAccepted();
      }
    };
    detach(
      prepare(
        createChatForwardComposerSignals,
        { target: nextTarget, forward, onOptimisticSend, onAcceptedSend },
        signal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent
        smMaxWidth="xl"
        contentClassName="grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="min-w-0 px-5 pb-3 pt-5">
          <div className="flex min-w-0 items-center gap-2 pr-8">
            {target ? (
              <IconTooltipButton
                type="button"
                onClick={() => {
                  resetTarget();
                }}
                className="-ml-2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
                aria-label={t(($) => {
                  return $.chat.forward.back;
                })}
              >
                <ArrowLeft size={16} />
              </IconTooltipButton>
            ) : null}
            <DialogTitle className="min-w-0 flex-1 overflow-hidden text-base font-semibold">
              {target ? (
                <ForwardTargetContent target={target} />
              ) : (
                t(($) => {
                  return $.chat.forward.title;
                })
              )}
            </DialogTitle>
          </div>
          <DialogDescription className={target ? "sr-only" : undefined}>
            {t(($) => {
              return $.chat.forward.description;
            })}
          </DialogDescription>
        </DialogHeader>
        {target ? null : <ForwardContent text={selection.quote} />}
        {target && prepared.state === "loading" ? (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
          </div>
        ) : target && prepared.state === "hasData" ? (
          <>
            <ForwardDeliveryNotice
              target={target}
              selection={selection}
              onDismiss={onDismiss}
            />
            <ForwardComposerSurface composer={prepared.data.composer} />
          </>
        ) : (
          <ForwardTargetPicker onSelect={handleTargetSelect} />
        )}
      </DialogContent>
    </Dialog>
  );
}
