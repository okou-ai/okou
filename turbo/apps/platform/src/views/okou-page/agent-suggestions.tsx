import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  Loader2,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  X,
  CircleCheck,
  CircleMinus,
  SlidersHorizontal,
  Ellipsis,
  Sparkles,
} from "lucide-react";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/feed";
import {
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  RadioGroup,
  Textarea,
} from "@okouai/ui";
import { defaultAgentId$, defaultAgentName$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  agentSuggestionListItems$,
  submitAgentSuggestionFeedback$,
  suggestionFeedbackReasonOpen$,
  closeSettledSuggestion$,
  openSuggestionFeedbackReason$,
  undoSuggestionFeedback$,
  saveSuggestionFeedbackReason$,
  retryAgentSuggestion$,
  type SuggestionOutcome,
  homeSuggestionCard$,
  showHomeSuggestion$,
  setHomeSuggestionDetailsOpen$,
  submitHomeSuggestionFeedback$,
  focusSuggestionTitleOnRef$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  agentSuggestionComposerItem$,
  closeAgentSuggestionComposer$,
  openAgentSuggestionComposer$,
  startAgentSuggestion$,
} from "../../signals/okou-page/agent-suggestions.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ChatComposer } from "./composer.tsx";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { SuggestionsComplete } from "./suggestions-complete.tsx";

const SUGGESTION_ACTION =
  "min-h-11 shrink-0 gap-1 whitespace-nowrap px-0.5 text-xs font-normal @min-[521px]/suggestion:min-h-9 @min-[521px]/suggestion:gap-2 @min-[521px]/suggestion:px-2";

function AgentSuggestionOption({
  option,
  onClick,
  custom = false,
}: {
  readonly option: Pick<SuggestionOption, "label" | "description" | "threadId">;
  readonly custom?: boolean;
  readonly onClick: () => void;
}) {
  const label = option.label;
  return (
    <Button
      type="button"
      variant="neutral"
      className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal rounded-lg border-border bg-card px-3 py-2.5 text-left font-normal"
      aria-label={label}
      aria-description={option.description}
      onClick={onClick}
    >
      {custom ? (
        <MessageCircle aria-hidden className="text-muted-foreground" />
      ) : option.threadId ? (
        <MessageSquare aria-hidden className="text-muted-foreground" />
      ) : (
        <MessageSquarePlus aria-hidden className="text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5">{label}</span>
        {option.description && (
          <span className="text-xs leading-5 text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      <ArrowRight aria-hidden className="text-muted-foreground" />
    </Button>
  );
}

function CustomDirectionOption({ onClick }: { readonly onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <AgentSuggestionOption
      custom
      option={{
        threadId: null,
        label: t(($) => {
          return $.chat.agentSuggestions.customDirection;
        }),
        description: t(($) => {
          return $.chat.agentSuggestions.customDirectionDescription;
        }),
      }}
      onClick={onClick}
    />
  );
}

function SuggestionFeedbackReason({
  feedbackId,
  initialNote,
  onSave,
}: {
  readonly feedbackId: string;
  readonly initialNote: string;
  readonly onSave: (note: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <form
      key={feedbackId}
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const note = new FormData(event.currentTarget).get("reason");
        if (typeof note === "string" && note.trim()) {
          onSave(note.trim());
        }
      }}
    >
      <label
        htmlFor={`feedback-reason-${feedbackId}`}
        className="text-xs text-muted-foreground"
      >
        {t(($) => {
          return $.chat.agentSuggestions.reasonLabel;
        })}
      </label>
      <Textarea
        id={`feedback-reason-${feedbackId}`}
        name="reason"
        defaultValue={initialNote}
        maxLength={512}
        required
        rows={2}
      />
      <Button type="submit" variant="neutral" size="sm" className="self-end">
        {t(($) => {
          return $.chat.agentSuggestions.saveReason;
        })}
      </Button>
    </form>
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

function SuggestionFeedbackNotice({
  entry,
  feedback,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly feedback: Extract<SuggestionOutcome, { type: "feedback" }>;
}) {
  const { t } = useTranslation();
  const reasonOpen = useGet(suggestionFeedbackReasonOpen$) === entry;
  const openReason = useSet(openSuggestionFeedbackReason$);
  const undo = useSet(undoSuggestionFeedback$);
  const save = useSet(saveSuggestionFeedbackReason$);
  const signal = useGet(pageSignal$);
  const message =
    feedback.kind === "already_done"
      ? t(($) => {
          return $.chat.agentSuggestions.doneRecorded;
        })
      : feedback.kind === "not_planned"
        ? t(($) => {
            return $.chat.agentSuggestions.notPlannedRecorded;
          })
        : feedback.kind === "less_like_this"
          ? t(($) => {
              return $.chat.agentSuggestions.lessRecorded;
            })
          : t(($) => {
              return $.chat.agentSuggestions.dismissRecorded;
            });
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Check aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p
          role="status"
          className="flex-1 text-sm leading-5 text-muted-foreground"
        >
          {message}
        </p>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => {
            detach(undo(entry, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.agentSuggestions.undoFeedback;
          })}
        </Button>
        <CloseSettledSuggestion entry={entry} />
      </div>
      <SettledSuggestionTitle title={entry.item.content.title} />
      {feedback.kind !== "dismissed" && !reasonOpen && (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => {
            openReason(entry);
          }}
        >
          {feedback.reasonSaved
            ? t(($) => {
                return $.chat.agentSuggestions.editReason;
              })
            : t(($) => {
                return $.chat.agentSuggestions.addReason;
              })}
        </Button>
      )}
      {reasonOpen && (
        <SuggestionFeedbackReason
          feedbackId={feedback.id}
          initialNote={feedback.note}
          onSave={(note) => {
            detach(save(entry, note, signal), Reason.DomCallback);
          }}
        />
      )}
    </div>
  );
}

function SuggestionSentNotice({
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

function SettledSuggestion({
  entry,
  outcome,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly outcome: SuggestionOutcome;
}) {
  return outcome.type === "feedback" ? (
    <SuggestionFeedbackNotice entry={entry} feedback={outcome} />
  ) : (
    <SuggestionSentNotice entry={entry} threadId={outcome.threadId} />
  );
}

type FeedbackKind = "already_done" | "not_planned" | "less_like_this";
function AgentSuggestionActions({
  onDismiss,
  onSelect,
}: {
  readonly onDismiss: () => void;
  readonly onSelect: (kind: FeedbackKind) => void;
}) {
  const { t } = useTranslation();
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
      kind: "less_like_this" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.lessLikeThis;
      }),
      Icon: SlidersHorizontal,
    },
  ];
  return (
    <div className="flex flex-nowrap items-center justify-start gap-1 overflow-x-auto border-t border-border pt-2">
      <Button
        type="button"
        variant="quiet"
        className={SUGGESTION_ACTION}
        onClick={onDismiss}
      >
        <X aria-hidden className="hidden @min-[521px]/suggestion:block" />
        {t(($) => {
          return $.chat.agentSuggestions.dismiss;
        })}
      </Button>
      {feedbackActions.map(({ kind, label, Icon }) => {
        return (
          <Button
            key={kind}
            type="button"
            variant="quiet"
            className={SUGGESTION_ACTION}
            onClick={() => {
              onSelect(kind);
            }}
          >
            <Icon
              aria-hidden
              className="hidden @min-[521px]/suggestion:block"
            />
            {label}
          </Button>
        );
      })}
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

type ComposerPreparation =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "hasData"; readonly data: ComposerSignals }
  | { readonly state: "hasError"; readonly error: unknown };

/**
 * The custom direction is written over home, like a forward: the default
 * Agent receives it in a new thread and the member stays on the next card.
 */
function AgentSuggestionComposerDialog({
  composer,
}: {
  readonly composer: ComposerPreparation;
}) {
  const { t } = useTranslation();
  const item = useGet(agentSuggestionComposerItem$);
  const close = useSet(closeAgentSuggestionComposer$);
  const agentId = useLastResolved(defaultAgentId$);
  const assistantName = useGet(assistantName$);
  const agentName = useLastResolved(defaultAgentName$) ?? assistantName;
  if (!item) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        smMaxWidth="xl"
        contentClassName="grid-cols-[minmax(0,1fr)] gap-4 overflow-hidden p-5"
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="min-w-0 overflow-hidden pr-8 text-base font-semibold">
            <span className="flex min-w-0 items-center gap-2">
              {agentId ? (
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                />
              ) : null}
              <span className="truncate text-foreground">{agentName}</span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(($) => {
              return $.chat.agentSuggestions.customDirectionDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {composer.state === "hasData" ? (
          <div className="w-full min-w-0" data-chat-composer>
            <ChatComposer signals={composer.data} showPendingItems={false} />
          </div>
        ) : composer.state === "hasError" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {composer.error instanceof Error
              ? composer.error.message
              : t(($) => {
                  return $.global.errors.requestFailed;
                })}
          </p>
        ) : (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AgentSuggestionCard({
  item,
  onCustomDirection,
  embedded = false,
}: {
  readonly item: Suggestion;
  readonly onCustomDirection: (item: Suggestion) => void;
  readonly embedded?: boolean;
}) {
  const start = useSet(startAgentSuggestion$);
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const submitFeedback = useSet(
    embedded ? submitHomeSuggestionFeedback$ : submitAgentSuggestionFeedback$,
  );
  const signal = useGet(pageSignal$);
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className={cn(
        "flex flex-col gap-3",
        !embedded && "rounded-xl border border-border bg-card px-5 py-4",
      )}
    >
      <div className="flex flex-col gap-3 motion-safe:animate-composer-panel-in">
        <div className="flex flex-col gap-2">
          <h3
            id={`suggestion-title-${item.id}`}
            ref={embedded ? focusTitle : undefined}
            tabIndex={embedded ? -1 : undefined}
            className="text-base font-medium leading-6 text-foreground focus:outline-none"
          >
            {item.content.title}
          </h3>
          <p
            className={cn(
              "text-sm leading-5 text-muted-foreground",
              !embedded && "line-clamp-4",
            )}
          >
            {item.content.rationale}
          </p>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          {item.content.options.map((option) => {
            return (
              <AgentSuggestionOption
                key={option.id}
                option={option}
                onClick={() => {
                  detach(start(item.id, option.id, signal), Reason.DomCallback);
                }}
              />
            );
          })}
          <CustomDirectionOption
            onClick={() => {
              onCustomDirection(item);
            }}
          />
          <AgentSuggestionActions
            onDismiss={() => {
              detach(
                submitFeedback(item.id, "dismissed", signal),
                Reason.DomCallback,
              );
            }}
            onSelect={(kind) => {
              detach(submitFeedback(item.id, kind, signal), Reason.DomCallback);
            }}
          />
        </div>
      </div>
    </article>
  );
}

function HomeSuggestionFeedback({ item }: { readonly item: Suggestion }) {
  const { t } = useTranslation();
  const submitFeedback = useSet(submitHomeSuggestionFeedback$);
  const signal = useGet(pageSignal$);
  const feedbackLabel = t(($) => {
    return $.chat.agentSuggestions.homeCard.feedback;
  });
  const feedbackCopy = t(
    ($) => {
      return $.chat.agentSuggestions;
    },
    { returnObjects: true },
  );
  const feedbackActions = [
    { kind: "dismissed", label: feedbackCopy.dismiss, Icon: X },
    {
      kind: "already_done",
      label: feedbackCopy.alreadyDone,
      Icon: CircleCheck,
    },
    { kind: "not_planned", label: feedbackCopy.notPlanned, Icon: CircleMinus },
    {
      kind: "less_like_this",
      label: feedbackCopy.lessLikeThis,
      Icon: SlidersHorizontal,
    },
  ] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={feedbackLabel}
            className="size-7 shrink-0 text-muted-foreground pointer-coarse:size-11 [&_svg]:size-4"
          />
        }
      >
        <Ellipsis aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {feedbackActions.map(({ kind, label: actionLabel, Icon }) => {
          return (
            <DropdownMenuItem
              key={kind}
              onClick={() => {
                detach(
                  submitFeedback(item.id, kind, signal),
                  Reason.DomCallback,
                );
              }}
            >
              <Icon aria-hidden />
              {actionLabel}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One segment per waiting suggestion, as a radio group: the shared group owns
 * the single tab stop, arrow keys and selection. The current segment fills over
 * the suggestion's turn and then shows the next, wrapping to the first. It
 * pauses while the pointer or focus is on the greeting and while the review is
 * open. Choosing a segment shows its suggestion and starts its turn.
 */
function HomeSuggestionProgress({
  itemId,
  index,
  count,
}: {
  readonly itemId: string;
  readonly index: number;
  readonly count: number;
}) {
  const { t } = useTranslation();
  const show = useSet(showHomeSuggestion$);
  const signal = useGet(pageSignal$);
  const select = (position: number) => {
    detach(show(position, signal), Reason.DomCallback);
  };
  return (
    <RadioGroup
      aria-label={t(($) => {
        return $.chat.agentSuggestions.homeCard.navigation;
      })}
      value={index}
      onValueChange={(position: number) => {
        select(position);
      }}
      className="pointer-events-auto flex min-w-0 items-center gap-1"
    >
      {Array.from({ length: count }, (_, position) => {
        return (
          <RadioPrimitive.Root
            key={position}
            value={position}
            nativeButton
            render={<button type="button" />}
            aria-label={t(
              ($) => {
                return $.chat.agentSuggestions.homeCard.show;
              },
              { index: position + 1, total: count },
            )}
            className="flex h-6 shrink-0 items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="block h-[3px] w-4 overflow-hidden rounded-full bg-foreground/12">
              {position === index && (
                <span
                  key={itemId}
                  data-testid="suggestion-progress"
                  // Every pause is a group variant. A bare play-state utility
                  // would lose to the `animation` shorthand that
                  // `motion-safe:animate-*` emits later at the same
                  // specificity; the group variants outrank it.
                  className="block size-full bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-foreground)_55%,transparent)_calc(var(--okou-suggestion-progress)_*_(100%_+_1px)_-_1px),transparent_calc(var(--okou-suggestion-progress)_*_(100%_+_1px)))] motion-safe:animate-suggestion-progress group-hover/suggestion:[animation-play-state:paused] group-focus-within/suggestion:[animation-play-state:paused] group-data-[paused]/suggestion:[animation-play-state:paused]"
                  onAnimationEnd={() => {
                    select(index + 1);
                  }}
                />
              )}
            </span>
          </RadioPrimitive.Root>
        );
      })}
    </RadioGroup>
  );
}

/**
 * The greeting's line while suggestions wait. The whole line opens the review;
 * the progress segments and the feedback menu sit above that trigger. The
 * trigger reaches 8px past the line on each side, so its focus ring clears the
 * text instead of cutting into its first glyph.
 *
 * On the session's first home the line takes the greeting's own entrance,
 * one 70ms step after the avatar: the eyebrow at 70ms, the title at 140ms. Its
 * end completes the greeting entrance, because the tagline that would
 * otherwise complete it is not on the page. Later titles rise in briefly as
 * the rotation reaches them.
 */
function HomeSuggestionPreview({
  item,
  index,
  count,
  paused,
  entrance,
  onEntranceEnd,
}: {
  readonly item: Suggestion;
  readonly index: number;
  readonly count: number;
  readonly paused: boolean;
  readonly entrance: boolean;
  readonly onEntranceEnd: () => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.agentSuggestions.label;
  });
  return (
    <section
      aria-label={label}
      data-paused={paused || undefined}
      className="group/suggestion relative isolate flex min-h-14 min-w-0 flex-1 items-center gap-4"
    >
      <DialogTrigger
        render={
          <Button
            variant="quiet"
            aria-label={item.content.title}
            className="absolute -inset-x-2 inset-y-0 z-0 h-auto w-auto rounded-surface-compact p-0 hover:bg-transparent active:bg-transparent focus-visible:ring-inset motion-reduce:transition-none"
          />
        }
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col gap-1">
        <div
          className={cn(
            "flex h-4 min-w-0 items-center gap-2.5",
            entrance && "motion-safe:animate-chat-greeting-token",
          )}
          style={entrance ? { animationDelay: "70ms" } : undefined}
        >
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium leading-4 text-muted-foreground">
            <Sparkles
              aria-hidden
              className="size-3.5 shrink-0 text-brand-text"
            />
            {label}
          </span>
          {count > 1 && (
            <HomeSuggestionProgress
              itemId={item.id}
              index={index}
              count={count}
            />
          )}
        </div>
        <h2
          key={item.id}
          className={cn(
            "truncate text-xl font-medium leading-7 text-foreground",
            entrance
              ? "motion-safe:animate-chat-greeting-token"
              : "motion-safe:animate-suggestion-title-in",
          )}
          style={entrance ? { animationDelay: "140ms" } : undefined}
          onAnimationEnd={(event) => {
            if (entrance && event.animationName === "chat-greeting-token") {
              onEntranceEnd();
            }
          }}
        >
          {item.content.title}
        </h2>
      </div>
      {/* The menu stays out of the line until the pointer or focus reaches it,
          and while its own popup is open. Touch has no hover, so it stays. */}
      <div className="relative z-20 shrink-0 opacity-0 transition-opacity duration-150 group-hover/suggestion:opacity-100 group-focus-within/suggestion:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
        <HomeSuggestionFeedback item={item} />
      </div>
    </section>
  );
}

function HomeSuggestionDetails() {
  const { t } = useTranslation();
  const card = useLastResolved(homeSuggestionCard$);
  const [composer, openComposer] = useLoadableSet(openAgentSuggestionComposer$);
  const signal = useGet(pageSignal$);
  return (
    <DialogContent
      maxWidth={640}
      hideWhenNestedOpen
      aria-describedby={undefined}
      contentClassName="@container/suggestion flex flex-col gap-4 p-5 sm:p-6"
    >
      <DialogHeader className="flex-row items-baseline justify-start gap-3 space-y-0 pr-10">
        <DialogTitle>
          {t(($) => {
            return $.chat.agentSuggestions.feedLabel;
          })}
        </DialogTitle>
        {card?.detail && (
          <span className="shrink-0 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
            {card.detailIndex + 1} / {card.detailCount}
          </span>
        )}
      </DialogHeader>
      {card?.complete ? (
        <SuggestionsComplete />
      ) : card?.detail ? (
        <div key={card.detail.entry.item.id}>
          {card.detail.outcome ? (
            <SettledSuggestion
              entry={card.detail.entry}
              outcome={card.detail.outcome}
            />
          ) : (
            <AgentSuggestionCard
              embedded
              item={card.detail.entry.item}
              onCustomDirection={(suggestion) => {
                detach(openComposer(suggestion.id, signal), Reason.DomCallback);
              }}
            />
          )}
          <SuggestionSaveError entry={card.detail.entry} />
        </div>
      ) : null}
      <AgentSuggestionComposerDialog composer={composer} />
    </DialogContent>
  );
}

/**
 * While suggestions wait, the greeting's line is the current suggestion, so it
 * takes the page's most prominent place without adding height. Otherwise, and
 * until they load, the greeting keeps its own line. The review dialog stays
 * mounted either way, so it can finish on "All caught up" after the last card.
 */
export function HomeSuggestionGreeting({
  fallback,
  entrance,
  onEntranceEnd,
}: {
  readonly fallback: ReactNode;
  readonly entrance: boolean;
  readonly onEntranceEnd: () => void;
}) {
  const result = useLastLoadable(homeSuggestionCard$);
  const setDetailsOpen = useSet(setHomeSuggestionDetailsOpen$);
  const signal = useGet(pageSignal$);
  const card = result.state === "hasData" ? result.data : undefined;
  return (
    <Dialog
      open={card?.detailsOpen ?? false}
      onOpenChange={(open) => {
        detach(setDetailsOpen(open, signal), Reason.DomCallback);
      }}
    >
      {card?.item ? (
        <HomeSuggestionPreview
          item={card.item}
          index={card.index}
          count={card.count}
          paused={card.detailsOpen}
          entrance={entrance}
          onEntranceEnd={onEntranceEnd}
        />
      ) : (
        fallback
      )}
      <HomeSuggestionDetails />
    </Dialog>
  );
}

/**
 * The default Agent's suggestion cards, listed under its new-chat entries.
 * Nothing shows while they load or once the list is empty.
 */
export function AgentSuggestions({
  className,
}: {
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const result = useLastLoadable(agentSuggestionListItems$);
  const [composer, openComposer] = useLoadableSet(openAgentSuggestionComposer$);
  const signal = useGet(pageSignal$);
  const openCustomDirection = (item: Suggestion) => {
    detach(openComposer(item.id, signal), Reason.DomCallback);
  };
  if (result.state === "hasError") {
    return (
      <p
        role="alert"
        className={cn("text-sm text-muted-foreground", className)}
      >
        {t(($) => {
          return $.global.errors.requestFailed;
        })}
      </p>
    );
  }
  if (result.state !== "hasData" || result.data.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="agent-suggestions-title"
      className={cn("flex flex-col gap-3", className)}
    >
      <h2
        id="agent-suggestions-title"
        className="text-xl font-medium tracking-tight"
      >
        {t(($) => {
          return $.chat.agentSuggestions.feedLabel;
        })}
      </h2>
      {/* Handled cards follow the waiting ones in the order handled. */}
      <ul className="flex flex-col gap-4">
        {result.data.map(({ entry, outcome }) => {
          return (
            <li
              key={entry.item.id}
              className="@container/suggestion relative min-w-0"
            >
              {outcome ? (
                <SettledSuggestion entry={entry} outcome={outcome} />
              ) : (
                <AgentSuggestionCard
                  item={entry.item}
                  onCustomDirection={openCustomDirection}
                />
              )}
            </li>
          );
        })}
      </ul>
      <AgentSuggestionComposerDialog composer={composer} />
    </section>
  );
}
