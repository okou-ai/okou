import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpenCheck,
  Building2,
  CalendarClock,
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
  Repeat2,
  Search,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  buttonVariants,
  cn,
  SegmentControl,
  SegmentControlItem,
  surfaceVariants,
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
import { WORKFLOW_RECOMMENDATIONS } from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { ComposerTaskTemplates } from "./composer-task-chips.tsx";
import { CapabilityHomeCompliance } from "./chat-home-compliance.tsx";
import { GrowthEntryHeader } from "./growth-entry.tsx";
import { SuggestionSaveErrors } from "./agent-suggestions.tsx";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";
import { ComposerTemplatePickerButton } from "./composer-template-picker-button.tsx";
import { WorkflowTile } from "./composer-workflow-recommendations.tsx";
import { ComposerRail } from "./composer-rail.tsx";
import {
  TRIGGER_EXAMPLES,
  TriggerSuggestionCover,
} from "./trigger-suggestion-cover.tsx";
import { CapabilityIllustration } from "./capability-illustrations.tsx";

/*
 * Each Create and Workflow choice carries `data-art`; its card shows the
 * matching drawing while that choice is hovered or focused. The visibility
 * classes are spelled out in full because Tailwind's scanner only generates
 * classes that appear literally in the source.
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

const SCHEDULE_SUGGESTIONS = [
  { id: "once", Icon: CalendarClock },
  { id: "recurring", Icon: Repeat2 },
] as const;

/**
 * Every capability card shares one anatomy: copy at the top left, its drawing
 * centred in the card's drawing box at the right, and any choices along the
 * bottom. The cards are flat tone with no stroke or shadow; the composer stays
 * the one outlined surface on the page.
 */
const CAPABILITY_CARD =
  "group/card relative isolate flex min-w-0 flex-col items-start overflow-hidden rounded-surface bg-muted px-6 py-5 text-left";

function CapabilityCopy({
  title,
  description,
  heading = false,
  className,
}: {
  readonly title: string;
  readonly description: string;
  readonly heading?: boolean;
  /** The copy column's width, which stops short of the card's drawing box. */
  readonly className: string;
}) {
  const Title = heading ? "h2" : "span";
  return (
    <span className={cn("relative z-[2] flex flex-col items-start", className)}>
      <Title className="flex items-center gap-1 text-lg font-medium leading-7 tracking-tight whitespace-nowrap text-foreground">
        {title}
        {!heading && (
          <ChevronRight
            aria-hidden
            strokeWidth={2}
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
      </Title>
      {/* Balanced, so a description that wraps never leaves one word alone
          on its last line ("share.", "topics"). */}
      <span className="mt-0.5 text-sm leading-5 text-balance text-muted-foreground">
        {description}
      </span>
    </span>
  );
}

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
      return $.chat.capabilityHome[kind];
    },
    { returnObjects: true },
  );
  const openExplore = useSet(signals.taskChips.home.openExplore$);
  return (
    <button
      type="button"
      aria-label={copy.title}
      className={cn(
        CAPABILITY_CARD,
        "min-h-42 transition-[background-color] duration-150 ease-surface [&:hover]:bg-state-hover-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none @2xl:col-span-9",
      )}
      onClick={() => {
        return openExplore(kind);
      }}
    >
      <CapabilityIllustration
        art={kind === "search" ? "people" : "research"}
        className="motion-safe:animate-capability-art-in"
      />
      <CapabilityCopy
        title={copy.title}
        description={copy.description}
        className="max-w-36"
      />
    </button>
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
        {CREATE_TASKS.map(({ art, visibility }) => {
          return (
            <CapabilityIllustration
              key={art}
              art={art}
              className={cn(
                visibility,
                "motion-safe:animate-capability-art-in",
              )}
            />
          );
        })}
        <CapabilityCopy
          heading
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
        {WORKFLOW_KINDS.map(({ art, visibility }) => {
          return (
            <CapabilityIllustration
              key={art}
              art={art}
              className={cn(
                visibility,
                "motion-safe:animate-capability-art-in",
              )}
            />
          );
        })}
        <CapabilityCopy
          heading
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
 * While a tray is open the cards fold into this row, so the page keeps its map
 * of capabilities and another one is a click away without closing first.
 * Create reopens on the type the member last chose.
 */
function CapabilitySwitcher({
  signals,
  selected,
}: {
  readonly signals: ComposerSignals;
  readonly selected: HomeTask;
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
  const openExplore = useSet(signals.taskChips.home.openExplore$);
  const openTask = useSet(signals.taskChips.openTask$);
  const openWorkflow = useSet(signals.taskChips.home.openWorkflow$);
  const task = useGet(signals.taskChips.task$);
  const workflowKind = useGet(signals.taskChips.home.workflowKind$);
  const group = capabilityGroup(selected);
  const items = [
    {
      id: "search",
      art: "people",
      label: copy.search.title,
      open: () => {
        openExplore("search");
      },
    },
    {
      id: "research",
      art: "research",
      label: copy.research.title,
      open: () => {
        openExplore("research");
      },
    },
    {
      id: "create",
      art: "presentation",
      label: copy.create.title,
      open: () => {
        openTask(isCreateTask(task) ? task : "presentation");
      },
    },
    {
      id: "workflow",
      art: "advanced",
      label: tasks.workflow,
      open: () => {
        openWorkflow(workflowKind);
      },
    },
  ] as const;
  return (
    <nav
      aria-label={copy.capabilities}
      className="grid min-w-0 grid-cols-2 gap-2 motion-safe:animate-composer-panel-in @2xl:grid-cols-4"
    >
      {items.map((item) => {
        return (
          <button
            key={item.id}
            type="button"
            aria-current={group === item.id ? "true" : undefined}
            className="flex h-14 min-w-0 items-center gap-2.5 rounded-surface-compact bg-muted pr-3.5 pl-2 text-left text-sm font-medium text-muted-foreground transition-[background-color,box-shadow] duration-150 ease-surface [&:hover]:bg-state-hover-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none aria-[current=true]:bg-card aria-[current=true]:text-foreground aria-[current=true]:shadow-surface aria-[current=true]:ring-1 aria-[current=true]:ring-surface-border"
            onClick={item.open}
          >
            <CapabilityIllustration art={item.art} thumb />
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

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
        variant="plain"
        size="sm"
        className="-ml-1 min-w-0 overflow-x-auto"
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
      variant="plain"
      size="sm"
      className="-ml-1 min-w-0 overflow-x-auto"
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
 * A capability's choices, in a tray that slides up from behind the composer
 * they feed. It takes the composer's own white, border and shadow, and its
 * foot runs under the composer's top edge, so the two read as one surface
 * opening upward rather than a box placed above it; a tinted tray would also
 * tint every template cover inside it.
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
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col gap-4 rounded-t-3xl border border-b-0 border-gray-300 bg-card px-4 pt-4 pb-10 shadow-[var(--okou-card-shadow)] motion-safe:animate-capability-tray-in sm:px-5",
        className,
      )}
    >
      {selected !== "search" && selected !== "research" && (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <CapabilityTabs signals={signals} selected={selected} />
          {closeButton}
        </div>
      )}
      {selected === "search" || selected === "research" ? (
        <HomeExploreSuggestions
          signals={signals}
          kind={selected}
          headerAction={closeButton}
        />
      ) : selected === "workflow" ? (
        <HomeWorkflowSuggestions signals={signals} headerAction={null} />
      ) : (
        <ComposerTaskTemplates signals={signals} selected={selected} />
      )}
    </section>
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
        className:
          "h-auto min-h-16 min-w-0 justify-start gap-3 p-4 text-left whitespace-normal text-foreground hover:bg-card active:bg-card motion-reduce:transition-none @xl:min-h-28 @xl:flex-col @xl:items-start @xl:justify-between @xl:gap-5",
      })}
      onClick={onClick}
    >
      <Icon strokeWidth={1.8} className="text-muted-foreground" aria-hidden />
      <span className="min-w-0 text-sm font-medium leading-6">{title}</span>
    </Button>
  );
}

function HomeSuggestionCard({
  title,
  preview,
  description,
  titlePosition = "bottom",
  onClick,
}: {
  readonly title: string;
  readonly preview: ReactNode;
  readonly description?: string;
  readonly titlePosition?: "top" | "bottom";
  readonly onClick: () => void;
}) {
  const caption = (
    <span
      className={cn(
        "flex flex-col px-2",
        titlePosition === "top" ? "pt-2 pb-3" : "min-h-14 pt-3 pb-2",
      )}
    >
      <span
        className={cn(
          "text-sm font-medium leading-6",
          titlePosition === "top" && "truncate",
        )}
      >
        {title}
      </span>
    </span>
  );
  return (
    <Button
      variant="quiet"
      aria-label={title}
      aria-description={description}
      className="h-auto min-w-0 flex-col items-stretch justify-start gap-0 rounded-xl border border-surface-border bg-card p-2 text-left whitespace-normal text-foreground hover:border-foreground/25 hover:bg-card hover:text-foreground active:bg-card [&>span>svg]:size-full"
      onClick={onClick}
    >
      {titlePosition === "top" && caption}
      <span className="block aspect-video w-full overflow-hidden rounded-lg border border-surface-border/60">
        {preview}
      </span>
      {titlePosition === "bottom" && caption}
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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{copy[kind].title}</h2>
        {headerAction}
      </div>
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
    </section>
  );
}

function HomeAutomationSuggestions({
  signals,
  kind,
}: {
  readonly signals: ComposerSignals;
  readonly kind: "scheduled" | "triggers";
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const prepareWorkflow = useSet(signals.taskChips.home.prepareWorkflow$);
  const pageSignal = useGet(pageSignal$);
  const suggestions =
    kind === "scheduled"
      ? SCHEDULE_SUGGESTIONS.map(({ id, Icon }) => {
          const title = copy.workflow.scheduled.items[id];
          return {
            id,
            title,
            Icon,
            prompt: t(
              ($) => {
                return $.chat.capabilityHome.workflow.scheduled.prompt;
              },
              {
                task: title,
              },
            ),
          };
        })
      : TRIGGER_EXAMPLES.map((example) => {
          const { id, source, mode } = example;
          const steps = copy.workflow.triggers.items[id];
          return {
            id,
            title: steps.title,
            preview: <TriggerSuggestionCover example={example} />,
            description: `${source}: ${steps.event} → ${steps.action} → ${steps.result}`,
            prompt: t(
              ($) => {
                return mode === "monitor"
                  ? $.chat.capabilityHome.workflow.triggers.monitorPrompt
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
          };
        });
  return (
    <div
      className={cn(
        "grid gap-3 @xl:grid-cols-2",
        kind === "triggers" && "@2xl:grid-cols-3",
      )}
    >
      {suggestions.map((suggestion) => {
        const { id, title, prompt } = suggestion;
        const onClick = () => {
          detach(
            prepareWorkflow({ template: null, prompt }, pageSignal),
            Reason.DomCallback,
          );
        };
        if ("Icon" in suggestion) {
          return (
            <HomeActionCard
              key={id}
              title={title}
              Icon={suggestion.Icon}
              onClick={onClick}
            />
          );
        }
        return (
          <HomeSuggestionCard
            key={id}
            title={title}
            preview={suggestion.preview}
            description={suggestion.description}
            titlePosition="top"
            onClick={onClick}
          />
        );
      })}
    </div>
  );
}

function HomeWorkflowSuggestions({
  signals,
  headerAction,
}: {
  readonly signals: ComposerSignals;
  readonly headerAction: ReactNode;
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
  const browse = useSet(signals.taskChips.workflows.browse$);
  const pageSignal = useGet(pageSignal$);
  const title =
    kind === "scheduled"
      ? copy.workflow.scheduled.setupTitle
      : copy.workflow[kind].title;
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          <ComposerTemplatePickerButton
            onClick={() => {
              browse();
            }}
          />
          {headerAction}
        </div>
      </div>
      {kind === "advanced" ? (
        <ComposerRail
          rail="home:advanced-workflows"
          itemWidth={200}
          items={WORKFLOW_RECOMMENDATIONS.map((item) => {
            return (
              <WorkflowTile
                key={item.id}
                item={item}
                onSelect={() => {
                  const template = item.templateId
                    ? localizedWorkflowTemplate(
                        findWorkflowTemplateItem(item.templateId)!,
                      )
                    : null;
                  detach(
                    prepareWorkflow(
                      { template, prompt: recommendations[item.id].prompt },
                      pageSignal,
                    ),
                    Reason.DomCallback,
                  );
                }}
              />
            );
          })}
        />
      ) : (
        <HomeAutomationSuggestions signals={signals} kind={kind} />
      )}
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
        heading === undefined ? "pt-24 md:pt-14" : "pt-6 md:pt-20",
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
            <div
              className={cn(
                "flex min-w-0 shrink-0 flex-col gap-5",
                heading === undefined ? "mt-auto" : "row-start-2",
              )}
            >
              {heading !== undefined && (
                <div className="flex min-h-14 items-center">{heading}</div>
              )}
              <CapabilitySwitcher signals={signals} selected={selected} />
            </div>
            <CapabilityTray
              signals={signals}
              selected={selected}
              closeButton={closeButton}
              className={heading === undefined ? "mt-6" : "row-start-4 mt-6"}
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <GrowthEntryHeader>
        <ExploreLink />
      </GrowthEntryHeader>
      <div className="isolate flex min-h-0 flex-1 flex-col">
        <CapabilityHomeContent
          signals={signals}
          heading={heading}
          entrance={entrance}
        />
        <footer data-chat-composer className="relative shrink-0">
          <div className="overflow-y-auto [scrollbar-gutter:stable] px-4 pb-safe-or-4 pt-3 sm:px-6">
            <div className="mx-auto max-w-[900px]">
              <ChatComposer signals={signals} layout="home" />
              <SuggestionSaveErrors />
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
