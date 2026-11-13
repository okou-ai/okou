import { ChatComposerFooter, ChatPageLayout } from "./chat-page-layout.tsx";
import type { ReactNode } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpenCheck,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  Compass,
  Handshake,
  Link2,
  Megaphone,
  MicVocal,
  Network,
  Package,
  Podcast,
  Route,
  Search,
  Shapes,
  SlidersHorizontal,
  Telescope,
  UserRoundSearch,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  buttonVariants,
  cn,
  ScrollBar,
  SegmentControl,
  SegmentControlItem,
  surfaceVariants,
  Tabs,
  TabsContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@okouai/ui";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  HomeExploreKind,
  HomeWorkflowKind,
} from "../../signals/okou-page/composer-home.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { TRIGGER_EXAMPLES } from "../../signals/okou-page/composer-trigger-examples.ts";
import {
  WORKFLOW_RECOMMENDATIONS,
  type WorkflowRecommendation,
  type WorkflowRecommendationDraft,
  type WorkflowShelfCover,
} from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatComposer } from "./chat-composer.tsx";
import {
  ComposerTaskTemplates,
  useTaskTemplateBrowse,
} from "./composer-task-chips.tsx";
import { CapabilityHomeCompliance } from "./chat-home-compliance.tsx";
import { GrowthEntryHeader } from "./growth-entry.tsx";
import { SuggestionSaveErrors } from "./agent-suggestions.tsx";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";
import { WorkflowTile } from "./composer-workflow-recommendations.tsx";
import { ComposerRail } from "./composer-rail.tsx";
import {
  CapabilityGround,
  CapabilityObjects,
  CapabilityStage,
} from "./capability-illustrations.tsx";

/*
 * Each Create and Workflow choice carries `data-art`; its card shows the
 * matching objects while that choice is hovered or focused, and they enter
 * each time they are swapped in. The visibility classes are spelled out in
 * full because Tailwind's scanner only generates classes that appear
 * literally in the source.
 */
const CREATE_TASKS = [
  {
    task: "presentation",
    art: "presentation",
    visibility:
      "group-has-[[data-art]:not([data-art=presentation]):is(:hover,:focus-visible)]/card:hidden",
  },
  {
    task: "image",
    art: "image",
    visibility:
      "hidden group-has-[[data-art=image]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "document",
    art: "document",
    visibility:
      "hidden group-has-[[data-art=document]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "website",
    art: "website",
    visibility:
      "hidden group-has-[[data-art=website]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "visualization",
    art: "chart",
    visibility:
      "hidden group-has-[[data-art=chart]:is(:hover,:focus-visible)]/card:block",
  },
] as const;
const WORKFLOW_KINDS = [
  {
    kind: "scheduled",
    art: "scheduled",
    visibility:
      "hidden group-has-[[data-art=scheduled]:is(:hover,:focus-visible)]/card:block",
  },
  {
    kind: "triggers",
    art: "triggers",
    visibility:
      "hidden group-has-[[data-art=triggers]:is(:hover,:focus-visible)]/card:block",
  },
  {
    kind: "advanced",
    art: "advanced",
    visibility:
      "group-has-[[data-art]:not([data-art=advanced]):is(:hover,:focus-visible)]/card:hidden",
  },
] as const;

const PEOPLE_SUGGESTIONS = [
  { id: "customers", Icon: Building2 },
  { id: "creators", Icon: Handshake },
  { id: "decisionMakers", Icon: Network },
  { id: "speakers", Icon: MicVocal },
  { id: "podcasts", Icon: Podcast },
  { id: "affiliates", Icon: Link2 },
] as const;

const RESEARCH_SUGGESTIONS = [
  { id: "traffic", Icon: ChartNoAxesCombined },
  { id: "searchOpportunities", Icon: Search },
  { id: "ads", Icon: Megaphone },
  { id: "products", Icon: Package },
  { id: "topic", Icon: BookOpenCheck },
  { id: "tools", Icon: SlidersHorizontal },
] as const;

/**
 * The two ways to start a scheduled task, drawn as the same shelf covers as
 * the workflows beside them: a clock glyph for the mark, since no connector
 * stands for a schedule.
 */
const SCHEDULE_SUGGESTIONS = [
  {
    id: "once",
    cover: {
      tone: "chart-orange",
      kind: "doc",
      sources: [{ glyph: "calendar-clock" }],
      destination: null,
    },
  },
  {
    id: "recurring",
    cover: {
      tone: "chart-green",
      kind: "check",
      sources: [{ glyph: "repeat" }],
      destination: null,
    },
  },
] as const satisfies readonly {
  readonly id: string;
  readonly cover: WorkflowShelfCover;
}[];

/**
 * The recommendations that run on a clock. Scheduled offers them after its
 * two starters; Advanced keeps them too, as the shelf of every workflow.
 */
const SCHEDULED_RECOMMENDATIONS = WORKFLOW_RECOMMENDATIONS.filter((item) => {
  return (
    item.id === "morning" ||
    item.id === "weekly" ||
    item.id === "competitors" ||
    item.id === "metrics"
  );
});

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

type HomeTask = ComposerTask | HomeExploreKind;
type CapabilityGroup = HomeExploreKind | "create" | "workflow";

function capabilityGroup(task: HomeTask): CapabilityGroup {
  if (task === "search" || task === "research" || task === "workflow") {
    return task;
  }
  return "create";
}

function isCreateTask(
  task: ComposerTask | null,
): task is (typeof CREATE_TASKS)[number]["task"] {
  return CREATE_TASKS.some((entry) => {
    return entry.task === task;
  });
}

/**
 * While a tray is open the four capabilities stay one click away as tabs on
 * the tray's top edge. The open one takes the tray's own tint and runs into it
 * through two concave corners, so the capability reads as the tab its choices
 * hang from -- capability, then type, then cover, each inside the last --
 * instead of a second row of cards across the page. Create reopens on the type
 * the member last chose.
 */
function useCapabilityTabs(signals: ComposerSignals) {
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
  const openExplore = useSet(signals.taskChips.home.openExplore$);
  const openTask = useSet(signals.taskChips.openTask$);
  const openWorkflow = useSet(signals.taskChips.home.openWorkflow$);
  const task = useGet(signals.taskChips.task$);
  const workflowKind = useGet(signals.taskChips.home.workflowKind$);
  const tabs = [
    { id: "search", Icon: UserRoundSearch, label: copy.search.title },
    { id: "research", Icon: Telescope, label: copy.research.title },
    { id: "create", Icon: Shapes, label: copy.create.title },
    { id: "workflow", Icon: Route, label: tasks.workflow },
  ] as const satisfies readonly {
    readonly id: CapabilityGroup;
    readonly Icon: LucideIcon;
    readonly label: string;
  }[];
  const open = (group: CapabilityGroup) => {
    switch (group) {
      case "search":
      case "research": {
        openExplore(group);
        return;
      }
      case "create": {
        openTask(isCreateTask(task) ? task : "presentation");
        return;
      }
      case "workflow": {
        openWorkflow(workflowKind);
        return;
      }
    }
  };
  return { tabs, open };
}

/**
 * The open tab is the tray's tint with a 16px top radius; each concave corner
 * is a 16px square of that tint with a quarter circle cut out of it, set just
 * outside the tab's foot. The first tab starts at the tray's edge, so it has no
 * left corner to fill -- the tray squares its own corner instead. The left
 * padding of the first tab lines its icon up with the tray's content edge.
 */
const CAPABILITY_TAB = cn(
  "relative flex h-10 shrink-0 cursor-default items-center gap-2 rounded-t-2xl px-4 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors sm:first:pl-5",
  "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-active:bg-(--capability-tray) data-active:text-foreground",
  "data-active:before:absolute data-active:before:right-full data-active:before:bottom-0 data-active:before:size-4 data-active:before:bg-[radial-gradient(circle_at_0_0,transparent_15.5px,var(--capability-tray)_16px)]",
  "data-active:after:absolute data-active:after:bottom-0 data-active:after:left-full data-active:after:size-4 data-active:after:bg-[radial-gradient(circle_at_100%_0,transparent_15.5px,var(--capability-tray)_16px)]",
  "first:before:hidden",
);

/**
 * The tray's tint is the track: the types drop the control's own recessed
 * track and keep its raised selection, so the open type is a white segment
 * lifted off the tray, its left edge on the covers' left edge. The scroller
 * needs 4px above and below for that segment's shadow, taken back with a
 * negative margin so the row keeps the 32px of its neighbours.
 */
const CAPABILITY_TYPE_TABS =
  "-my-1 h-10 min-w-0 overflow-x-auto bg-transparent px-0 py-1 [scrollbar-width:none]";

/**
 * Create's types and Workflow's kinds switch in the tray's own header, so a
 * member compares them without going back to the cards.
 */
function CapabilityTabs({
  signals,
  selected,
}: {
  readonly signals: ComposerSignals;
  readonly selected: ComposerTask;
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
  const workflowKind = useGet(signals.taskChips.home.workflowKind$);
  if (selected === "workflow") {
    return (
      <SegmentControl
        size="sm"
        className={CAPABILITY_TYPE_TABS}
        aria-label={tasks.workflow}
        value={workflowKind}
        onValueChange={(kind: HomeWorkflowKind) => {
          openWorkflow(kind);
        }}
      >
        {WORKFLOW_KINDS.map(({ kind }) => {
          return (
            <SegmentControlItem key={kind} value={kind}>
              {copy.workflow[kind].shortTitle}
            </SegmentControlItem>
          );
        })}
      </SegmentControl>
    );
  }
  return (
    <SegmentControl
      size="sm"
      className={CAPABILITY_TYPE_TABS}
      aria-label={copy.create.title}
      value={selected}
      onValueChange={(task: ComposerTask) => {
        openTask(task);
      }}
    >
      {CREATE_TASKS.map(({ task }) => {
        return (
          <SegmentControlItem key={task} value={task}>
            {tasks[task]}
          </SegmentControlItem>
        );
      })}
    </SegmentControl>
  );
}

/**
 * The type a header's "View all" browses: Create's types open the template
 * picker on their catalog, Workflow's kinds open the workflow picker.
 */
function CapabilityViewAll({
  signals,
  selected,
}: {
  readonly signals: ComposerSignals;
  readonly selected: ComposerTask;
}) {
  const { t } = useTranslation();
  const browseTemplates = useTaskTemplateBrowse(signals, selected);
  const browseWorkflows = useSet(signals.taskChips.workflows.browse$);
  const browse =
    selected === "workflow"
      ? () => {
          browseWorkflows();
        }
      : browseTemplates;
  if (!browse) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      className="gap-0.5 pr-2 pl-2.5"
      onClick={browse}
    >
      {t(($) => {
        return $.chat.taskChips.viewAll;
      })}
      <ChevronRight aria-hidden />
    </Button>
  );
}

/**
 * A capability's choices, in a tray that slides up from behind the composer
 * they feed. Its foot runs under the composer's top edge, so the two read as
 * one surface opening upward. The tray is a very light tint of the ink rather
 * than the composer's white, so it carries no border or shadow: the white
 * composer, covers and selected type sit raised on it, and it needs no line to
 * separate it from the page. The tint is one mix, so it holds in Dark, where
 * the ink is light.
 *
 * Its capability tabs sit on its top edge, the open one in its tint; the tray
 * is that tab's panel.
 */
function CapabilityTray({
  signals,
  selected,
  closeButton,
  className,
}: {
  readonly signals: ComposerSignals;
  readonly selected: HomeTask;
  readonly closeButton: ReactNode;
  readonly className: string;
}) {
  const { t } = useTranslation();
  const { tabs, open } = useCapabilityTabs(signals);
  const group = capabilityGroup(selected);
  // The shared root and panel carry Base UI's tab semantics and keyboard
  // model; the list and its tabs are drawn here because the shared
  // `TabsList`/`TabsTrigger` are the segment-track skin, and these tabs are
  // the tray's own top edge.
  return (
    <Tabs
      value={group}
      onValueChange={(value: CapabilityGroup) => {
        open(value);
      }}
      className={cn(
        "flex min-w-0 flex-col motion-safe:animate-capability-tray-in",
        "[--capability-tray:color-mix(in_oklab,var(--color-foreground)_3%,var(--color-card))]",
        className,
      )}
    >
      <TabsPrimitive.List
        aria-label={t(($) => {
          return $.chat.capabilityHome.capabilities;
        })}
        // The last tab's concave corner hangs 16px past it; the end padding
        // keeps the scroller from clipping it.
        className="flex min-w-0 items-end overflow-x-auto pr-4 [scrollbar-width:none]"
      >
        {tabs.map(({ id, Icon, label }) => {
          return (
            <TabsPrimitive.Tab key={id} value={id} className={CAPABILITY_TAB}>
              <Icon className="size-4" aria-hidden />
              {label}
            </TabsPrimitive.Tab>
          );
        })}
      </TabsPrimitive.List>
      <TabsContent
        value={group}
        data-slot="capability-tray"
        className={cn(
          "relative flex min-w-0 flex-col gap-4 rounded-t-3xl bg-(--capability-tray) px-4 pt-4 pb-10 outline-none sm:px-5",
          group === "search" && "rounded-tl-none",
        )}
      >
        {selected !== "search" && selected !== "research" && (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <CapabilityTabs signals={signals} selected={selected} />
            <div className="flex shrink-0 items-center gap-1">
              <CapabilityViewAll signals={signals} selected={selected} />
              {closeButton}
            </div>
          </div>
        )}
        {selected === "search" || selected === "research" ? (
          <HomeExploreSuggestions
            signals={signals}
            kind={selected}
            headerAction={closeButton}
          />
        ) : (
          <CapabilityTrayBody key={selected}>
            {selected === "workflow" ? (
              <HomeWorkflowSuggestions signals={signals} />
            ) : (
              <ComposerTaskTemplates
                signals={signals}
                selected={selected}
                headerless
              />
            )}
          </CapabilityTrayBody>
        )}
      </TabsContent>
    </Tabs>
  );
}

/**
 * The tray's choices, in one window that keeps the same height for every
 * capability and type, so switching between them changes what is in the tray
 * and never moves the greeting above it. 240px above the tray's foot is what
 * Find people's two rows of cards take; a catalog taller than that scrolls
 * down inside the window instead of running sideways. Each type opens at its
 * top, so the window is keyed by the type it shows.
 *
 * The window runs down through the tray's bottom padding to the tray's foot,
 * which tucks under the composer: a row that does not fit slides under the
 * composer's edge, the way the page's own scroller does, rather than being cut
 * or faded short of it. The same padding sits inside the window instead, so a
 * window that fits, and one scrolled to its end, still stops its last row where
 * the tray's padding would.
 *
 * The window also bleeds through the tray's side padding and puts it back
 * inside, so the overlay scrollbar sits in the tray's gutter rather than over
 * the covers. The 4px at the top is the room a cover lifts into under the
 * pointer, kept inside the clip; rows snap to their tops, and the window keeps
 * its scroll to itself at either end.
 */
function CapabilityTrayBody({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollArea.Root className="relative -mx-4 -mt-1 -mb-10 sm:-mx-5">
      <ScrollArea.Viewport
        data-slot="scroll-area-viewport"
        className="h-71 snap-y snap-proximity scroll-pt-1 overscroll-contain px-4 pt-1 pb-10 focus:outline-none sm:px-5"
      >
        <ScrollArea.Content>{children}</ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollBar />
    </ScrollArea.Root>
  );
}

function HomeActionCard({
  title,
  Icon,
  onClick,
}: {
  readonly title: string;
  readonly Icon: LucideIcon;
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="quiet"
      iconSize="lg"
      aria-label={title}
      className={surfaceVariants({
        radius: "compact",
        interactive: true,
        // The tray's tint already sets the card apart, so it keeps the
        // surface's white and shadow and lets go of the line.
        className:
          "h-auto min-h-16 min-w-0 justify-start gap-3 border-transparent p-4 text-left whitespace-normal text-foreground hover:bg-card active:bg-card motion-reduce:transition-none @xl:min-h-28 @xl:flex-col @xl:items-start @xl:justify-between @xl:gap-5",
      })}
      onClick={onClick}
    >
      <Icon strokeWidth={1.8} className="text-muted-foreground" aria-hidden />
      <span className="min-w-0 text-sm font-medium leading-6">{title}</span>
    </Button>
  );
}

function HomeExploreSuggestions({
  signals,
  kind,
  headerAction,
}: {
  readonly signals: ComposerSignals;
  readonly kind: HomeExploreKind;
  readonly headerAction: ReactNode;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const prepare = useSet(signals.taskChips.home.prepareExplore$);
  const pageSignal = useGet(pageSignal$);
  const suggestions =
    kind === "search"
      ? PEOPLE_SUGGESTIONS.map(({ id, Icon }) => {
          return { id, title: copy.search.items[id], Icon };
        })
      : RESEARCH_SUGGESTIONS.map(({ id, Icon }) => {
          return { id, title: copy.research.items[id], Icon };
        });
  return (
    <section
      aria-label={copy[kind].title}
      className="flex min-w-0 flex-col gap-4"
    >
      {/* The tab above names the capability, so the header line says what
          it finds instead of naming it twice. */}
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate pl-0.5 text-sm text-muted-foreground">
          {copy[kind].description}
        </p>
        {headerAction}
      </div>
      <CapabilityTrayBody key={kind}>
        <div className="grid gap-3 @xl:grid-cols-2 @2xl:grid-cols-3">
          {suggestions.map(({ id, title, Icon }) => {
            return (
              <HomeActionCard
                key={id}
                title={title}
                Icon={Icon}
                onClick={() => {
                  detach(
                    prepare(
                      t(
                        ($) => {
                          return $.chat.capabilityHome[kind].prompt;
                        },
                        { task: title },
                      ),
                      pageSignal,
                    ),
                    Reason.DomCallback,
                  );
                }}
              />
            );
          })}
        </div>
      </CapabilityTrayBody>
    </section>
  );
}

/**
 * The Workflow tray's kinds, every one as the same shelf covers. Scheduled
 * leads with its two starters and then offers the recommendations that run on
 * a clock; Triggers draws each source over what it leaves behind; Advanced
 * keeps the whole recommendation shelf.
 */
function HomeWorkflowSuggestions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const recommendations = t(
    ($) => {
      return $.chat.taskChips.workflows.items;
    },
    {
      returnObjects: true,
    },
  );
  const kind = useGet(signals.taskChips.home.workflowKind$);
  const prepareWorkflow = useSet(signals.taskChips.home.prepareWorkflow$);
  const pageSignal = useGet(pageSignal$);
  const prepare = (draft: WorkflowRecommendationDraft) => {
    detach(prepareWorkflow(draft, pageSignal), Reason.DomCallback);
  };
  const recommendationTile = (item: WorkflowRecommendation) => {
    return (
      <WorkflowTile
        key={item.id}
        title={recommendations[item.id].title}
        cover={item.cover}
        onSelect={() => {
          prepare({
            template: item.templateId
              ? localizedWorkflowTemplate(
                  findWorkflowTemplateItem(item.templateId)!,
                )
              : null,
            prompt: recommendations[item.id].prompt,
          });
        }}
      />
    );
  };
  const tiles =
    kind === "advanced"
      ? WORKFLOW_RECOMMENDATIONS.map(recommendationTile)
      : kind === "scheduled"
        ? [
            ...SCHEDULE_SUGGESTIONS.map(({ id, cover }) => {
              const title = copy.workflow.scheduled.items[id];
              return (
                <WorkflowTile
                  key={id}
                  title={title}
                  cover={cover}
                  onSelect={() => {
                    prepare({
                      template: null,
                      prompt: t(
                        ($) => {
                          return $.chat.capabilityHome.workflow.scheduled
                            .prompt;
                        },
                        { task: title },
                      ),
                    });
                  }}
                />
              );
            }),
            ...SCHEDULED_RECOMMENDATIONS.map(recommendationTile),
          ]
        : TRIGGER_EXAMPLES.map(({ id, source, mode, cover }) => {
            const steps = copy.workflow.triggers.items[id];
            return (
              <WorkflowTile
                key={id}
                title={steps.title}
                cover={cover}
                description={`${source}: ${steps.event} → ${steps.action} → ${steps.result}`}
                onSelect={() => {
                  prepare({
                    template: null,
                    prompt: t(
                      ($) => {
                        return mode === "monitor"
                          ? $.chat.capabilityHome.workflow.triggers
                              .monitorPrompt
                          : $.chat.capabilityHome.workflow.triggers.eventPrompt;
                      },
                      {
                        task: steps.title,
                        source,
                        event: steps.event,
                        action: steps.action,
                        result: steps.result,
                      },
                    ),
                  });
                }}
              />
            );
          });
  const title =
    kind === "scheduled"
      ? copy.workflow.scheduled.setupTitle
      : copy.workflow[kind].title;
  // The kind's tab and "View all" sit in the tray's header line, so the
  // section keeps its name for assistive tech without a second visible title.
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-5">
      <ComposerRail
        key={kind}
        rail={`home:${kind}-workflows`}
        itemWidth={200}
        items={tiles}
      />
    </section>
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
  const { t } = useTranslation();
  const selected = useGet(signals.taskChips.home.task$);
  const close = useSet(signals.taskChips.home.close$);
  const focusEditor = useSet(signals.editor.focus$);
  const pageSignal = useGet(pageSignal$);
  const closeButton = (
    <Button
      variant="quiet"
      size="icon-sm"
      iconSize="md"
      aria-label={t(($) => {
        return $.chat.capabilityHome.back;
      })}
      className="shrink-0 text-muted-foreground"
      onClick={() => {
        detach(close(pageSignal), Reason.DomCallback);
      }}
    >
      <X aria-hidden />
    </Button>
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
