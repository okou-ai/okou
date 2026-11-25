import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronLeft, ChevronRight, ImageIcon, Loader2 } from "lucide-react";
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
  forYouDeck$,
  forYouPagination$,
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
import { PlatformFeedEvent } from "./platform-feed-event.tsx";
import { FOR_YOU_CARD_GROUND } from "./for-you-card-heading.tsx";
import {
  forYouCover$,
  forYouPaintedCover$,
  markForYouCoverPainted$,
  selectForYouCover$,
} from "../../signals/okou-page/for-you-artwork.ts";
import {
  DEFAULT_FOR_YOU_COVER_ID,
  forYouCovers,
} from "../../lib/for-you-artwork.ts";

// The header sits on the cover. Its scrim washes the cover's own colors behind
// the title, subtitle and progress, then eases out past the header's bottom
// edge so no band edge shows.
const HEADER_SCRIM_MASK = `linear-gradient(${[
  [0.85, 0],
  [0.85, 45],
  [0.7, 55],
  [0.52, 63],
  [0.35, 71],
  [0.2, 79],
  [0.08, 87],
  [0.02, 94],
  [0, 100],
]
  .map(([alpha, stop]) => {
    return `rgb(0 0 0 / ${String(alpha)}) ${String(stop)}%`;
  })
  .join(", ")})`;

interface ForYouHeaderColors {
  readonly tone: "light" | "dark";
  readonly tint: readonly [string, string, string];
  readonly bar: readonly [string, string];
}

function headerScrim({ tint: [left, middle, right] }: ForYouHeaderColors) {
  return {
    backgroundImage: `linear-gradient(to right, rgb(${left}) 15%, rgb(${middle}) 50%, rgb(${right}) 85%)`,
    maskImage: HEADER_SCRIM_MASK,
  } satisfies CSSProperties;
}

function headerInk({ tone }: ForYouHeaderColors) {
  return tone === "dark" ? "255 255 255" : "36 36 36";
}

const STACK_LAYERS = [
  "z-3 translate-y-2 scale-x-[0.98] shadow-[0_1px_2px_rgb(37_33_33/0.05),0_4px_8px_rgb(37_33_33/0.035)]",
  "z-2 translate-y-4 scale-x-[0.96] shadow-[0_1px_2px_rgb(37_33_33/0.05),0_4px_8px_rgb(37_33_33/0.035)]",
] as const;

// Every card fills the deck, so the deck keeps one shape as it pages. A card
// being dragged follows the pointer through `--for-you-drag-x`, which the
// departure animation also starts from.
const STACK_CARD = cn(
  "@container/suggestion col-start-1 row-start-1 flex min-h-0 origin-[50%_85%] touch-pan-y flex-col rounded-surface border-border shadow-[0_1px_2px_rgb(37_33_33/0.05),0_10px_26px_rgb(37_33_33/0.06)] data-dragging:cursor-grabbing data-dragging:select-none data-dragging:[transform:translateX(var(--for-you-drag-x,0px))]",
  FOR_YOU_CARD_GROUND,
);

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
    <div className="pointer-events-none relative">
      <div className="relative isolate grid h-(--for-you-card)">
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
        {complete && (
          <Card
            className={cn(
              STACK_CARD,
              "pointer-events-auto relative items-center justify-center overflow-y-auto p-8",
            )}
          >
            <SuggestionsComplete celebrate={settled.length > 0} />
          </Card>
        )}
        {displayed.map((card) => {
          const { entry, outcome } = card;
          const outgoing = card === departure?.from;
          const active = card === foreground;
          return (
            <Card
              key={entry.item.id}
              data-slot="suggestion-stack-card"
              ref={outgoing ? finishPagination : undefined}
              inert={!active}
              aria-hidden={!active || undefined}
              className={cn(
                STACK_CARD,
                outcome
                  ? // A handled card sinks away where it stood.
                    "pointer-events-none absolute inset-0 z-5 motion-safe:animate-card-settle motion-reduce:invisible"
                  : outgoing && departure
                    ? cn(
                        "pointer-events-none relative z-5",
                        departure.direction === "next"
                          ? "motion-safe:animate-card-page-next-out"
                          : "motion-safe:animate-card-page-previous-out",
                      )
                    : // The card in front rises out of the deck, whether it
                      // was paged to or follows a handled one.
                      "pointer-events-auto relative z-4 motion-safe:animate-card-rise",
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
    <div
      ref={active ? read : undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        ref={active ? swipe : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {children}
      </div>
    </div>
  );
}

type PagerDirection = "previous" | "next";

/** Paging moves through the whole stack, wrapping round at either end. */
function useForYouPager() {
  const { t } = useTranslation();
  const cards = useLastResolved(forYouDeck$)?.cards ?? [];
  const browse = useSet(browseForYou$);
  const signal = useGet(pageSignal$);
  if (cards.length < 2) {
    return [];
  }
  return [
    {
      card: cards.at(-1),
      label: t(($) => {
        return $.chat.agentSuggestions.forYou.previous;
      }),
      Icon: ChevronLeft,
      direction: "previous" as PagerDirection,
    },
    {
      card: cards[1],
      label: t(($) => {
        return $.chat.agentSuggestions.forYou.next;
      }),
      Icon: ChevronRight,
      direction: "next" as PagerDirection,
    },
  ].flatMap(({ card, ...item }) => {
    return card
      ? [
          {
            ...item,
            id: card.entry.item.id,
            browse: (event: MouseEvent<HTMLAnchorElement>) => {
              if (shouldHandleLinkClick(event)) {
                // This changes the reading position in the current visit;
                // Router navigation would reload its snapshot.
                event.preventDefault();
                detach(
                  browse(card.entry.item.id, item.direction, signal),
                  Reason.DomCallback,
                );
              }
            },
          },
        ]
      : [];
  });
}

/** On a wide page the paging controls stand on the card's flanks. */
function ForYouNavigation() {
  const { t } = useTranslation();
  const pager = useForYouPager();
  if (pager.length === 0) {
    return null;
  }
  return (
    <nav
      aria-label={t(($) => {
        return $.chat.agentSuggestions.homeCard.navigation;
      })}
      className="pointer-events-none absolute inset-0 hidden @min-[56rem]/for-you:block"
    >
      {pager.map(({ id, label, Icon, direction, browse }) => {
        return (
          <Link
            key={label}
            pathname={ROUTES.forYou}
            options={{
              searchParams: new URLSearchParams({ suggestion: id }),
            }}
            aria-label={label}
            onClick={browse}
            className={cn(
              buttonVariants({ variant: "neutral", size: "icon-lg" }),
              "pointer-events-auto absolute top-1/2 -translate-y-1/2 rounded-full bg-card shadow-surface active:scale-96",
              direction === "previous" ? "-left-16" : "-right-16",
            )}
          >
            <Icon aria-hidden className="size-4" />
          </Link>
        );
      })}
    </nav>
  );
}

/** On a narrower page they sit beside the counter, which never moves. */
function ForYouHeaderPager() {
  const pager = useForYouPager();
  return (
    <span className="-ml-2 flex shrink-0 items-center gap-0.5 @min-[56rem]/for-you:hidden">
      {pager.map(({ id, label, Icon, browse }) => {
        return (
          <Link
            key={label}
            pathname={ROUTES.forYou}
            options={{
              searchParams: new URLSearchParams({ suggestion: id }),
            }}
            aria-label={label}
            onClick={browse}
            className="inline-flex size-7 items-center justify-center rounded-lg text-[rgb(var(--for-you-ink)/0.9)] outline-[rgb(var(--for-you-ink)/0.85)] hover:bg-[rgb(var(--for-you-ink)/0.08)] focus-visible:outline-2 focus-visible:-outline-offset-2 active:bg-[rgb(var(--for-you-ink)/0.14)]"
          >
            <Icon aria-hidden className="size-4" />
          </Link>
        );
      })}
    </span>
  );
}

function ForYouCover() {
  const { t } = useTranslation();
  const cover = useLastResolved(forYouCover$);
  const [saving, select] = useLoadableSet(selectForYouCover$);
  const signal = useGet(pageSignal$);
  const markPainted = useSet(markForYouCoverPainted$);
  if (!cover) {
    return (
      <Skeleton className="-mx-4 aspect-[5/2] max-h-75 shrink-0 rounded-none sm:-mx-8" />
    );
  }
  return (
    // At most 300px of the picture shows, anchored to its foot, so the sky gives
    // way first and the scene's ground always stays; the page continues below
    // in the cover's own ground color.
    <div className="group/cover relative -mx-4 aspect-[5/2] max-h-75 shrink-0 sm:-mx-8">
      <img
        data-slot="for-you-cover"
        src={cover.src}
        alt=""
        draggable={false}
        onLoad={() => {
          markPainted(cover.id);
        }}
        className="pointer-events-none size-full select-none object-cover object-bottom"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[22%] bg-[linear-gradient(transparent,rgb(var(--for-you-ground)))]"
      />
      {/* Night dims the whole scene, picture and ground alike. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden bg-black/34 dark:block"
      />
      <Popover>
        {/* The control sits under the header's right end, clear of the card. */}
        <PopoverTrigger
          render={
            <Button
              variant="neutral"
              size="sm"
              className="absolute top-17 right-4 gap-1.5 bg-card/85 opacity-0 shadow-surface backdrop-blur-md transition-opacity group-hover/cover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 sm:right-6"
            />
          }
        >
          {saving.state === "loading" ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <ImageIcon aria-hidden />
          )}
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
          <div className="max-h-80 overflow-y-auto">
            <RadioGroup
              value={cover.id}
              disabled={saving.state === "loading"}
              onValueChange={(value) => {
                detach(select(String(value), signal), Reason.DomCallback);
              }}
              aria-label={t(($) => {
                return $.chat.agentSuggestions.forYou.cover.gallery;
              })}
              className="grid grid-cols-3 gap-2 p-1.5"
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
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// Compact and wide layouts show different parts of the artwork behind the
// header, so each gets its own scrim colors.
function ForYouHeaderScrim({
  cover,
}: {
  readonly cover: (typeof forYouCovers)[number];
}) {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-27 @min-[56rem]/for-you:hidden"
        style={headerScrim(cover.header.compact)}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 hidden h-27 @min-[56rem]/for-you:block"
        style={headerScrim(cover.header.wide)}
      />
    </>
  );
}

// The header follows the cover, not the color scheme: its ink is fixed rather
// than a theme token, which would flip in dark mode.
function headerInkVars(cover: (typeof forYouCovers)[number]): CSSProperties {
  return {
    "--for-you-ink-wide": headerInk(cover.header.wide),
    "--for-you-ink-compact": headerInk(cover.header.compact),
    "--for-you-bar-wide": cover.header.wide.bar[0],
    "--for-you-bar-compact": cover.header.compact.bar[0],
    "--for-you-track-wide": cover.header.wide.bar[1],
    "--for-you-track-compact": cover.header.compact.bar[1],
  } as CSSProperties;
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
  const cover = useLastResolved(forYouPaintedCover$);
  if (!cover) {
    return null;
  }
  return (
    <header
      style={headerInkVars(cover)}
      className="absolute inset-x-0 top-0 z-10 grid h-14 grid-flow-col grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 px-4 sm:h-15 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-8 sm:px-8 [--for-you-bar:var(--for-you-bar-compact)] [--for-you-ink:var(--for-you-ink-compact)] [--for-you-track:var(--for-you-track-compact)] @min-[56rem]/for-you:[--for-you-bar:var(--for-you-bar-wide)] @min-[56rem]/for-you:[--for-you-ink:var(--for-you-ink-wide)] @min-[56rem]/for-you:[--for-you-track:var(--for-you-track-wide)]"
    >
      <ForYouHeaderScrim cover={cover} />
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-[rgb(var(--for-you-ink)/0.9)] sm:text-lg">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.title;
          })}
        </h1>
        <p className="mt-0.5 truncate text-xs text-[rgb(var(--for-you-ink)/0.85)]">
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
                className="group flex h-11 min-w-0 flex-1 items-center rounded-lg px-1.5 outline-[rgb(var(--for-you-ink)/0.85)] hover:bg-[rgb(var(--for-you-ink)/0.08)] focus-visible:bg-[rgb(var(--for-you-ink)/0.08)] focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-full rounded-full transition-colors",
                    index === position
                      ? "bg-[rgb(var(--for-you-bar))]"
                      : "bg-[rgb(var(--for-you-track))]",
                  )}
                />
              </Link>
            );
          })}
        </nav>
        {cards.length > 0 && (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-[rgb(var(--for-you-ink)/0.85)]">
            <span className="text-[rgb(var(--for-you-ink)/0.9)]">
              {position + 1}
            </span>
            <span
              aria-hidden
              className="mx-1 text-[rgb(var(--for-you-ink)/0.35)]"
            >
              /
            </span>
            {cards.length}
          </span>
        )}
        <ForYouHeaderPager />
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
    </header>
  );
}

// The deck stands on the scene: from the cover's lower third (where its
// foreground ends on the covers) down to the page's foot, and never less than
// 60% of the page, so a short window may cover that foreground. The cover
// shows the picture at its own proportions up to 300px and the card is at most
// 680px tall. Container units read the page, which is a size container.
const FOR_YOU_STAGE = [
  "relative mx-auto w-full max-w-176 [--for-you-pad:1rem] sm:[--for-you-pad:2rem]",
  "[--for-you-width:calc(100cqw_+_2_*_var(--for-you-pad))]",
  "[--for-you-cover:min(calc(var(--for-you-width)_*_0.4),300px)]",
  "[--for-you-top:max(4.5rem,min(calc(var(--for-you-cover)_-_var(--for-you-width)_*_0.12),calc(40cqh_-_1rem)))]",
  "[--for-you-card:max(20rem,min(calc(100cqh_-_var(--for-you-top)_-_1rem),680px))]",
  "mt-[calc(var(--for-you-top)_-_var(--for-you-cover))]",
].join(" ");

// Before a cover is known the page keeps the brand's Off White.
const DEFAULT_GROUND = "248 245 243";

export function ForYouPage() {
  const { t } = useTranslation();
  const deck = useLastLoadable(forYouDeck$);
  const cover = useLastResolved(forYouPaintedCover$);
  const [reloading, reload] = useLoadableSet(reloadSuggestionSession$);
  const signal = useGet(pageSignal$);
  const settled = deck.state === "hasData" ? deck.data.settled : [];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-brand-off-white dark:bg-background">
      <main
        data-slot="for-you-page"
        style={
          {
            "--for-you-ground": cover?.ground ?? DEFAULT_GROUND,
          } as CSSProperties
        }
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-[rgb(var(--for-you-ground))] px-4 pb-safe-offset-8 transition-[background-color] duration-500 [container-name:for-you] [container-type:size] sm:px-8 dark:bg-[color-mix(in_srgb,rgb(var(--for-you-ground))_66%,black)]"
      >
        {/* The header sits on the banner and scrolls away with it. */}
        <ForYouHeader />
        <ForYouCover />
        <div className={FOR_YOU_STAGE}>
          {deck.state === "hasError" ? (
            <div
              role="alert"
              className={cn(
                "flex h-(--for-you-card) flex-col items-center justify-center gap-4 rounded-surface border border-border p-6 shadow-surface",
                FOR_YOU_CARD_GROUND,
              )}
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
            >
              <Skeleton className="h-(--for-you-card) w-full rounded-surface" />
            </div>
          ) : (
            <ForYouStack />
          )}
        </div>
        {/* The card fills the page, so notices float over the header, clear
            of the card's own controls, until they are closed. */}
        <div className="pointer-events-none absolute inset-x-4 top-3 z-20 mx-auto max-w-160 space-y-3 sm:inset-x-8 [&>*]:pointer-events-auto">
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
