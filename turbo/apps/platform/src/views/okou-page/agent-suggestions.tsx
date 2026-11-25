import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MessageSquare,
  X,
  CircleCheck,
  CircleMinus,
  BellOff,
  EyeOff,
  SquarePen,
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
  foldSuggestionDirection$,
  foldSuggestionDirectionOnRef$,
  openSuggestionDirection$,
  startAgentSuggestion$,
  suggestionDirectionComposer$,
  suggestionDirectionEntryOnRef$,
  suggestionDirectionFolded$,
  suggestionDirectionReopened$,
} from "../../signals/okou-page/agent-suggestions.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { captureSuggestionCard } from "../../lib/posthog.ts";
import { Link } from "../router/link.tsx";
import { ForYouCardLayout } from "./for-you-card-heading.tsx";
import { ChatComposer } from "./composer.tsx";

// Directions are white cards standing on the card's grey ground, a hairline
// each, so their outline shows without a shadow. Hover lays the state overlay
// over the card's own fill instead of replacing it.
const DIRECTION_CARD =
  "relative w-full rounded-xl border border-border bg-card text-foreground transition-[border-color,background-color,transform] duration-150 hover:bg-card [&:hover]:border-control-border [&:hover]:bg-state-hover-overlay focus-visible:ring-offset-muted dark:focus-visible:ring-offset-background";

/** The line above a direction's label says what choosing it does. */
function SuggestionOptionAction({
  option,
  chat,
}: {
  readonly option: SuggestionOption;
  readonly chat: string | null;
}) {
  const { t } = useTranslation();
  return (
    <span
      aria-hidden
      className={cn(
        "mb-1 flex min-w-0 items-center gap-1.5 text-xs leading-4 font-medium",
        option.threadId
          ? "text-muted-foreground"
          : "text-primary-700 dark:text-primary-200",
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">
        {option.threadId === null
          ? t(($) => {
              return $.chat.agentSuggestions.sendNew;
            })
          : chat
            ? t(
                ($) => {
                  return $.chat.agentSuggestions.draftIn;
                },
                { chat },
              )
            : t(($) => {
                return $.chat.agentSuggestions.draftInExistingChat;
              })}
      </span>
    </span>
  );
}

function SuggestionOptionContent({
  option,
  chat,
}: {
  readonly option: SuggestionOption;
  readonly chat: string | null;
}) {
  return (
    <span className="flex min-w-0 flex-col wrap-break-word">
      <SuggestionOptionAction option={option} chat={chat} />
      <span className="text-sm leading-5 font-medium">{option.label}</span>
      {option.description && (
        <span className="mt-0.5 text-sm leading-5 text-muted-foreground">
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
  const entryRef = useSet(suggestionDirectionEntryOnRef$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      ref={entryRef}
      type="button"
      variant="quiet"
      className={cn(
        DIRECTION_CARD,
        "h-11 justify-between gap-3 px-4 text-sm font-normal text-muted-foreground",
      )}
      aria-description={t(($) => {
        return $.chat.agentSuggestions.customDirectionDescription;
      })}
      onClick={() => {
        detach(open(entry, signal), Reason.DomCallback);
      }}
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {t(($) => {
          return $.chat.agentSuggestions.customPlaceholder;
        })}
      </span>
      <SquarePen aria-hidden className="shrink-0" />
    </Button>
  );
}

/** Shows the editor again where it was folded and puts the caret back in it. */
function FocusReopenedDirection({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const reopened = useGet(suggestionDirectionReopened$);
  const focus = useSet(composer.editor.focus$);
  return (
    <span
      key={reopened}
      hidden
      ref={(node) => {
        if (node && reopened > 0) {
          focus();
        }
      }}
    />
  );
}

function SuggestionDirectionComposer({
  entry,
  folded,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly folded: boolean;
}) {
  const { t } = useTranslation();
  const prepared = useLoadable(suggestionDirectionComposer$);
  const open = useSet(openSuggestionDirection$);
  const signal = useGet(pageSignal$);
  const fold = useSet(foldSuggestionDirection$);
  const foldOnRef = useSet(foldSuggestionDirectionOnRef$);
  const composer =
    prepared.state === "hasData" && prepared.data ? prepared.data : null;
  const ready = composer !== null || prepared.state === "hasError";
  const label = t(($) => {
    return $.chat.agentSuggestions.customPlaceholder;
  });
  // Folded, the editor stays mounted and hidden, so what was written stays.
  return (
    <section
      ref={foldOnRef}
      aria-label={label}
      aria-busy={!ready}
      hidden={folded}
      className="min-w-0"
    >
      <div className="mb-1.5 flex h-7 items-center justify-between gap-3">
        <span
          aria-hidden
          className="text-xs leading-4 font-medium text-muted-foreground"
        >
          {label}
        </span>
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          className="-mr-1.5"
          aria-label={t(($) => {
            return $.chat.agentSuggestions.collapseDirection;
          })}
          onClick={() => {
            fold(false);
          }}
        >
          <ChevronDown />
        </Button>
      </div>
      {!ready && (
        <div className="flex min-h-14 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2
            size={16}
            className="animate-spin text-muted-foreground"
            aria-hidden
          />
        </div>
      )}
      <div
        className={cn(
          "grid min-w-0 rounded-xl",
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
              <FocusReopenedDirection composer={composer} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** The chat a card came from, which a draft in that chat lands in. */
function suggestionSource(item: AgentSuggestionEntry["item"]) {
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
  const threadId =
    sourceOption?.threadId ??
    (sourcePart?.type === "chat_thread" ? sourcePart.threadId : null);
  const title =
    sourcePart?.type === "chat_thread" && sourcePart.threadId === threadId
      ? sourcePart.titleSnapshot
      : null;
  return { threadId, title };
}

function optionChatTitle(option: SuggestionOption) {
  const part = (option.draft.draftUserMessage?.parts ?? []).find(
    (candidate) => {
      return (
        candidate.type === "chat_thread" &&
        candidate.threadId === option.threadId
      );
    },
  );
  return part?.type === "chat_thread" ? part.titleSnapshot : null;
}

function SuggestionSource({ entry }: { readonly entry: AgentSuggestionEntry }) {
  const { t } = useTranslation();
  const show = useSet(entry.show$);
  const recordClick = () => {
    captureSuggestionCard({
      eventName: "suggestion_card_action_clicked",
      properties: { ...show(), action: "view_source" },
    });
  };
  const source = suggestionSource(entry.item);
  if (!source.threadId) {
    return null;
  }
  return (
    <Link
      pathname={ROUTES.chat}
      onClick={recordClick}
      onAuxClick={(event) => {
        if (event.button === 1) {
          recordClick();
        }
      }}
      options={{ pathParams: { threadId: source.threadId } }}
      className="group/source inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-xs leading-4 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t(($) => {
        return $.chat.agentSuggestions.viewSource;
      })}
    >
      <MessageSquare aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate underline decoration-transparent underline-offset-3 transition-[text-decoration-color] group-hover/source:decoration-control-border">
        {source.title ??
          t(($) => {
            return $.chat.agentSuggestions.viewSource;
          })}
      </span>
    </Link>
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
  const directionItemId = useGet(suggestionDirectionItemId$);
  const folded = useGet(suggestionDirectionFolded$);
  const signal = useGet(pageSignal$);
  const directionOpen = active && directionItemId === item.id;
  // While the member writes their own direction, the card keeps its heading
  // as the context and the offered directions step aside.
  const writing = directionOpen && !folded;
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ForYouCardLayout
        id={item.id}
        title={item.content.title}
        description={item.content.rationale}
        active={active}
        source={<SuggestionSource entry={entry} />}
        dismiss={
          <Button
            type="button"
            variant="quiet"
            size="icon-xs"
            showTooltip
            aria-label={t(($) => {
              return $.chat.agentSuggestions.dismiss;
            })}
            onClick={() => {
              detach(
                submitFeedback(item.id, "dismissed", signal),
                Reason.DomCallback,
              );
            }}
          >
            <X />
          </Button>
        }
        actions={
          <div className="flex flex-col gap-2">
            {!writing &&
              item.content.options.map((option, index) => {
                return (
                  <Button
                    key={option.id}
                    type="button"
                    variant="quiet"
                    className={cn(
                      DIRECTION_CARD,
                      "block h-auto px-4 py-3 text-left font-normal whitespace-normal active:scale-[0.99]",
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
                    onClick={() => {
                      detach(
                        start(entry, option, index + 1, signal),
                        Reason.DomCallback,
                      );
                    }}
                  >
                    <SuggestionOptionContent
                      option={option}
                      chat={optionChatTitle(option)}
                    />
                  </Button>
                );
              })}
            {active && (!directionOpen || folded) && (
              <SuggestionDirectionEntry entry={entry} />
            )}
            {directionOpen && (
              <SuggestionDirectionComposer entry={entry} folded={folded} />
            )}
          </div>
        }
        footer={<SuggestionFeedback entry={entry} />}
      />
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
  // Turning a suggestion down is quieter than taking it: caption-size quiet
  // actions in the card's footer, two by two when the card is narrow.
  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.chat.agentSuggestions.feedbackPrompt;
      })}
      className="flex flex-wrap gap-1 @max-[30rem]/suggestion:grid @max-[30rem]/suggestion:grid-cols-2"
    >
      {feedbackActions.map(({ kind, label, Icon }) => {
        return (
          <Button
            key={kind}
            type="button"
            variant="quiet"
            size="xs"
            className="h-7 justify-start gap-1.5 px-2 text-xs font-medium [&_svg]:size-3.5"
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
