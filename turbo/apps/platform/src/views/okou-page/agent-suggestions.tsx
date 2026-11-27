import type { MouseEvent } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  Loader2,
  X,
  CircleCheck,
  CircleMinus,
  Clock,
  EyeOff,
  SquarePen,
  Send,
} from "lucide-react";
import { Button, buttonVariants, cn } from "@okouai/ui";
import type { SuggestionOption } from "@okouai/api-contracts/contracts/feed";
import {
  agentSuggestionEntries$,
  suggestionDirectionItemId$,
  type AgentSuggestionEntry,
  closeSettledSuggestion$,
  retryAgentSuggestion$,
  submitSuggestionFeedbackWithUndo$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  openSuggestionDirection$,
  startAgentSuggestion$,
  suggestionDirectionComposer$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { captureSuggestionCard } from "../../lib/posthog.ts";
import { Link } from "../router/link.tsx";
import { ForYouCardHeading } from "./for-you-card-heading.tsx";
import { ChatComposer } from "./composer.tsx";

// Option rows and the direction trigger share one shape. The rows and the
// feedback group hang out of the card's content box by this 16px inset, so
// their text lines up with the heading. Hover lays the state overlay over the
// row's own fill, so the row darkens instead of losing it.
const SUGGESTION_ROW =
  "h-auto min-h-14 w-full justify-between gap-3 whitespace-normal px-4 py-3 text-left text-sm font-normal [&:hover]:bg-state-hover-overlay";

// Option rows and the direction panel match the composer's 24px corners.
const SUGGESTION_ROW_RADIUS = "rounded-3xl";

// An option is a raised button on the card whose text can still be selected;
// the direction trigger stays a quiet input-like row in the muted fill, the
// gray ramp's Linen stop that the brand's Off White sits on. The option's
// outline is a real hairline border on a pointer-transparent layer, so it
// rounds to device pixels exactly like the feedback buttons' border beside it,
// yet takes no width: the label keeps the 16px inset the heading aligns to.
const SUGGESTION_OPTION =
  "relative bg-card text-foreground shadow-[0_1px_2px_rgb(37_33_33/0.04)] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-border hover:bg-card hover:shadow-surface hover:after:border-control-border";

const SUGGESTION_DIRECTION_TRIGGER =
  "bg-muted text-muted-foreground hover:bg-muted";

/**
 * A pointer click that leaves text selected inside the option ends a drag to
 * select that text, so it is not a choice; the next click chooses. Keyboard
 * activation has no pointer press and always chooses.
 */
function selectsOptionText(event: MouseEvent<HTMLElement>) {
  if (event.detail === 0) {
    return false;
  }
  const selection = event.currentTarget.ownerDocument.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    event.currentTarget.contains(
      selection.getRangeAt(0).commonAncestorContainer,
    )
  );
}

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
  return useGet(agentSuggestionEntries$).map((entry) => {
    return <SuggestionSaveError key={entry.item.id} entry={entry} />;
  });
}

function SuggestionDirectionEntry({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const open = useSet(openSuggestionDirection$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      type="button"
      variant="quiet"
      className={cn(
        SUGGESTION_ROW,
        SUGGESTION_ROW_RADIUS,
        SUGGESTION_DIRECTION_TRIGGER,
      )}
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
  const itemId = useGet(suggestionDirectionItemId$);
  return itemId === entry.item.id ? (
    <SuggestionDirectionComposer entry={entry} />
  ) : (
    <SuggestionDirectionEntry entry={entry} />
  );
}

function SuggestionDirectionComposer({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const prepared = useLoadable(suggestionDirectionComposer$);
  const open = useSet(openSuggestionDirection$);
  const signal = useGet(pageSignal$);
  const composer =
    prepared.state === "hasData" && prepared.data ? prepared.data : null;
  const ready = composer !== null || prepared.state === "hasError";
  return (
    <section
      aria-label={t(($) => {
        return $.chat.agentSuggestions.customPlaceholder;
      })}
      aria-busy={!ready}
      className="min-w-0"
    >
      {!ready && (
        <div
          className={cn(
            "flex min-h-14 items-center justify-center bg-muted",
            SUGGESTION_ROW_RADIUS,
          )}
        >
          <Loader2
            size={16}
            className="animate-spin text-muted-foreground"
            aria-hidden
          />
        </div>
      )}
      <div
        className={cn(
          "grid min-w-0",
          SUGGESTION_ROW_RADIUS,
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
            <div
              role="alert"
              className="px-3 pb-3 text-sm text-muted-foreground"
            >
              {prepared.error instanceof Error
                ? prepared.error.message
                : t(($) => {
                    return $.global.errors.requestFailed;
                  })}
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => {
                  detach(open(entry, signal), Reason.DomCallback);
                }}
              >
                {t(($) => {
                  return $.chat.errors.recovery.tryAgain;
                })}
              </Button>
            </div>
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

function SuggestionHeading({
  entry,
  active,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const { item } = entry;
  const show = useSet(entry.show$);
  const recordClick = () => {
    captureSuggestionCard({
      eventName: "suggestion_card_action_clicked",
      properties: { ...show(), action: "view_source" },
    });
  };
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
    <ForYouCardHeading
      id={item.id}
      title={item.content.title}
      description={item.content.rationale}
      active={active}
      source={
        sourceThreadId ? (
          <Link
            pathname={ROUTES.chat}
            onClick={recordClick}
            onAuxClick={(event) => {
              if (event.button === 1) {
                recordClick();
              }
            }}
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
  const signal = useGet(pageSignal$);
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className="flex flex-1 flex-col"
    >
      <SuggestionHeading entry={entry} active={active} />
      <div className="-mx-4 mt-5 mb-6 flex flex-col gap-3">
        {item.content.options.map((option, index) => {
          return (
            <Button
              key={option.id}
              type="button"
              variant="quiet"
              className={cn(
                SUGGESTION_ROW,
                SUGGESTION_ROW_RADIUS,
                SUGGESTION_OPTION,
                "select-text",
              )}
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
              onClick={(event) => {
                if (selectsOptionText(event)) {
                  return;
                }
                detach(
                  start(entry, option, index + 1, signal),
                  Reason.DomCallback,
                );
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
        return $.chat.agentSuggestions.done;
      }),
      Icon: CircleCheck,
    },
    {
      kind: "not_planned" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.wontDo;
      }),
      Icon: CircleMinus,
    },
    {
      kind: "later" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.later;
      }),
      Icon: Clock,
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
      className="-mx-4 mt-auto grid grid-cols-2 gap-2 @min-[42rem]/for-you:grid-cols-4"
    >
      {feedbackActions.map(({ kind, label, Icon }) => {
        return (
          <Button
            key={kind}
            type="button"
            variant="neutral"
            className="h-auto min-h-9 gap-1.5 rounded-xl border-border bg-card px-3 py-1.5 text-[13px] font-normal whitespace-normal [&_svg]:text-muted-foreground"
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
