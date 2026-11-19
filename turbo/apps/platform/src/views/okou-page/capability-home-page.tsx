import type { ReactNode } from "react";
import { ChatComposerFooter, ChatPageLayout } from "./chat-page-layout.tsx";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Compass } from "lucide-react";
import {
  Button,
  buttonVariants,
  cn,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  HomeExploreKind,
  HomeSwap,
} from "../../signals/okou-page/composer-home.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatComposer } from "./composer.tsx";
import { CapabilityHomeCompliance } from "./chat-home-compliance.tsx";
import { GrowthEntryHeader } from "./growth-entry.tsx";
import { SuggestionSaveErrors } from "./agent-suggestions.tsx";
import {
  CapabilityGround,
  CapabilityObjects,
  CapabilityStage,
} from "./capability-illustrations.tsx";
import { CREATE_TASKS, WORKFLOW_KINDS } from "./composer-capabilities.ts";
import {
  CapabilityTray,
  CapabilityCloseButton,
} from "./composer-capability-tray.tsx";

/**
 * Every capability card shares one anatomy: copy at the top left, its objects
 * on a faint ground of the card's hue at the right, and its actions along the
 * bottom. The cards are flat tone with no stroke or shadow; the composer stays
 * the one outlined surface on the page.
 */
const CAPABILITY_CARD =
  "group/card relative isolate flex min-w-0 flex-col items-start overflow-hidden rounded-surface bg-muted px-6 py-5 text-left";

function CapabilityCopy({
  title,
  description,
  className,
}: {
  readonly title: string;
  readonly description: string;
  /** The copy column's width, which stops short of the card's objects. */
  readonly className: string;
}) {
  return (
    <span className={cn("relative z-[2] flex flex-col items-start", className)}>
      <h2 className="text-lg font-medium leading-7 tracking-tight whitespace-nowrap text-foreground">
        {title}
      </h2>
      {/* Balanced, so a description that wraps never leaves one word alone
          on its last line ("share.", "topics"). */}
      <span className="mt-0.5 text-sm leading-5 text-balance text-muted-foreground">
        {description}
      </span>
    </span>
  );
}

/**
 * Every card opens from anywhere on it, not only from its buttons: this
 * button covers the whole card, above its copy and objects and below its row
 * of choices, which keep their own actions. A click elsewhere on the card
 * does what the card's first choice does. Those choices stay the card's
 * keyboard and assistive-technology controls, so the cover repeats one of
 * them for the pointer only and stays out of the tab order and the
 * accessibility tree.
 */
function CapabilityCardCover({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      data-testid="capability-card-cover"
      className="absolute inset-0 z-[3] rounded-[inherit] outline-none"
      onClick={onClick}
    />
  );
}

/**
 * A card's row of choices, above its cover. The row lets the pointer through
 * everywhere but on the choices themselves, so the gaps between and above
 * them open the card too.
 */
const CHOICE_ROW =
  "pointer-events-none relative z-[4] mt-auto flex pt-4 *:pointer-events-auto";

/**
 * The home's cards and its tray replace each other through one swap, so the
 * change animates as a whole: see `swap$`.
 */
function useHomeSwap(signals: ComposerSignals): (change: HomeSwap) => void {
  const swap = useSet(signals.taskChips.home.swap$);
  const pageSignal = useGet(pageSignal$);
  return (change) => {
    detach(swap(change, pageSignal), Reason.DomCallback);
  };
}

/**
 * The greeting is the one thing on both sides of the swap, so it carries a
 * view transition name: the browser glides it between its row above the cards
 * and its row above the tray instead of cutting from one to the other.
 */
const GREETING_ROW = "flex min-h-14 [view-transition-name:capability-greeting]";

/**
 * Find people and Research open their Explore tray from anywhere on the card;
 * the Explore button along the bottom gives them the same anatomy as Create
 * and Workflow. It takes only the left column, so the objects keep the right
 * column's full height.
 */
function ExploreCapabilityCard({
  signals,
  kind,
}: {
  readonly signals: ComposerSignals;
  readonly kind: HomeExploreKind;
}) {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.chat.capabilityHome[kind].title;
  });
  const description = t(($) => {
    return $.chat.capabilityHome[kind].description;
  });
  const swap = useHomeSwap(signals);
  const art = kind === "search" ? "people" : "research";
  const explore = () => {
    swap({ kind: "explore", explore: kind });
  };
  return (
    <section
      className={cn(CAPABILITY_CARD, "min-h-42 @2xl:col-span-9")}
      aria-label={title}
    >
      <CapabilityCardCover onClick={explore} />
      <CapabilityGround card={art} />
      <CapabilityStage
        card={art}
        className="motion-safe:animate-capability-art-in"
      >
        <CapabilityObjects art={art} />
      </CapabilityStage>
      <CapabilityCopy
        title={title}
        description={description}
        className="max-w-36"
      />
      <div className={CHOICE_ROW}>
        <Button variant="neutral" size="sm" onClick={explore}>
          {t(($) => {
            return $.chat.capabilityHome.explore;
          })}
        </Button>
      </div>
    </section>
  );
}

/**
 * The blog link. It rides in the corner beside the growth entry, outside the
 * page's flow, so it costs the home no height and belongs to no card.
 */
function ExploreLink() {
  const { t } = useTranslation();
  return (
    <a
      href="https://www.okou.ai/en/blog"
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({
        variant: "quiet",
        size: "sm",
        className: "gap-1.5 px-2.5 text-[13px]",
      })}
    >
      <Compass aria-hidden />
      {t(($) => {
        return $.chat.capabilityHome.exploreWhatsNew;
      })}
      <ArrowUpRight aria-hidden />
    </a>
  );
}

/**
 * Workflow offers its three kinds; a click elsewhere on the card opens the
 * first, Scheduled.
 */
function WorkflowCapabilityCard({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.chat.taskChips.tasks.workflow;
  });
  const swap = useHomeSwap(signals);
  return (
    <section
      className={cn(CAPABILITY_CARD, "min-h-46 @2xl:col-span-8")}
      aria-label={title}
    >
      <CapabilityCardCover
        onClick={() => {
          swap({ kind: "workflow", workflow: WORKFLOW_KINDS[0].kind });
        }}
      />
      <CapabilityGround card="workflow" />
      <CapabilityStage card="workflow">
        {WORKFLOW_KINDS.map(({ art, visibility, loading }) => {
          return (
            <CapabilityObjects
              key={art}
              art={art}
              className={visibility}
              loading={loading}
            />
          );
        })}
      </CapabilityStage>
      <CapabilityCopy
        title={title}
        description={t(($) => {
          return $.chat.capabilityHome.workflow.summary;
        })}
        className="max-w-33"
      />
      <div className={cn(CHOICE_ROW, "flex-wrap gap-1.5")}>
        {WORKFLOW_KINDS.map(({ kind, art }) => {
          return (
            <Button
              key={kind}
              variant="neutral"
              size="sm"
              data-art={art}
              aria-label={t(($) => {
                return $.chat.capabilityHome.workflow[kind].title;
              })}
              onClick={() => {
                swap({ kind: "workflow", workflow: kind });
              }}
            >
              {t(($) => {
                return $.chat.capabilityHome.workflow[kind].shortTitle;
              })}
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function CapabilityCards({
  signals,
  entrance,
}: {
  readonly signals: ComposerSignals;
  readonly entrance: boolean;
}) {
  const { t } = useTranslation();
  const createTitle = t(($) => {
    return $.chat.capabilityHome.create.title;
  });
  const tasks = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const swap = useHomeSwap(signals);
  // Explore takes the top row in halves. Below it the row runs 5:4, which still
  // fits Create's five choices on one line and gives Workflow the width its
  // wide flow drawing needs. On the first home of the session the rows rise in
  // one 70ms step after the greeting: the top row at 140ms, the bottom at 210.
  return (
    <div
      className={cn(
        "grid min-w-0 gap-3 @2xl:grid-cols-18",
        entrance &&
          "[&>*]:motion-safe:animate-capability-row-in [&>*:nth-child(-n+2)]:[--capability-row-delay:140ms] [&>*:nth-child(n+3)]:[--capability-row-delay:210ms]",
      )}
      role="group"
      aria-label={t(($) => {
        return $.chat.capabilityHome.capabilities;
      })}
    >
      <ExploreCapabilityCard signals={signals} kind="search" />
      <ExploreCapabilityCard signals={signals} kind="research" />
      <section
        className={cn(CAPABILITY_CARD, "min-h-46 @2xl:col-span-10")}
        aria-label={createTitle}
      >
        <CapabilityCardCover
          onClick={() => {
            swap({ kind: "task", task: CREATE_TASKS[0].task });
          }}
        />
        <CapabilityGround card="create" />
        <CapabilityStage card="create">
          {CREATE_TASKS.map(({ art, visibility, loading }) => {
            return (
              <CapabilityObjects
                key={art}
                art={art}
                className={visibility}
                loading={loading}
              />
            );
          })}
        </CapabilityStage>
        <CapabilityCopy
          title={createTitle}
          description={t(($) => {
            return $.chat.capabilityHome.create.description;
          })}
          className="max-w-70"
        />
        <div className={cn(CHOICE_ROW, "flex-wrap gap-1.5")}>
          {CREATE_TASKS.map(({ task, art }) => {
            const button = (
              <Button
                key={task}
                variant="neutral"
                size="sm"
                data-art={art}
                onClick={() => {
                  swap({ kind: "task", task });
                }}
              >
                {tasks[task]}
              </Button>
            );
            return task === "document" ? (
              <Tooltip key={task}>
                <TooltipTrigger render={button} />
                <TooltipContent>
                  {t(($) => {
                    return $.chat.capabilityHome.create.documentFormats;
                  })}
                </TooltipContent>
              </Tooltip>
            ) : (
              button
            );
          })}
        </div>
      </section>
      <WorkflowCapabilityCard signals={signals} />
    </div>
  );
}

/**
 * Shared discovery and template surface; the host owns its composer, header
 * and greeting.
 */
export function CapabilityHomeContent({
  signals,
  heading,
  entrance = false,
}: {
  readonly signals: ComposerSignals;
  readonly heading?: ReactNode;
  /** Whether the cards rise in, as the greeting does on the session's first home. */
  readonly entrance?: boolean;
}) {
  const selected = useGet(signals.taskChips.home.task$);
  const focusEditor = useSet(signals.editor.focus$);
  const swap = useHomeSwap(signals);
  const closeButton = (
    <CapabilityCloseButton
      signals={signals}
      onClose={() => {
        swap({ kind: "close" });
      }}
    />
  );
  const open = selected !== null;
  return (
    <main
      className={cn(
        "isolate flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable] px-4 sm:px-6",
        // Reserve greeting space in empty chats, whose desktop thread header
        // already occupies 56px.
        heading === undefined ? "pt-24 md:pt-14" : "pt-6",
        // The scroller runs 36px under the composer's footer, which paints
        // above it: through the footer's transparent 12px top padding and
        // past the composer's 24px corner radius. Content that overflows
        // therefore slides under the composer instead of being sliced flat
        // 12px above it with a white band between. The resting distance is
        // padding inside the scroller, so at rest the cards still end 12px
        // above the composer, and an open tray still tucks 12px under its
        // top edge.
        "-mb-9",
        open ? "pb-3" : "pb-9",
      )}
    >
      <div
        className={cn(
          "@container mx-auto w-full max-w-[900px] flex-1",
          heading === undefined
            ? "flex flex-col"
            : open
              ? "grid grid-rows-[minmax(0,2fr)_auto_minmax(0,3fr)_auto]"
              : "grid grid-rows-[minmax(0,2fr)_auto_minmax(0,3fr)]",
        )}
      >
        {selected === null ? (
          <div
            className={cn(
              "flex min-w-0 shrink-0 flex-col gap-5",
              heading === undefined ? "mt-auto mb-1" : "row-start-2",
            )}
          >
            {heading !== undefined && (
              // A waiting suggestion speaks in the greeting's own line, so
              // showing it never pushes the cards or the composer down.
              <div className={cn(GREETING_ROW, "items-center")}>{heading}</div>
            )}
            <CapabilityCards signals={signals} entrance={entrance} />
            <CapabilityHomeCompliance
              entrance={entrance}
              // The block takes its focused hide control with it; the
              // composer is where the page's focus starts, so it goes there.
              onHidden={focusEditor}
            />
          </div>
        ) : (
          <>
            {heading !== undefined && (
              <div
                className={cn(
                  GREETING_ROW,
                  "row-start-2 min-w-0 shrink-0 items-center",
                )}
              >
                {heading}
              </div>
            )}
            <CapabilityTray
              signals={signals}
              selected={selected}
              closeButton={closeButton}
              // Without a greeting the tray alone stands on the composer.
              className={heading === undefined ? "mt-auto" : "row-start-4 mt-6"}
            />
          </>
        )}
      </div>
    </main>
  );
}

export function CapabilityHomePage({
  signals,
  heading,
  entrance,
}: {
  readonly signals: ComposerSignals;
  readonly heading: ReactNode;
  readonly entrance: boolean;
}) {
  return (
    <ChatPageLayout
      header={
        <GrowthEntryHeader>
          <ExploreLink />
        </GrowthEntryHeader>
      }
      footer={
        <ChatComposerFooter>
          <ChatComposer signals={signals} layout="home" />
          <SuggestionSaveErrors />
        </ChatComposerFooter>
      }
    >
      <CapabilityHomeContent
        signals={signals}
        heading={heading}
        entrance={entrance}
      />
    </ChatPageLayout>
  );
}
