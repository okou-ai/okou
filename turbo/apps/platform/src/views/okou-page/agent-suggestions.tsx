import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MessageSquarePlus,
  X,
  CircleCheck,
  CircleMinus,
  SlidersHorizontal,
} from "lucide-react";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
import { Button, Textarea } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  agentSuggestionIndex$,
  agentSuggestionMotion$,
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  showAgentSuggestion$,
  visibleAgentSuggestions$,
  submitAgentSuggestionFeedback$,
  suggestionFeedbackConfirmation$,
  suggestionFeedbackReasonOpen$,
  closeSuggestionFeedback$,
  openSuggestionFeedbackReason$,
  undoSuggestionFeedback$,
  saveSuggestionFeedbackReason$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  prepareAgentSuggestion$,
  preparedAgentSuggestionId$,
  startAgentSuggestion$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

const PAGER = "data-disabled:pointer-events-none data-disabled:opacity-50";
const DECK_EDGE =
  "pointer-events-none absolute h-10 rounded-xl border border-border bg-card";
const SUGGESTION_ACTION =
  "min-h-11 shrink-0 gap-1 whitespace-nowrap px-0.5 text-xs font-normal @min-[521px]/suggestion:min-h-9 @min-[521px]/suggestion:gap-2 @min-[521px]/suggestion:px-2";

function AgentSuggestionHeader({
  item,
  index,
  total,
}: {
  readonly item: Suggestion;
  readonly index: number;
  readonly total: number;
}) {
  const { t } = useTranslation();
  const show = useSet(showAgentSuggestion$);
  return (
    <div className="absolute inset-x-5 top-4 z-30 flex h-7 items-center justify-between gap-3">
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.chat.agentSuggestions.position;
          },
          { current: index + 1, total },
        )}
      </p>
      <div className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          focusableWhenDisabled
          disabled={total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.previous;
          })}
          onClick={() => {
            show((index + total - 1) % total, item, "previous");
          }}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          focusableWhenDisabled
          disabled={total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.next;
          })}
          onClick={() => {
            show((index + 1) % total, item, "next");
          }}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function AgentSuggestionOption({
  option,
  onClick,
  custom = false,
  selected = false,
}: {
  readonly option: Pick<SuggestionOption, "label" | "description" | "threadId">;
  readonly custom?: boolean;
  readonly selected?: boolean;
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
      aria-pressed={custom ? selected : undefined}
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
      {selected ? (
        <Check aria-hidden className="text-muted-foreground" />
      ) : (
        <ArrowRight aria-hidden className="text-muted-foreground" />
      )}
    </Button>
  );
}

function CustomDirectionOption({
  selected,
  onClick,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AgentSuggestionOption
      custom
      selected={selected}
      option={{
        threadId: null,
        label: selected
          ? t(($) => {
              return $.chat.agentSuggestions.customPrepared;
            })
          : t(($) => {
              return $.chat.agentSuggestions.customDirection;
            }),
        description: selected
          ? t(($) => {
              return $.chat.agentSuggestions.customPreparedDescription;
            })
          : t(($) => {
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

function SuggestionFeedbackNotice() {
  const { t } = useTranslation();
  const last = useGet(suggestionFeedbackConfirmation$);
  const reasonOpen = useGet(suggestionFeedbackReasonOpen$);
  const openReason = useSet(openSuggestionFeedbackReason$);
  const close = useSet(closeSuggestionFeedback$);
  const undo = useSet(undoSuggestionFeedback$);
  const save = useSet(saveSuggestionFeedbackReason$);
  const signal = useGet(pageSignal$);
  if (!last) {
    return null;
  }
  const message =
    last.kind === "already_done"
      ? t(($) => {
          return $.chat.agentSuggestions.doneRecorded;
        })
      : last.kind === "not_planned"
        ? t(($) => {
            return $.chat.agentSuggestions.notPlannedRecorded;
          })
        : last.kind === "less_like_this"
          ? t(
              ($) => {
                return $.chat.agentSuggestions.lessRecorded;
              },
              { scope: last.item.feedbackScope.label },
            )
          : t(($) => {
              return $.chat.agentSuggestions.dismissRecorded;
            });
  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-3">
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
            detach(undo(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.agentSuggestions.undoFeedback;
          })}
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          aria-label={t(($) => {
            return $.chat.agentSuggestions.closeFeedback;
          })}
          onClick={() => {
            close();
          }}
        >
          <X />
        </Button>
      </div>
      {last.kind !== "dismissed" && !reasonOpen && (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          onClick={() => {
            openReason();
          }}
        >
          {last.reasonSaved
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
          feedbackId={last.id}
          initialNote={last.note}
          onSave={(note) => {
            detach(save(note, signal), Reason.DomCallback);
          }}
        />
      )}
    </div>
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
  const retry = useSet(entry.retry$);
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
        {entry.item.title}:{" "}
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
          detach(retry(signal), Reason.DomCallback);
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

function AgentSuggestionCard({ item }: { readonly item: Suggestion }) {
  const { t } = useTranslation();
  const start = useSet(startAgentSuggestion$);
  const prepare = useSet(prepareAgentSuggestion$);
  const submitFeedback = useSet(submitAgentSuggestionFeedback$);
  const preparedId = useGet(preparedAgentSuggestionId$);
  const signal = useGet(pageSignal$);
  return (
    <article className="@container/suggestion relative flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card px-5 pb-4 pt-14">
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-medium leading-6 text-foreground">
          {item.title}
        </h3>
        <p className="line-clamp-4 text-sm leading-5 text-muted-foreground">
          {item.rationale}
        </p>
      </div>
      <div className="flex flex-col gap-2 pt-1">
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.agentSuggestions.useSuggestion;
          })}
        </p>
        {item.options.map((option) => {
          return (
            <AgentSuggestionOption
              key={option.id}
              option={option}
              onClick={() => {
                detach(start(item, option.id, signal), Reason.DomCallback);
              }}
            />
          );
        })}
        <CustomDirectionOption
          selected={preparedId === item.id}
          onClick={() => {
            detach(prepare(item, signal), Reason.DomCallback);
          }}
        />
        <AgentSuggestionActions
          onDismiss={() => {
            detach(
              submitFeedback(item, "dismissed", signal),
              Reason.DomCallback,
            );
          }}
          onSelect={(kind) => {
            detach(submitFeedback(item, kind, signal), Reason.DomCallback);
          }}
        />
      </div>
    </article>
  );
}

export function AgentSuggestions() {
  const { t } = useTranslation();
  const result = useLastLoadable(visibleAgentSuggestions$);
  const requested = useGet(agentSuggestionIndex$);
  const motion = useGet(agentSuggestionMotion$);
  const departing = useGet(motion.departing$);
  const deckRef = useSet(motion.deckRef$);
  const arrivalRef = useSet(motion.arrivalRef$);
  const items = result.state === "hasData" ? result.data : [];
  const index = Math.min(requested, Math.max(0, items.length - 1));
  const item = items[index];
  const behind = Math.min(items.length - 1, 2);
  // The async visible pool briefly retains its previous value. Begin the
  // handoff only once the destination is committed, not on that stale frame.
  const leaving =
    departing && departing.item.id !== item?.id ? departing : null;
  if (!item && !leaving) {
    return <SuggestionFeedbackNotice />;
  }

  return (
    <>
      <section
        ref={deckRef}
        aria-label={t(($) => {
          return $.chat.agentSuggestions.label;
        })}
        className="relative isolate min-w-0 overflow-clip"
      >
        {item && (
          <AgentSuggestionHeader
            item={item}
            index={index}
            total={items.length}
          />
        )}
        <div
          key={item?.id ?? "empty"}
          ref={arrivalRef}
          className={cn(
            "relative",
            behind > 0 && "pb-3",
            leaving?.direction === "previous" ? "z-20" : "z-10",
          )}
        >
          {behind >= 2 && (
            <div aria-hidden className={cn(DECK_EDGE, "inset-x-6 bottom-0")} />
          )}
          {behind >= 1 && (
            <div
              aria-hidden
              className={cn(DECK_EDGE, "inset-x-3 bottom-1.5")}
            />
          )}
          {item && <AgentSuggestionCard item={item} />}
        </div>
        {leaving && (
          <div
            key={leaving.item.id}
            data-departing-card
            aria-hidden
            inert
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0",
              leaving.direction === "previous" ? "z-10" : "z-20",
            )}
          >
            <AgentSuggestionCard item={leaving.item} />
          </div>
        )}
      </section>
      <SuggestionFeedbackNotice />
    </>
  );
}
