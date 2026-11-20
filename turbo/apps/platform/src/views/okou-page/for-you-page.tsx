import type { CSSProperties, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronLeft, ChevronRight, ImageIcon } from "lucide-react";
import {
  Button,
  Card,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Radio,
  RadioGroup,
  buttonVariants,
  cn,
} from "@okouai/ui";
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
  SuggestionSaveErrors,
  SuggestionSentNotice,
} from "./agent-suggestions.tsx";
import { SuggestionsComplete } from "./suggestions-complete.tsx";
import { proactiveSettingsInMyOkou$ } from "../../signals/proactive-settings.ts";
import { ForYouSources } from "./for-you-sources.tsx";
import { PlatformFeedEvent } from "./platform-feed-event.tsx";
import {
  forYouCover$,
  selectForYouCover$,
} from "../../signals/okou-page/for-you-artwork.ts";
import {
  DEFAULT_FOR_YOU_COVER_ID,
  forYouCovers,
  forYouCoverTornEdge,
} from "../../lib/for-you-artwork.ts";

const STACK_LAYERS = [
  "z-3 translate-y-2 scale-x-[0.98] shadow-[0_1px_2px_rgb(37_33_33/0.05),0_4px_8px_rgb(37_33_33/0.035)]",
  "z-2 translate-y-4 scale-x-[0.96] shadow-[0_1px_2px_rgb(37_33_33/0.05),0_4px_8px_rgb(37_33_33/0.035)]",
] as const;

const STACK_CARD =
  "@container/suggestion col-start-1 row-start-1 flex origin-[50%_85%] touch-pan-y flex-col rounded-3xl p-6 shadow-[0_1px_2px_rgb(37_33_33/0.05),0_10px_26px_rgb(37_33_33/0.06)] sm:p-9";

// The torn-paper edge is an alpha strip repeated along the banner's bottom;
// the solid layer above it overlaps the strip's opaque top rows. Its top fades
// in from the page, so the banner grows out from under the header.
const COVER_MASK = {
  maskImage: `linear-gradient(transparent, #000 40px), url("${forYouCoverTornEdge}")`,
  maskSize: "100% calc(100% - 56px), 1200px 60px",
  maskPosition: "top left, bottom left",
  maskRepeat: "no-repeat, repeat-x",
} satisfies CSSProperties;

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
    <div className="relative mx-auto -mt-26 w-full max-w-176 pb-6 sm:-mt-38">
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
                  <PlatformFeedEvent entry={card.entry} active={active} />
                ) : (
                  <AgentSuggestionCard active={active} entry={card.entry} />
                )}
              </ForYouCardContents>
            </Card>
          );
        })}
      </div>
      <ForYouNavigation />
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
          className={cn(
            // Paging moves through the whole stack, so the controls sit
            // outside the card: on its flanks when the page has room, below
            // it otherwise.
            "-mt-3 flex items-center justify-end gap-2",
            "@min-[56rem]/for-you:pointer-events-none @min-[56rem]/for-you:absolute @min-[56rem]/for-you:inset-0 @min-[56rem]/for-you:m-0",
          )}
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
                className={cn(
                  buttonVariants({ variant: "neutral", size: "icon-lg" }),
                  "rounded-full bg-card shadow-surface",
                  "@min-[56rem]/for-you:pointer-events-auto @min-[56rem]/for-you:absolute @min-[56rem]/for-you:top-[calc(50%-0.75rem)] @min-[56rem]/for-you:-translate-y-1/2",
                  direction === "previous"
                    ? "@min-[56rem]/for-you:-left-17"
                    : "@min-[56rem]/for-you:-right-17",
                )}
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

function ForYouCover() {
  const { t } = useTranslation();
  const cover = useGet(forYouCover$);
  const select = useSet(selectForYouCover$);
  return (
    <div className="group/cover relative -mx-4 h-44 shrink-0 sm:-mx-8 sm:h-64">
      <img
        data-slot="for-you-cover"
        src={cover.src}
        alt=""
        draggable={false}
        style={COVER_MASK}
        className="pointer-events-none size-full select-none object-cover"
      />
      <Popover>
        {/* The control sits in the banner's lower corner only when the page is
            wide enough for it to clear the card; otherwise it moves to the top. */}
        <PopoverTrigger
          render={
            <Button
              variant="neutral"
              size="sm"
              className="absolute top-10 right-4 gap-1.5 bg-card/85 opacity-0 shadow-surface backdrop-blur-md transition-opacity group-hover/cover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 sm:right-6 @min-[64rem]/for-you:top-auto @min-[64rem]/for-you:bottom-14"
            />
          }
        >
          <ImageIcon aria-hidden />
          {t(($) => {
            return $.chat.agentSuggestions.forYou.cover.change;
          })}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={t(($) => {
            return $.chat.agentSuggestions.forYou.cover.change;
          })}
          className="w-[28rem] max-w-[calc(100vw-32px)] p-3"
        >
          <p className="px-1.5 pb-2 text-sm font-medium text-foreground">
            {t(($) => {
              return $.chat.agentSuggestions.forYou.cover.gallery;
            })}
          </p>
          <RadioGroup
            value={cover.id}
            onValueChange={(value) => {
              select(String(value));
            }}
            aria-label={t(($) => {
              return $.chat.agentSuggestions.forYou.cover.gallery;
            })}
            className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto p-1.5"
          >
            {forYouCovers.map((option, index) => {
              return (
                <label
                  key={option.id}
                  className={cn(
                    "relative aspect-[5/2] cursor-default overflow-hidden rounded-lg outline-2 outline-offset-2 outline-transparent transition-[outline-color] has-focus-visible:outline-ring",
                    option.id === cover.id && "outline-primary",
                  )}
                >
                  <img
                    src={option.thumbnail}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                  {option.id === DEFAULT_FOR_YOU_COVER_ID && (
                    <span className="absolute top-1.5 left-1.5 rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                      {t(($) => {
                        return $.chat.agentSuggestions.forYou.cover.default;
                      })}
                    </span>
                  )}
                  <Radio
                    value={option.id}
                    aria-label={t(
                      ($) => {
                        return $.chat.agentSuggestions.forYou.cover.option;
                      },
                      { index: index + 1 },
                    )}
                    className="absolute top-1.5 right-1.5 focus-visible:ring-0"
                  />
                </label>
              );
            })}
          </RadioGroup>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ForYouHeader() {
  const proactiveInMyOkou = useLastResolved(proactiveSettingsInMyOkou$);
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
    <header className="relative grid h-16 shrink-0 grid-flow-col grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 px-4 sm:h-18 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-8 sm:px-8">
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
          className="flex min-w-0 flex-1 items-center"
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
                className="group flex h-11 min-w-0 flex-1 items-center rounded-lg px-1.5 hover:bg-state-hover focus-visible:bg-state-hover sm:px-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-full rounded-full bg-divider transition-colors",
                    index === position &&
                      "bg-linear-to-r from-primary/65 via-primary to-primary-hover",
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
      {proactiveInMyOkou === false && <ForYouSources />}
    </header>
  );
}

export function ForYouPage() {
  const { t } = useTranslation();
  const deck = useLastLoadable(forYouDeck$);
  const [reloading, reload] = useLoadableSet(reloadSuggestionSession$);
  const signal = useGet(pageSignal$);
  const cards = deck.state === "hasData" ? deck.data.cards : [];
  const settled = deck.state === "hasData" ? deck.data.settled : [];
  const complete = deck.state === "hasData" && cards.length === 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-brand-off-white dark:bg-background">
      <ForYouHeader />
      <main className="@container/for-you relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-safe-offset-8 sm:px-8">
        <ForYouCover />
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
                className="absolute inset-x-4 top-44 mx-auto max-w-160 pt-8 sm:top-64 sm:pt-12"
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
    </div>
  );
}
