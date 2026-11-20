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
} from "lucide-react";
import { Button, buttonVariants, cn } from "@okouai/ui";
import type { SuggestionOption } from "@okouai/api-contracts/contracts/feed";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  closeSettledSuggestion$,
  retryAgentSuggestion$,
  submitSuggestionFeedbackWithUndo$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  collapseSuggestionDirection$,
  restoreDirectionFocusOnRef$,
  openSuggestionDirection$,
  startAgentSuggestion$,
  suggestionDirection$,
  suggestionDirectionComposer$,
  type SuggestionDirectionTarget,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ForYouCardHeading } from "./for-you-card-heading.tsx";
import { ChatComposer } from "./composer.tsx";

// Option rows and the direction trigger share one surface. Hover lays the state
// overlay over the nested fill, so the row darkens instead of losing its fill.
const SUGGESTION_ROW =
  "h-auto min-h-13 w-full justify-between gap-3 whitespace-normal rounded-3xl bg-nested-fill px-5 py-3 text-left text-sm font-normal hover:bg-nested-fill [&:hover]:bg-state-hover-overlay";

function SuggestionOptionContent({
  option,
}: {
  readonly option: SuggestionOption;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-break-word">
      <span className="leading-6">{option.label}</span>
      {option.description && (
        <span className="text-[13px] leading-5 text-muted-foreground">
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
      className={cn(SUGGESTION_ROW, "text-muted-foreground")}
      aria-description={t(($) => {
        return $.chat.agentSuggestions.customDirectionDescription;
      })}
      onClick={() => {
        detach(open(entry, signal), Reason.DomCallback);
      }}
    >
      <span className="min-w-0 flex-1 leading-6">
        {t(($) => {
          return $.chat.agentSuggestions.customPlaceholder;
        })}
      </span>
      <SquarePen aria-hidden className="shrink-0 text-muted-foreground" />
    </Button>
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

/**
 * The card's own composer opens in place of the direction trigger, as an
 * accordion: the row keeps its fill and becomes a header that names the chat
 * the direction goes to, with the close control in the column the trigger's
 * icon used. The composer grows in beneath it once it is ready and fills the
 * row's width, so the heading, the quote and the caret share the option text's
 * left edge and the composer keeps its standard radius.
 */
function SuggestionDirectionComposer({
  direction,
}: {
  readonly direction: {
    readonly itemId: string;
    readonly target: SuggestionDirectionTarget;
  };
}) {
  const { t } = useTranslation();
  const headingId = `suggestion-direction-heading-${direction.itemId}`;
  const prepared = useLoadable(suggestionDirectionComposer$);
  const close = useSet(collapseSuggestionDirection$);
  const { target } = direction;
  const newChatTitle = t(($) => {
    return $.chat.newChat;
  });
  const composer =
    prepared.state === "hasData" && prepared.data ? prepared.data : null;
  const ready = composer !== null || prepared.state === "hasError";
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-3xl bg-nested-fill"
    >
      <div className="flex min-h-12 min-w-0 items-center gap-2 pr-2 pl-4">
        <h3
          id={headingId}
          className="min-w-0 flex-1 truncate text-base leading-6 font-normal text-foreground"
        >
          {target.kind === "thread"
            ? (target.title ?? newChatTitle)
            : newChatTitle}
        </h3>
        {!ready && (
          <Loader2
            size={16}
            className="shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
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
      <div
        className={cn(
          "grid min-w-0",
          ready
            ? "grid-rows-[1fr] motion-safe:animate-suggestion-direction-expand"
            : "grid-rows-[0fr] overflow-clip",
        )}
      >
        <div
          className={cn(
            "min-h-0 min-w-0",
            ready && "motion-safe:animate-suggestion-direction-content-in",
          )}
        >
          {prepared.state === "hasError" ? (
            <p role="alert" className="px-3 pb-3 text-sm text-muted-foreground">
              {prepared.error instanceof Error
                ? prepared.error.message
                : t(($) => {
                    return $.global.errors.requestFailed;
                  })}
            </p>
          ) : composer ? (
            <div className="w-full min-w-0" data-chat-composer>
              <ChatComposer
                signals={composer}
                showPendingItems={false}
                layout="card"
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function AgentSuggestionCard({
  entry,
  active,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly active: boolean;
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
              className="-mx-1.5 -my-0.5 inline-block max-w-full truncate rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground underline decoration-border underline-offset-4 hover:bg-state-hover hover:text-foreground"
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
      <div className="mb-7 mt-7 flex flex-col gap-2.5">
        {item.content.options.map((option) => {
          return (
            <Button
              key={option.id}
              type="button"
              variant="quiet"
              className={cn(SUGGESTION_ROW, "text-foreground")}
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
      {/* Dismissing closes the whole card, so it sits on the card's corner.
          It comes last so ordinary paint order keeps it above the artwork. */}
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        showTooltip
        aria-label={t(($) => {
          return $.chat.agentSuggestions.dismiss;
        })}
        className="absolute top-4.5 right-4 sm:top-7.5 sm:right-7"
        onClick={() => {
          detach(
            submitFeedback(item.id, "dismissed", signal),
            Reason.DomCallback,
          );
        }}
      >
        <X />
      </Button>
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
    <div
      role="group"
      aria-label={t(($) => {
        return $.chat.agentSuggestions.feedbackPrompt;
      })}
      className="mt-auto grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {feedbackActions.map(({ kind, label, Icon }) => {
        return (
          <Button
            key={kind}
            type="button"
            variant="neutral"
            className="h-auto min-h-9 gap-1.5 rounded-3xl border-divider px-3 py-1.5 text-[13px] font-normal whitespace-normal [&_svg]:text-muted-foreground"
            onClick={() => {
              detach(submitFeedback(item.id, kind, signal), Reason.DomCallback);
            }}
          >
            <Icon aria-hidden />
            {label}
          </Button>
        );
      })}
    </div>
  );
}
