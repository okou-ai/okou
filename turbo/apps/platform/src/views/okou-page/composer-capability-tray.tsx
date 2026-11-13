import type { ReactNode } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  BookOpenCheck,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  Handshake,
  Link2,
  Megaphone,
  MicVocal,
  Network,
  Package,
  Podcast,
  Search,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  cn,
  ScrollBar,
  SegmentControl,
  SegmentControlItem,
  surfaceVariants,
  Tabs,
  TabsContent,
} from "@okouai/ui";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  HomeCapability,
  HomeExploreKind,
  HomeWorkflowKind,
} from "../../signals/okou-page/composer-home.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import {
  WORKFLOW_RECOMMENDATIONS,
  type WorkflowRecommendation,
  type WorkflowRecommendationDraft,
  type WorkflowShelfCover,
} from "../../signals/okou-page/composer-workflow-recommendations.ts";
import { TRIGGER_EXAMPLES } from "../../signals/okou-page/composer-trigger-examples.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ComposerTaskTemplates,
  useTaskTemplateBrowse,
} from "./composer-task-chips.tsx";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";
import { WorkflowTile } from "./composer-workflow-recommendations.tsx";
import { ComposerRail } from "./composer-rail.tsx";
import {
  CREATE_TASKS,
  WORKFLOW_KINDS,
  useComposerCapabilities,
} from "./composer-capabilities.ts";

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

type HomeTask = ComposerTask | HomeExploreKind;
function capabilityGroup(task: HomeTask): HomeCapability {
  if (task === "search" || task === "research" || task === "workflow") {
    return task;
  }
  return "create";
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
  const openTask = useSet(signals.taskChips.home.openCreation$);
  const openWorkflow = useSet(signals.taskChips.home.selectWorkflowKind$);
  const pageSignal = useGet(pageSignal$);
  const workflowKind = useGet(signals.taskChips.home.workflowKind$);
  if (selected === "workflow") {
    return (
      <SegmentControl
        size="sm"
        className={CAPABILITY_TYPE_TABS}
        aria-label={tasks.workflow}
        value={workflowKind}
        onValueChange={(kind: HomeWorkflowKind) => {
          detach(openWorkflow(kind, pageSignal), Reason.DomCallback);
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
        detach(openTask(task, pageSignal), Reason.DomCallback);
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
export function CapabilityTray({
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
  const tabs = useComposerCapabilities(signals) ?? [];
  const open = useSet(signals.taskChips.home.openCapability$);
  const pageSignal = useGet(pageSignal$);
  const group = capabilityGroup(selected);
  // The shared root and panel carry Base UI's tab semantics and keyboard
  // model; the list and its tabs are drawn here because the shared
  // `TabsList`/`TabsTrigger` are the segment-track skin, and these tabs are
  // the tray's own top edge.
  return (
    <Tabs
      value={group}
      onValueChange={(value: HomeCapability) => {
        detach(open(value, pageSignal), Reason.DomCallback);
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

export function CapabilityCloseButton({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const close = useSet(signals.taskChips.home.close$);
  const pageSignal = useGet(pageSignal$);
  return (
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
}

/** Existing conversations keep their messages while opening the home tray. */
export function ComposerCapabilityTray({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.HomeCapabilities];
  const selected = useGet(signals.taskChips.home.menuTask$);
  if (!enabled || selected === null) {
    return null;
  }
  return (
    <div className="@container -mb-6 max-h-[min(50dvh,32rem)] overflow-y-auto [scrollbar-width:none]">
      <CapabilityTray
        signals={signals}
        selected={selected}
        closeButton={<CapabilityCloseButton signals={signals} />}
        className=""
      />
    </div>
  );
}
