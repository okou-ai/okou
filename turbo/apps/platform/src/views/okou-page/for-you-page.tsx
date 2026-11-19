import type { CSSProperties, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Card, buttonVariants, cn } from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import {
  type AgentSuggestionEntry,
  reloadSuggestionSession$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  browseForYou$,
  finishForYouPaginationOnRef$,
  forYouCardMinHeight$,
  forYouDeck$,
  forYouPagination$,
  measureForYouCardOnRef$,
  swipeForYouOnRef$,
} from "../../signals/okou-page/for-you.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import {
  AgentSuggestionCard,
  SuggestionDirectionDialog,
  SuggestionSaveErrors,
  SuggestionSentNotice,
} from "./agent-suggestions.tsx";
import { SuggestionsComplete } from "./suggestions-complete.tsx";
import { ForYouSources } from "./for-you-sources.tsx";
import { PlatformFeedEvent } from "./platform-feed-event.tsx";
import { forYouBackground$ } from "../../signals/okou-page/for-you-artwork.ts";

const STACK_LAYERS = [
  "z-3 translate-y-2 scale-x-[0.98]",
  "z-2 translate-y-4 scale-x-[0.96]",
] as const;

const STACK_CARD =
  "@container/suggestion col-start-1 row-start-1 flex origin-[50%_85%] touch-pan-y flex-col rounded-3xl p-5 shadow-none sm:p-7";

function SuggestionSendStatus({
  entry,
  threadId,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly threadId: string | null;
}) {
  const sending = useLoadable(entry.sending$);
  return threadId === null || sending.state === "hasError" ? (
    <SuggestionSentNotice entry={entry} threadId={threadId} />
  ) : null;
}

function ForYouStack() {
  const deck = useLastResolved(forYouDeck$);
  const pagination = useGet(forYouPagination$);
  const minHeight = useGet(forYouCardMinHeight$);
  const measureCard = useSet(measureForYouCardOnRef$);
  const finishPagination = useSet(finishForYouPaginationOnRef$);
  if (!deck) {
    return null;
  }
  const { cards, settled } = deck;
  const complete = cards.length === 0;
  const foreground = cards[0];
  const departure =
    foreground?.entry.item.id === pagination?.to ? pagination : null;
  const displayed = [
    ...(foreground ? [foreground] : []),
    ...(departure ? [departure.from] : []),
    ...settled,
  ];
  return (
    <div className="mx-auto my-auto w-full max-w-176 py-6">
      <div
        className="relative isolate mb-6 grid min-h-(--for-you-card-min-height)"
        style={
          {
            "--for-you-card-min-height": `${String(minHeight)}px`,
          } as CSSProperties
        }
      >
        {STACK_LAYERS.slice(0, Math.max(0, cards.length - 1)).map((layer) => {
          return (
            <Card
              key={layer}
              data-slot="suggestion-stack-layer"
              aria-hidden
              inert
              className={cn(STACK_CARD, "relative", layer)}
            />
          );
        })}
        {displayed.map((card) => {
          const { entry, outcome } = card;
          const outgoing = card === departure?.from;
          const active = card === foreground;
          return (
            <Card
              key={entry.item.id}
              data-slot="suggestion-stack-card"
              ref={
                outgoing ? finishPagination : active ? measureCard : undefined
              }
              inert={!active}
              aria-hidden={!active || undefined}
              className={cn(
                STACK_CARD,
                outcome
                  ? cn(
                      "pointer-events-none inset-0 z-5 motion-safe:animate-card-fly-out motion-reduce:invisible",
                      // The last card keeps its layout footprint while it
                      // flies away, so completion does not move its origin.
                      complete && entry === settled.at(-1)?.entry
                        ? "relative"
                        : "absolute",
                    )
                  : outgoing && departure
                    ? cn(
                        "relative z-5 pointer-events-none",
                        departure.direction === "next"
                          ? "motion-safe:animate-card-page-next-out"
                          : "motion-safe:animate-card-page-previous-out",
                      )
                    : cn(
                        "relative z-4",
                        departure &&
                          (departure.direction === "next"
                            ? "motion-safe:animate-card-page-next-in"
                            : "motion-safe:animate-card-page-previous-in"),
                      ),
              )}
            >
              <ForYouCardContents entry={entry} active={active}>
                {card.kind === "event" ? (
                  <PlatformFeedEvent
                    entry={card.entry}
                    active={active}
                    navigation={<ForYouNavigation />}
                  />
                ) : (
                  <AgentSuggestionCard
                    active={active}
                    entry={card.entry}
                    navigation={<ForYouNavigation />}
                  />
                )}
              </ForYouCardContents>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ForYouCardContents({
  entry,
  active,
  children,
}: {
  readonly entry: Pick<AgentSuggestionEntry, "readOnRef$">;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const read = useSet(entry.readOnRef$);
  const swipe = useSet(swipeForYouOnRef$);
  return (
    <div ref={active ? read : undefined} className="flex flex-1 flex-col">
      <div ref={active ? swipe : undefined} className="flex flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

function ForYouNavigation() {
  const { t } = useTranslation();
  const cards = useLastResolved(forYouDeck$)?.cards ?? [];
  const browse = useSet(browseForYou$);
  const signal = useGet(pageSignal$);
  return (
    <>
      {cards.length > 1 && (
        <nav
          aria-label={t(($) => {
            return $.chat.agentSuggestions.homeCard.navigation;
          })}
          className="flex items-center justify-end gap-1"
        >
          {[
            {
              card: cards.at(-1),
              label: t(($) => {
                return $.chat.agentSuggestions.forYou.previous;
              }),
              Icon: ChevronLeft,
              direction: "previous" as const,
            },
            {
              card: cards[1],
              label: t(($) => {
                return $.chat.agentSuggestions.forYou.next;
              }),
              Icon: ChevronRight,
              direction: "next" as const,
            },
          ].map(({ card, label, Icon, direction }) => {
            return card ? (
              <Link
                key={label}
                pathname={ROUTES.forYou}
                options={{
                  searchParams: new URLSearchParams({
                    suggestion: card.entry.item.id,
                  }),
                }}
                aria-label={label}
                onClick={(event) => {
                  if (shouldHandleLinkClick(event)) {
                    // This changes the reading position in the current
                    // visit; Router navigation would reload its snapshot.
                    event.preventDefault();
                    detach(
                      browse(card.entry.item.id, direction, signal),
                      Reason.DomCallback,
                    );
                  }
                }}
                className={buttonVariants({
                  variant: "quiet",
                  size: "icon",
                })}
              >
                <Icon aria-hidden className="size-4" />
              </Link>
            ) : null;
          })}
        </nav>
      )}
    </>
  );
}

function ForYouHeader() {
  const { t } = useTranslation();
  const deck = useLastResolved(forYouDeck$);
  const cards = deck?.progressCards ?? [];
  const currentId = deck?.cards[0]?.entry.item.id;
  const position = Math.max(
    0,
    cards.findIndex((card) => {
      return card.entry.item.id === currentId;
    }),
  );
  // Keep a navigable window around the current card, even for a large feed.
  const firstStep = Math.max(0, Math.min(position - 3, cards.length - 7));
  const steps = cards.slice(firstStep, firstStep + 7);
  const browse = useSet(browseForYou$);
  const signal = useGet(pageSignal$);
  return (
    <header className="relative grid h-16 shrink-0 grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur-md sm:h-18 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:gap-8 sm:px-8">
      <div className="min-w-0">
        <h1 className="text-base font-semibold sm:text-lg">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.title;
          })}
        </h1>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.subtitle;
          })}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-5">
        <nav
          aria-label={t(($) => {
            return $.chat.agentSuggestions.homeCard.navigation;
          })}
          className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2"
        >
          {steps.map((card, offset) => {
            const index = firstStep + offset;
            return (
              <Link
                key={card.entry.item.id}
                pathname={ROUTES.forYou}
                options={{
                  searchParams: new URLSearchParams({
                    suggestion: card.entry.item.id,
                  }),
                }}
                aria-current={index === position ? "step" : undefined}
                aria-label={t(
                  ($) => {
                    return $.chat.agentSuggestions.homeCard.show;
                  },
                  {
                    index: index + 1,
                    total: cards.length,
                  },
                )}
                onClick={(event) => {
                  if (shouldHandleLinkClick(event)) {
                    event.preventDefault();
                    detach(
                      browse(
                        card.entry.item.id,
                        index < position ? "previous" : "next",
                        signal,
                      ),
                      Reason.DomCallback,
                    );
                  }
                }}
                className="group flex h-11 min-w-0 flex-1 items-center rounded-lg hover:bg-state-hover focus-visible:bg-state-hover"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-full rounded-full bg-divider transition-colors",
                    index === position &&
                      "bg-linear-to-r from-primary/65 via-primary to-primary-hover inset-shadow-[0_1px_0_0] inset-shadow-white/40",
                  )}
                />
              </Link>
            );
          })}
        </nav>
        {cards.length > 0 && (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            <span className="text-foreground">{position + 1}</span>
            <span aria-hidden className="mx-1 text-border">
              /
            </span>
            {cards.length}
          </span>
        )}
        <span role="status" className="sr-only">
          {deck
            ? t(
                ($) => {
                  return $.chat.agentSuggestions.forYou.remaining;
                },
                {
                  total: cards.length,
                },
              )
            : null}
        </span>
      </div>
      <ForYouSources />
    </header>
  );
}

export function ForYouPage() {
  const { t } = useTranslation();
  const deck = useLastLoadable(forYouDeck$);
  const background = useGet(forYouBackground$);
  const [reloading, reload] = useLoadableSet(reloadSuggestionSession$);
  const signal = useGet(pageSignal$);
  const cards = deck.state === "hasData" ? deck.data.cards : [];
  const settled = deck.state === "hasData" ? deck.data.settled : [];
  const complete = deck.state === "hasData" && cards.length === 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <img
        data-slot="for-you-background"
        src={background}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 size-full select-none object-cover"
      />
      <ForYouHeader />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-safe-offset-8 pt-4 sm:px-8 sm:pt-6">
        {deck.state === "hasError" ? (
          <div
            role="alert"
            className="m-auto flex flex-col items-center gap-4 rounded-3xl bg-card p-6"
          >
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.global.errors.requestFailed;
              })}
            </p>
            <Button
              variant="neutral"
              disabled={reloading.state === "loading"}
              onClick={() => {
                detach(reload(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.chat.errors.recovery.tryAgain;
              })}
            </Button>
          </div>
        ) : deck.state !== "hasData" ? (
          <div
            role="status"
            aria-label={t(($) => {
              return $.chat.agentSuggestions.forYou.loading;
            })}
            className="m-auto w-full max-w-160"
          >
            <Skeleton className="h-125 w-full rounded-3xl" />
          </div>
        ) : (
          <>
            {complete && (
              <SuggestionsComplete
                celebrate={settled.length > 0}
                className="absolute inset-x-4 top-1/2 mx-auto min-h-80 max-w-160 -translate-y-1/2 rounded-3xl bg-card p-8"
              />
            )}
            <ForYouStack />
          </>
        )}
        <div className="relative mx-auto w-full max-w-160 shrink-0 space-y-3">
          <SuggestionSaveErrors />
          {settled.map((card) => {
            return card.kind === "suggestion" &&
              card.outcome?.type === "sent" ? (
              <SuggestionSendStatus
                key={card.entry.item.id}
                entry={card.entry}
                threadId={card.outcome.threadId}
              />
            ) : null;
          })}
        </div>
      </main>
      <SuggestionDirectionDialog />
    </div>
  );
}
