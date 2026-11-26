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

// Writing a direction and folding it back move one set of rows: the offered
// directions and the editor's caption fold by their grid rows while the entry
// grows into the editor below them, all on one curve, so the actions keep
// their bottom edge and the text above follows every frame. A folded row stays
// out of sight and out of reach, and it is only clipped while it moves.
const FOLD =
  "grid motion-safe:transition-[grid-template-rows,visibility] duration-(--duration-for-you-fold) ease-capability";

function foldRow(open: boolean) {
  return open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]";
}

function foldClip(open: boolean) {
  return open
    ? "min-h-0 motion-safe:animate-for-you-fold-clip-open"
    : "min-h-0 overflow-clip motion-safe:animate-for-you-fold-clip-shut";
}

// What leaves fades first; what returns fades in once its room has opened.
function foldFade(open: boolean) {
  return cn(
    "ease-out motion-safe:transition-opacity",
    open ? "opacity-100 delay-120 duration-240" : "opacity-0 duration-120",
  );
}

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

/**
 * The entry rests where the editor opens. Once the editor exists it lies under
 * the entry folded to the entry's own size, so the entry gives up its fill
 * and outline to it and only its words fade, out as the editor grows and back
 * once it has folded. The fade sits on the contents so the button keeps its
 * own hover transitions.
 */
function SuggestionDirectionEntry({
  entry,
  over,
  busy,
  shown,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly over: boolean;
  readonly busy: boolean;
  readonly shown: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openSuggestionDirection$);
  const entryRef = useSet(suggestionDirectionEntryOnRef$);
  const signal = useGet(pageSignal$);
  return (
    <Button
      // Attached again each time the entry returns, so Escape can hand focus
      // back to it.
      ref={shown && !busy ? entryRef : undefined}
      type="button"
      variant="quiet"
      data-slot="suggestion-direction-entry"
      inert={!shown || busy}
      aria-hidden={!shown || undefined}
      aria-busy={busy || undefined}
      className={cn(
        DIRECTION_CARD,
        // Above the folded editor in their shared cell; see SuggestionDirection.
        "z-20 col-start-1 row-start-1 h-11 self-start px-4 text-sm font-normal text-muted-foreground",
        over &&
          "border-transparent bg-transparent hover:bg-transparent [&:hover]:bg-state-hover-overlay",
        !shown && "pointer-events-none",
        // Without an editor beneath it, as beside a failed one, it has its own
        // fill to put away.
        !shown && !over && "invisible",
      )}
      aria-description={t(($) => {
        return $.chat.agentSuggestions.customDirectionDescription;
      })}
      onClick={() => {
        detach(open(entry, signal), Reason.DomCallback);
      }}
    >
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-3",
          foldFade(shown),
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {t(($) => {
            return $.chat.agentSuggestions.customPlaceholder;
          })}
        </span>
        {busy ? (
          <Loader2 aria-hidden className="shrink-0 animate-spin" />
        ) : (
          <SquarePen aria-hidden className="shrink-0" />
        )}
      </span>
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

/** The editor's caption, with the control that folds it back into the entry. */
function SuggestionDirectionCaption({
  writing,
}: {
  readonly writing: boolean;
}) {
  const { t } = useTranslation();
  const fold = useSet(foldSuggestionDirection$);
  return (
    <div
      inert={!writing}
      aria-hidden={!writing || undefined}
      className={cn(FOLD, foldRow(writing))}
    >
      <div className={foldClip(writing)}>
        <div
          className={cn(
            "flex h-8.5 items-start justify-between gap-3",
            foldFade(writing),
          )}
        >
          <span
            aria-hidden
            className="flex h-7 items-center text-xs leading-4 font-medium text-muted-foreground"
          >
            {t(($) => {
              return $.chat.agentSuggestions.customPlaceholder;
            })}
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
      </div>
    </div>
  );
}

/**
 * The editor stays mounted while folded, so what was written stays; folded,
 * it lies under the entry at the entry's size, out of reach.
 */
function SuggestionDirectionComposer({
  entry,
  writing,
  prepared,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly writing: boolean;
  readonly prepared: DirectionComposerState;
}) {
  const { t } = useTranslation();
  const open = useSet(openSuggestionDirection$);
  const signal = useGet(pageSignal$);
  return (
    <section
      aria-label={t(($) => {
        return $.chat.agentSuggestions.customPlaceholder;
      })}
      inert={!writing}
      aria-hidden={!writing || undefined}
      className="col-start-1 row-start-1 min-w-0"
    >
      {prepared.state === "hasError" ? (
        <div
          role="alert"
          hidden={!writing}
          className="rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground"
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
      ) : prepared.composer ? (
        <div className="w-full min-w-0" data-chat-composer>
          <ChatComposer
            signals={prepared.composer}
            showPendingItems={false}
            layout="card"
            expanded={writing}
          />
          <FocusReopenedDirection composer={prepared.composer} />
        </div>
      ) : null}
    </section>
  );
}

type DirectionComposerState =
  | { readonly state: "loading"; readonly composer: null }
  | {
      readonly state: "hasError";
      readonly error: unknown;
      readonly composer: null;
    }
  | { readonly state: "hasData"; readonly composer: ComposerSignals | null };

/**
 * A card's own direction, written in place. The entry grows into the editor
 * while the offered directions fold away above it, and the editor folds back
 * into the entry the same way.
 */
function SuggestionDirection({
  entry,
  open,
  writing,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly open: boolean;
  readonly writing: boolean;
}) {
  const loadable = useLoadable(suggestionDirectionComposer$);
  const foldOnRef = useSet(foldSuggestionDirectionOnRef$);
  const prepared: DirectionComposerState =
    loadable.state === "hasData"
      ? { state: "hasData", composer: loadable.data }
      : loadable.state === "hasError"
        ? { state: "hasError", error: loadable.error, composer: null }
        : { state: "loading", composer: null };
  const ready = prepared.composer !== null || prepared.state === "hasError";
  // Until the editor is ready the entry stays and says it is working.
  const expanded = writing && ready;
  return (
    <div
      ref={open ? foldOnRef : undefined}
      data-slot="suggestion-direction"
      className="min-w-0"
    >
      {/* Mounted folded from the start, so the first opening folds it in
          like every later one. */}
      <SuggestionDirectionCaption writing={writing} />
      {/* The entry and the editor share one cell, the entry painted over the
          folded editor's card (which stacks at z-10). `isolate` keeps that
          order local to the cell. */}
      <div className="isolate grid min-w-0">
        {open && (
          <SuggestionDirectionComposer
            entry={entry}
            writing={writing}
            prepared={prepared}
          />
        )}
        <SuggestionDirectionEntry
          entry={entry}
          over={open && prepared.composer !== null}
          busy={writing && !ready}
          shown={!expanded}
        />
      </div>
    </div>
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
          <>
            <div
              inert={writing}
              aria-hidden={writing || undefined}
              className={cn(FOLD, foldRow(!writing))}
            >
              <div className={foldClip(!writing)}>
                <div
                  className={cn("flex flex-col gap-2 pb-2", foldFade(!writing))}
                >
                  {item.content.options.map((option, index) => {
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
                </div>
              </div>
            </div>
            {active && (
              <SuggestionDirection
                entry={entry}
                open={directionOpen}
                writing={writing}
              />
            )}
          </>
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
