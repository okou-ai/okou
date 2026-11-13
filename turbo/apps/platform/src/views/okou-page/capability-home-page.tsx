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
import type { HomeExploreKind } from "../../signals/okou-page/composer-home.ts";
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
 * Find people and Research open their Explore tray from one action, so all
 * four cards are acted on the same way: from a button along the bottom. The
 * button takes only the left column, so the objects keep the right column's
 * full height; hovering it replays them.
 */
function ExploreCapabilityCard({
  signals,
  kind,
}: {
  readonly signals: ComposerSignals;
  readonly kind: HomeExploreKind;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const openExplore = useSet(signals.taskChips.home.openExplore$);
  const art = kind === "search" ? "people" : "research";
  return (
    <section
      className={cn(CAPABILITY_CARD, "min-h-42 @2xl:col-span-9")}
      aria-label={copy[kind].title}
    >
      <CapabilityGround card={art} />
      <CapabilityStage
        card={art}
        className="motion-safe:animate-capability-art-in"
      >
        <CapabilityObjects art={art} />
      </CapabilityStage>
      <CapabilityCopy
        title={copy[kind].title}
        description={copy[kind].description}
        className="max-w-36"
      />
      <div className="relative z-[2] mt-auto flex pt-4">
        <Button
          variant="neutral"
          size="sm"
          data-art="explore"
          onClick={() => {
            openExplore(kind);
          }}
        >
          {copy.explore}
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

function CapabilityCards({
  signals,
  entrance,
}: {
  readonly signals: ComposerSignals;
  readonly entrance: boolean;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const tasks = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const openTask = useSet(signals.taskChips.openTask$);
  const openWorkflow = useSet(signals.taskChips.home.openWorkflow$);
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
      aria-label={copy.capabilities}
    >
      <ExploreCapabilityCard signals={signals} kind="search" />
      <ExploreCapabilityCard signals={signals} kind="research" />
      <section
        className={cn(CAPABILITY_CARD, "min-h-46 @2xl:col-span-10")}
        aria-label={copy.create.title}
      >
        <CapabilityGround card="create" />
        <CapabilityStage card="create">
          {CREATE_TASKS.map(({ art, visibility }) => {
            return (
              <CapabilityObjects key={art} art={art} className={visibility} />
            );
          })}
        </CapabilityStage>
        <CapabilityCopy
          title={copy.create.title}
          description={copy.create.description}
          className="max-w-70"
        />
        <div className="relative z-[2] mt-auto flex flex-wrap gap-1.5 pt-4">
          {CREATE_TASKS.map(({ task, art }) => {
            const button = (
              <Button
                key={task}
                variant="neutral"
                size="sm"
                data-art={art}
                onClick={() => {
                  openTask(task);
                }}
              >
                {tasks[task]}
              </Button>
            );
            return task === "document" ? (
              <Tooltip key={task}>
                <TooltipTrigger render={button} />
                <TooltipContent>{copy.create.documentFormats}</TooltipContent>
              </Tooltip>
            ) : (
              button
            );
          })}
        </div>
      </section>
      <section
        className={cn(CAPABILITY_CARD, "min-h-46 @2xl:col-span-8")}
        aria-label={tasks.workflow}
      >
        <CapabilityGround card="workflow" />
        <CapabilityStage card="workflow">
          {WORKFLOW_KINDS.map(({ art, visibility }) => {
            return (
              <CapabilityObjects key={art} art={art} className={visibility} />
            );
          })}
        </CapabilityStage>
        <CapabilityCopy
          title={tasks.workflow}
          description={copy.workflow.summary}
          className="max-w-33"
        />
        <div className="relative z-[2] mt-auto flex flex-wrap gap-1.5 pt-4">
          {WORKFLOW_KINDS.map(({ kind, art }) => {
            return (
              <Button
                key={kind}
                variant="neutral"
                size="sm"
                data-art={art}
                aria-label={copy.workflow[kind].title}
                onClick={() => {
                  openWorkflow(kind);
                }}
              >
                {copy.workflow[kind].shortTitle}
              </Button>
            );
          })}
        </div>
      </section>
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
  const closeButton = <CapabilityCloseButton signals={signals} />;
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
              "mb-1 flex min-w-0 shrink-0 flex-col gap-5",
              heading === undefined ? "mt-auto" : "row-start-2",
            )}
          >
            {heading !== undefined && (
              // A waiting suggestion speaks in the greeting's own line, so
              // showing it never pushes the cards or the composer down.
              <div className="flex min-h-14 items-center">{heading}</div>
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
              <div className="row-start-2 flex min-h-14 min-w-0 shrink-0 items-center">
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
        <GrowthEntryHeader inFlow>
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
