import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  Loader2,
  X,
  CircleCheck,
  CircleMinus,
  BellOff,
  EyeOff,
  SquarePen,
  Send,
  ArrowLeft,
} from "lucide-react";
import { Button, buttonVariants } from "@okouai/ui";
import type { SuggestionOption } from "@okouai/api-contracts/contracts/feed";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  closeSettledSuggestion$,
  focusSuggestionTitleOnRef$,
  retryAgentSuggestion$,
  submitSuggestionFeedbackWithUndo$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  chooseSuggestionDirectionTarget$,
  collapseSuggestionDirection$,
  restoreDirectionFocusOnRef$,
  openSuggestionDirection$,
  resetSuggestionDirectionTarget$,
  startAgentSuggestion$,
  suggestionDirection$,
  suggestionDirectionComposer$,
  suggestionDirectionTarget$,
  type SuggestionDirectionTarget,
} from "../../signals/okou-page/agent-suggestions.ts";
import type { ChatForwardTarget } from "../../signals/chat-page/chat-forward.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ForYouCardHeading } from "./for-you-card-heading.tsx";
import { ForwardTargetContent } from "./chat-forward-dialog.tsx";
import { ChatComposer } from "./composer.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

function SuggestionOptionContent({
  option,
}: {
  readonly option: SuggestionOption;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-break-word">
      <span className="leading-5">{option.label}</span>
      {option.description && (
        <span className="text-xs leading-5 text-muted-foreground">
          {option.description}
        </span>
      )}
    </span>
  );
}

function CloseSettledSuggestion({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const close = useSet(closeSettledSuggestion$);
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-xs"
      showTooltip
      aria-label={t(($) => {
        return $.chat.agentSuggestions.closeFeedback;
      })}
      onClick={() => {
        close(entry);
      }}
    >
      <X />
    </Button>
  );
}

/** Rows below the waiting cards keep their card's title to stay identifiable. */
function SettledSuggestionTitle({ title }: { readonly title: string }) {
  return (
    <p className="mt-1 truncate pl-6 text-xs leading-5 text-muted-foreground">
      {title}
    </p>
  );
}

export function SuggestionSentNotice({
  entry,
  threadId,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly threadId: string | null;
}) {
  const { t } = useTranslation();
  const sending = useLoadable(entry.sending$);
  const failed = threadId === null && sending.state === "hasError";
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        {threadId === null && !failed ? (
          <Loader2
            aria-hidden
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
        ) : failed ? (
          <X aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Check
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <p
          role={failed ? "alert" : "status"}
          className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground"
        >
          {failed
            ? sending.error instanceof Error
              ? sending.error.message
              : t(($) => {
                  return $.global.errors.requestFailed;
                })
            : threadId === null
              ? t(($) => {
                  return $.chat.agentSuggestions.sending;
                })
              : t(($) => {
                  return $.chat.agentSuggestions.messageSent;
                })}
        </p>
        {threadId !== null && (
          <Link
            pathname={ROUTES.chat}
            options={{ pathParams: { threadId } }}
            className={buttonVariants({ variant: "quiet", size: "sm" })}
          >
            {t(($) => {
              return $.chat.agentSuggestions.openChat;
            })}
            <ArrowRight aria-hidden />
          </Link>
        )}
        <CloseSettledSuggestion entry={entry} />
      </div>
      <SettledSuggestionTitle title={entry.item.content.title} />
    </div>
  );
}

function SuggestionSaveError({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const result = useLoadable(entry.result$);
  const retry = useSet(retryAgentSuggestion$);
  const signal = useGet(pageSignal$);
  if (result.state !== "hasError") {
    return null;
  }
  return (
    <div
      role="alert"
      className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card p-3"
    >
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {entry.item.content.title}:{" "}
        {result.error instanceof Error
          ? result.error.message
          : t(($) => {
              return $.global.errors.requestFailed;
            })}
      </p>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => {
          detach(retry(entry, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </Button>
    </div>
  );
}

export function SuggestionSaveErrors() {
  const entries = useLastLoadable(agentSuggestionEntries$);
  return entries.state === "hasData"
    ? entries.data.map((entry) => {
        return <SuggestionSaveError key={entry.item.id} entry={entry} />;
      })
    : null;
}

function SuggestionDirectionEntry({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const open = useSet(openSuggestionDirection$);
  const restoreFocus = useSet(restoreDirectionFocusOnRef$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      ref={restoreFocus}
      data-suggestion-direction-trigger={entry.item.id}
      type="button"
      variant="quiet"
      className="h-auto min-h-14 w-full justify-between gap-3 whitespace-normal rounded-3xl bg-nested-fill px-4 py-3 text-left text-sm font-normal text-muted-foreground"
      aria-description={t(($) => {
        return $.chat.agentSuggestions.customDirectionDescription;
      })}
      onClick={() => {
        detach(open(entry, signal), Reason.DomCallback);
      }}
    >
      <span className="min-w-0 flex-1 leading-5">
        {t(($) => {
          return $.chat.agentSuggestions.customPlaceholder;
        })}
      </span>
      <SquarePen aria-hidden className="shrink-0 text-muted-foreground" />
    </Button>
  );
}

function directionHeaderTarget(
  target: SuggestionDirectionTarget,
  newChatTitle: string,
): ChatForwardTarget {
  return target.kind === "new"
    ? { kind: "agent", id: target.agentId, title: newChatTitle }
    : {
        kind: "thread",
        id: target.id,
        agentId: target.agentId,
        title: target.title ?? newChatTitle,
      };
}

function SuggestionDirectionTargets({
  agentId,
  threads,
  newChatTitle,
  relatedLabelId,
}: {
  readonly agentId: string;
  readonly threads: readonly Extract<
    SuggestionDirectionTarget,
    { readonly kind: "thread" }
  >[];
  readonly newChatTitle: string;
  readonly relatedLabelId: string;
}) {
  const { t } = useTranslation();
  const choose = useSet(chooseSuggestionDirectionTarget$);
  const signal = useGet(pageSignal$);
  const select = (target: SuggestionDirectionTarget) => {
    detach(choose(target, signal), Reason.DomCallback);
  };
  const row =
    "h-auto min-h-12 w-full justify-start rounded-lg px-1 py-2 text-left text-sm font-normal";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button
        type="button"
        variant="quiet"
        className={row}
        onClick={() => {
          select({ kind: "new", agentId });
        }}
      >
        <ForwardTargetContent
          target={directionHeaderTarget({ kind: "new", agentId }, newChatTitle)}
        />
      </Button>
      <section aria-labelledby={relatedLabelId} className="min-w-0">
        <h3
          id={relatedLabelId}
          className="pb-2 text-sm font-medium leading-5 text-foreground"
        >
          {t(($) => {
            return $.chat.agentSuggestions.relatedChats;
          })}
        </h3>
        <div className="flex flex-col gap-1">
          {threads.map((target) => {
            return (
              <Button
                key={target.id}
                type="button"
                variant="quiet"
                className={row}
                onClick={() => {
                  select(target);
                }}
              >
                <ForwardTargetContent
                  target={directionHeaderTarget(target, newChatTitle)}
                />
              </Button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SuggestionDirection({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const direction = useGet(suggestionDirection$);
  return direction?.itemId === entry.item.id ? (
    <SuggestionDirectionComposer direction={direction} />
  ) : (
    <SuggestionDirectionEntry entry={entry} />
  );
}

function SuggestionDirectionComposer({
  direction,
}: {
  readonly direction: {
    readonly itemId: string;
    readonly agentId: string;
    readonly threads: readonly Extract<
      SuggestionDirectionTarget,
      { readonly kind: "thread" }
    >[];
  };
}) {
  const { t } = useTranslation();
  const headingId = `suggestion-direction-heading-${direction.itemId}`;
  const descriptionId = `suggestion-direction-description-${direction.itemId}`;
  const focusHeading = useSet(focusSuggestionTitleOnRef$);
  const target = useGet(suggestionDirectionTarget$);
  const prepared = useLoadable(suggestionDirectionComposer$);
  const back = useSet(resetSuggestionDirectionTarget$);
  const close = useSet(collapseSuggestionDirection$);
  const newChatTitle = t(($) => {
    return $.chat.newChat;
  });
  const choosing = direction.threads.length > 0;
  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={!target ? descriptionId : undefined}
      className="flex min-w-0 flex-col gap-3 pt-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {target && choosing && (
          <IconTooltipButton
            type="button"
            onClick={() => {
              back();
            }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            aria-label={t(($) => {
              return $.chat.forward.back;
            })}
          >
            <ArrowLeft size={16} />
          </IconTooltipButton>
        )}
        <h3
          key={target?.kind === "thread" ? target.id : target?.kind}
          id={headingId}
          tabIndex={-1}
          ref={focusHeading}
          className="min-w-0 flex-1 text-sm font-medium"
        >
          {target ? (
            <ForwardTargetContent
              target={directionHeaderTarget(target, newChatTitle)}
            />
          ) : (
            t(($) => {
              return $.chat.agentSuggestions.directionTitle;
            })
          )}
        </h3>
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          aria-label={t(($) => {
            return $.workflows.common.close;
          })}
          onClick={() => {
            close();
          }}
        >
          <X />
        </Button>
      </div>
      {!target && (
        <p id={descriptionId} className="sr-only">
          {t(($) => {
            return $.chat.agentSuggestions.directionDescription;
          })}
        </p>
      )}
      {prepared.state === "hasError" ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {prepared.error instanceof Error
            ? prepared.error.message
            : t(($) => {
                return $.global.errors.requestFailed;
              })}
        </p>
      ) : prepared.state === "hasData" && prepared.data ? (
        <div className="w-full min-w-0" data-chat-composer>
          <ChatComposer signals={prepared.data} showPendingItems={false} />
        </div>
      ) : target || !choosing ? (
        <div className="flex min-h-40 items-center justify-center text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden />
        </div>
      ) : (
        <SuggestionDirectionTargets
          agentId={direction.agentId}
          threads={direction.threads}
          newChatTitle={newChatTitle}
          relatedLabelId={`suggestion-direction-related-${direction.itemId}`}
        />
      )}
    </section>
  );
}

export function AgentSuggestionCard({
  entry,
  active,
  navigation,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly active: boolean;
  readonly navigation: ReactNode;
}) {
  const { t } = useTranslation();
  const { item } = entry;
  const start = useSet(startAgentSuggestion$);
  const submitFeedback = useSet(submitSuggestionFeedbackWithUndo$);
  const signal = useGet(pageSignal$);
  const sourceOption = item.content.options.find((option) => {
    return option.threadId !== null;
  });
  const sourceParts = item.content.options
    .flatMap((option) => {
      return option.draft.draftUserMessage?.parts ?? [];
    })
    .filter((part) => {
      return part.type === "chat_thread";
    });
  const sourcePart =
    sourceParts.find((part) => {
      return part.threadId === sourceOption?.threadId;
    }) ?? sourceParts[0];
  const sourceThreadId =
    sourceOption?.threadId ??
    (sourcePart?.type === "chat_thread" ? sourcePart.threadId : null);
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className="flex flex-1 flex-col"
    >
      <ForYouCardHeading
        id={item.id}
        title={item.content.title}
        description={item.content.rationale}
        active={active}
        source={
          sourceThreadId ? (
            <Link
              pathname={ROUTES.chat}
              options={{ pathParams: { threadId: sourceThreadId } }}
              className="inline-block max-w-full truncate rounded-md text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:bg-state-hover hover:text-foreground"
              aria-label={t(($) => {
                return $.chat.agentSuggestions.viewSource;
              })}
            >
              {sourcePart?.threadId === sourceThreadId
                ? sourcePart.titleSnapshot
                : t(($) => {
                    return $.chat.agentSuggestions.viewSource;
                  })}
            </Link>
          ) : null
        }
      />
      <div className="mb-6 mt-6 flex flex-col gap-2">
        {item.content.options.map((option) => {
          return (
            <Button
              key={option.id}
              type="button"
              variant="quiet"
              className="h-auto min-h-14 w-full justify-between gap-3 whitespace-normal rounded-3xl bg-nested-fill px-4 py-3 text-left text-sm font-normal text-foreground"
              aria-label={option.label}
              aria-description={[
                option.description,
                option.threadId
                  ? t(($) => {
                      return $.chat.agentSuggestions.editDraft;
                    })
                  : t(($) => {
                      return $.chat.agentSuggestions.sendNew;
                    }),
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                detach(start(item.id, option.id, signal), Reason.DomCallback);
              }}
            >
              <SuggestionOptionContent option={option} />
              {option.threadId ? (
                <SquarePen
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <Send aria-hidden className="shrink-0 text-muted-foreground" />
              )}
            </Button>
          );
        })}
        {active && <SuggestionDirection entry={entry} />}
      </div>
      <SuggestionFeedback entry={entry} />
      <footer className="mt-3 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="px-2 text-xs font-normal"
          onClick={() => {
            detach(
              submitFeedback(item.id, "dismissed", signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.chat.agentSuggestions.dismiss;
          })}
        </Button>
        {navigation}
      </footer>
    </article>
  );
}

function SuggestionFeedback({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const { item } = entry;
  const signal = useGet(pageSignal$);
  const submitFeedback = useSet(submitSuggestionFeedbackWithUndo$);
  const feedbackActions = [
    {
      kind: "already_done" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.alreadyDone;
      }),
      Icon: CircleCheck,
    },
    {
      kind: "not_planned" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.notPlanned;
      }),
      Icon: CircleMinus,
    },
    {
      kind: "dont_nudge" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.dontNudge;
      }),
      Icon: BellOff,
    },
    {
      kind: "less_like_this" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.lessLikeThis;
      }),
      Icon: EyeOff,
    },
  ];
  return (
    <div className="mt-auto border-t border-border pt-4">
      <p
        id={`feedback-label-${item.id}`}
        className="mb-2 text-xs text-muted-foreground"
      >
        {t(($) => {
          return $.chat.agentSuggestions.feedbackPrompt;
        })}
      </p>
      <div
        role="group"
        aria-labelledby={`feedback-label-${item.id}`}
        className="flex flex-wrap gap-1.5 sm:gap-2"
      >
        {feedbackActions.map(({ kind, label, Icon }) => {
          return (
            <Button
              key={kind}
              type="button"
              variant="outline"
              className="min-h-11 gap-1 rounded-full bg-card px-2 text-[11px] font-normal text-muted-foreground sm:min-h-9 sm:gap-1.5 sm:px-3 sm:text-xs"
              onClick={() => {
                detach(
                  submitFeedback(item.id, kind, signal),
                  Reason.DomCallback,
                );
              }}
            >
              <Icon aria-hidden className="size-3.5" />
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
