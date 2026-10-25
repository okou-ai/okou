import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MessageSquarePlus,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Suggestion } from "@okouai/api-contracts/contracts/suggestions";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  agentSuggestionIndex$,
  agentSuggestionRecoveryId$,
  dismissAgentSuggestion$,
  showAgentSuggestion$,
  startAgentSuggestion$,
  visibleAgentSuggestions$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/**
 * The card is an idea card from the other types' rows, grown to the panel's
 * width: `neutral` owns hover and pressed as overlays above `bg-card`, and the
 * lighter `border-border` ink draws the box. `pt-14` leaves the header band to
 * the counter and the controls, which sit over the card rather than inside it
 * so that a press on them never starts the suggestion.
 */
const SUGGESTION_CARD = [
  "group/suggestion h-auto w-full flex-col items-start justify-start gap-2",
  "rounded-xl border-border bg-card px-5 pt-14 pb-4",
  "whitespace-normal text-left font-normal",
  // Every glyph on the card is in the footer, at the footer's text size.
  "[&_svg]:size-3.5",
  // The card re-enters each time it changes, so paging and dismissing read as
  // the next card arriving rather than as text swapping in place.
  "motion-safe:animate-composer-panel-in",
].join(" ");
/**
 * The pager stays focusable when only one card remains. `:disabled` no longer
 * matches such a button, so its disabled look is restated here.
 */
const PAGER = "data-disabled:pointer-events-none data-disabled:opacity-50";
/** One sliver per card waiting behind this one, up to two. */
const DECK_EDGE =
  "pointer-events-none absolute h-10 rounded-xl border border-border bg-card";

/**
 * The band over the top of the card: where the card sits in the pool, the
 * pager, and the dismiss control. Pointer events pass through the band to the
 * card, so the whole surface outside the three controls still starts the
 * suggestion.
 */
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
  const [dismissal, dismiss] = useLoadableSet(dismissAgentSuggestion$);
  const dismissing = dismissal.state === "loading";
  const show = useSet(showAgentSuggestion$);
  const signal = useGet(pageSignal$);
  return (
    <div className="pointer-events-none absolute inset-x-5 top-4 flex h-7 items-center justify-between gap-3">
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.chat.agentSuggestions.position;
          },
          { current: index + 1, total },
        )}
      </p>
      <div className="pointer-events-auto flex items-center gap-0.5">
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          focusableWhenDisabled
          disabled={dismissing || total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.previous;
          })}
          onClick={() => {
            show((index + total - 1) % total);
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
          disabled={dismissing || total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.next;
          })}
          onClick={() => {
            show((index + 1) % total);
          }}
        >
          <ChevronRight />
        </Button>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          aria-label={t(($) => {
            return $.chat.agentSuggestions.dismiss;
          })}
          disabled={dismissing}
          onClick={() => {
            detach(dismiss(item, signal), Reason.DomCallback);
          }}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}

export function AgentSuggestions() {
  const { t } = useTranslation();
  const result = useLastLoadable(visibleAgentSuggestions$);
  const [operation, start] = useLoadableSet(startAgentSuggestion$);
  const starting = operation.state === "loading";
  const recoveryId = useGet(agentSuggestionRecoveryId$);
  const signal = useGet(pageSignal$);
  const requested = useGet(agentSuggestionIndex$);
  // The tab exists only for a resolved, non-empty pool, so a read that is
  // still pending or has failed has nothing to show here.
  if (result.state !== "hasData" || result.data.length === 0) {
    return null;
  }
  const items = result.data;
  const index = Math.min(requested, items.length - 1);
  const item = items[index];
  const recoverable = item.id === recoveryId;
  const behind = Math.min(items.length - 1, 2);
  return (
    <section
      aria-label={t(($) => {
        return $.chat.agentSuggestions.label;
      })}
      // The slivers hang below the card, so the room under it is theirs.
      className={cn("relative", behind > 0 && "pb-3")}
    >
      {behind >= 2 && (
        <div aria-hidden className={cn(DECK_EDGE, "inset-x-6 bottom-0")} />
      )}
      {behind >= 1 && (
        <div aria-hidden className={cn(DECK_EDGE, "inset-x-3 bottom-1.5")} />
      )}
      <fieldset disabled={starting} className="relative min-w-0">
        <Button
          key={item.id}
          type="button"
          variant="neutral"
          className={SUGGESTION_CARD}
          disabled={starting}
          aria-busy={starting}
          onClick={() => {
            detach(start(item, signal), Reason.DomCallback);
          }}
        >
          <span className="text-base font-medium leading-6 text-foreground">
            {item.title}
          </span>
          <span className="line-clamp-4 text-sm leading-5 text-muted-foreground">
            {item.rationale}
          </span>
          <span className="inline-flex items-center gap-1.5 pt-2 text-xs text-muted-foreground">
            {starting ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : recoverable ? (
              <MessageSquarePlus aria-hidden />
            ) : item.threadId ? (
              <MessageSquare aria-hidden />
            ) : (
              <MessageSquarePlus aria-hidden />
            )}
            {starting
              ? t(($) => {
                  return $.chat.agentSuggestions.starting;
                })
              : recoverable
                ? t(($) => {
                    return $.chat.agentSuggestions.restoreDraft;
                  })
                : item.threadId
                  ? t(($) => {
                      return $.chat.agentSuggestions.runInChat;
                    })
                  : t(($) => {
                      return $.chat.agentSuggestions.runNewChat;
                    })}
            <ArrowRight
              aria-hidden
              className="opacity-0 transition-opacity group-hover/suggestion:opacity-100"
            />
          </span>
          {recoverable && !starting && (
            <span className="text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.agentSuggestions.recoveryHint;
              })}
            </span>
          )}
        </Button>
        <AgentSuggestionHeader item={item} index={index} total={items.length} />
      </fieldset>
    </section>
  );
}
