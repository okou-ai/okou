import type { CSSProperties, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ArrowLeft, ArrowRight, Layers } from "lucide-react";
import { Button, Card, buttonVariants, cn } from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import type { Suggestion } from "@okouai/api-contracts/contracts/feed";
import { defaultAgentId$, defaultAgentName$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  type AgentSuggestionEntry,
  enterSuggestionSession$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import { openAgentSuggestionComposer$ } from "../../signals/okou-page/agent-suggestions.ts";
import {
  browseForYou$,
  finishForYouPaginationOnRef$,
  forYouCardMinHeight$,
  forYouDeck$,
  forYouPagination$,
  measureForYouCardOnRef$,
} from "../../signals/okou-page/for-you.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import {
  AgentSuggestionCard,
  AgentSuggestionComposerDialog,
  SuggestionSaveErrors,
  SuggestionSentNotice,
} from "./agent-suggestions.tsx";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { SuggestionsComplete } from "./suggestions-complete.tsx";
import { forYouSourcesEnabled$ } from "../../signals/okou-page/for-you-sources.ts";
import { ForYouSources } from "./for-you-sources.tsx";
import { PlatformFeedEvent } from "./platform-feed-event.tsx";

const STACK_LAYERS = [
  "z-3 translate-y-2 -rotate-1",
  "z-2 translate-y-4 rotate-1",
  "z-1 translate-y-6 -rotate-2",
] as const;

const STACK_CARD =
  "@container/suggestion col-start-1 row-start-1 flex min-h-125 origin-[50%_85%] flex-col rounded-3xl p-5 shadow-none sm:p-7";

function SuggestionSource({ animated }: { readonly animated: boolean }) {
  const { t } = useTranslation();
  const agentId = useLastResolved(defaultAgentId$);
  const assistantName = useGet(assistantName$);
  const name = useLastResolved(defaultAgentName$) ?? assistantName;
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
      {agentId ? (
        <AgentAvatarImg
          name={agentId}
          alt=""
          className="size-6 rounded-lg object-cover object-top"
          motion={animated ? "animated" : "static"}
        />
      ) : (
        <Layers aria-hidden className="size-4" />
      )}
      <span className="truncate">{name}</span>
      <span aria-hidden>·</span>
      <span>
        {t(($) => {
          return $.chat.agentSuggestions.label;
        })}
      </span>
    </div>
  );
}

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

function ForYouStack({
  onCustomDirection,
}: {
  readonly onCustomDirection: (item: Suggestion) => void;
}) {
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
    <div className="mx-auto my-auto w-full max-w-160 py-6">
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
                  <>
                    <SuggestionSource animated={active || outgoing} />
                    <AgentSuggestionCard
                      active={active}
                      item={card.entry.item}
                      onCustomDirection={onCustomDirection}
                    />
                  </>
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
  return (
    <div ref={active ? read : undefined} className="flex flex-1 flex-col">
      {children}
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
          className="mt-5 flex items-center justify-center gap-3"
        >
          {[
            {
              card: cards.at(-1),
              label: t(($) => {
                return $.chat.agentSuggestions.forYou.previous;
              }),
              Icon: ArrowLeft,
              direction: "previous" as const,
            },
            {
              card: cards[1],
              label: t(($) => {
                return $.chat.agentSuggestions.forYou.next;
              }),
              Icon: ArrowRight,
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

function ForYouHeader({ count }: { readonly count: number | undefined }) {
  const { t } = useTranslation();
  const sourcesEnabled = useGet(forYouSourcesEnabled$);
  return (
    <header className="flex min-h-20 shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-8">
      <div>
        <h1 className="text-lg font-medium">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.title;
          })}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.agentSuggestions.forYou.subtitle;
          })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          role="status"
          className="min-w-12 text-right text-xs tabular-nums text-muted-foreground"
        >
          {count !== undefined
            ? t(
                ($) => {
                  return $.chat.agentSuggestions.forYou.remaining;
                },
                { total: count },
              )
            : null}
        </span>
        {sourcesEnabled && <ForYouSources />}
      </div>
    </header>
  );
}

export function ForYouPage() {
  const { t } = useTranslation();
  const deck = useLastLoadable(forYouDeck$);
  const [composer, openComposer] = useLoadableSet(openAgentSuggestionComposer$);
  const [reloading, reload] = useLoadableSet(enterSuggestionSession$);
  const signal = useGet(pageSignal$);
  const cards = deck.state === "hasData" ? deck.data.cards : [];
  const settled = deck.state === "hasData" ? deck.data.settled : [];
  const complete = deck.state === "hasData" && cards.length === 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ForYouHeader
        count={deck.state === "hasData" ? cards.length : undefined}
      />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-5 pb-safe-offset-8 pt-4 sm:px-12">
        {deck.state === "hasError" ? (
          <div
            role="alert"
            className="m-auto flex flex-col items-center gap-4 p-6"
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
                className="absolute inset-0 min-h-full"
              />
            )}
            <ForYouStack
              onCustomDirection={(suggestion) => {
                detach(openComposer(suggestion.id, signal), Reason.DomCallback);
              }}
            />
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
      <AgentSuggestionComposerDialog composer={composer} />
    </div>
  );
}
