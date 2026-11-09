import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpenCheck,
  Building2,
  CalendarClock,
  ChartNoAxesCombined,
  Clock3,
  Files,
  GitBranch,
  Globe,
  Handshake,
  Image,
  Link2,
  Megaphone,
  MicVocal,
  Network,
  Package,
  Podcast,
  Presentation,
  Repeat2,
  Search,
  SlidersHorizontal,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  cn,
  surfaceVariants,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@okouai/ui";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { HomeExploreKind } from "../../signals/okou-page/composer-home.ts";
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

const CREATE_TASKS = [
  {
    task: "presentation",
    Icon: Presentation,
    color:
      "border-[#f5dce6] bg-[#fff0f5] text-[#cd7e9e] dark:border-[#cd7e9e]/25 dark:bg-[#cd7e9e]/10 dark:text-[#e7b1c7]",
  },
  {
    task: "image",
    Icon: Image,
    color:
      "border-[#e5ddfa] bg-[#f4f0ff] text-[#9480cf] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/10 dark:text-[#c3b6ee]",
  },
  {
    task: "document",
    Icon: Files,
    color:
      "border-[#d9e8fb] bg-[#eef5ff] text-[#7b9fd3] dark:border-[#7b9fd3]/25 dark:bg-[#7b9fd3]/10 dark:text-[#b2ccef]",
  },
  {
    task: "website",
    Icon: Globe,
    color:
      "border-[#d9efe5] bg-[#eefaf5] text-[#71ad98] dark:border-[#71ad98]/25 dark:bg-[#71ad98]/10 dark:text-[#b0dcca]",
  },
  {
    task: "visualization",
    Icon: ChartNoAxesCombined,
    color:
      "border-[#f5e2d9] bg-[#fff4ee] text-[#cf947c] dark:border-[#cf947c]/25 dark:bg-[#cf947c]/10 dark:text-[#e7bdab]",
  },
] as const;
const EXPLORE_KINDS = [
  {
    kind: "search",
    Icon: Users,
    color:
      "border-[#d9efe5] bg-[#eefaf5] text-[#71ad98] dark:border-[#71ad98]/25 dark:bg-[#71ad98]/10 dark:text-[#b0dcca]",
    surface: "from-[#f1faf6]/50 dark:from-[#71ad98]/5",
  },
  {
    kind: "research",
    Icon: BookOpenCheck,
    color:
      "border-[#e5ddfa] bg-[#f4f0ff] text-[#9480cf] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/10 dark:text-[#c3b6ee]",
    surface: "from-[#f7f2ff]/50 dark:from-[#9480cf]/5",
  },
] as const;
const WORKFLOW_KINDS = [
  {
    kind: "scheduled",
    Icon: Clock3,
    color:
      "border-[#d9e8fb] bg-[#eef5ff] text-[#7b9fd3] dark:border-[#7b9fd3]/25 dark:bg-[#7b9fd3]/10 dark:text-[#b2ccef]",
  },
  {
    kind: "triggers",
    Icon: Zap,
    color:
      "border-[#f5dce6] bg-[#fff0f5] text-[#cd7e9e] dark:border-[#cd7e9e]/25 dark:bg-[#cd7e9e]/10 dark:text-[#e7b1c7]",
  },
  {
    kind: "advanced",
    Icon: GitBranch,
    color:
      "border-[#e5ddfa] bg-[#f4f0ff] text-[#9480cf] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/10 dark:text-[#c3b6ee]",
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

function CapabilityIcon({
  Icon,
  color,
}: {
  readonly Icon: LucideIcon;
  readonly color: string;
}) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl border duration-150 group-hover:border-current/40 group-hover:brightness-95 group-focus-visible:border-current/40 motion-safe:transition-[border-color,filter] dark:group-hover:brightness-110 @2xl:size-12 @2xl:rounded-2xl",
        color,
      )}
    >
      <Icon strokeWidth={1.8} aria-hidden />
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
  const { Icon, color, surface } = EXPLORE_KINDS.find((item) => {
    return item.kind === kind;
  })!;
  return (
    <Button
      variant="quiet"
      aria-label={copy.title}
      className={cn(
        surfaceVariants({ interactive: true }),
        "group h-auto min-h-16 min-w-0 items-center justify-start gap-2 bg-linear-to-br via-card to-card p-3 text-left whitespace-normal text-foreground hover:bg-card active:bg-card motion-reduce:transition-none @2xl:min-h-22 @2xl:gap-3 @2xl:p-5 [&_svg]:size-5 @2xl:[&_svg]:size-6",
        surface,
      )}
      onClick={() => {
        return openExplore(kind);
      }}
    >
      <CapabilityIcon Icon={Icon} color={color} />
      <span className="min-w-0 text-sm font-medium tracking-tight @2xl:text-lg">
        {copy.title}
      </span>
    </Button>
  );
}

const FEATURE_PREVIEW_CARD =
  "absolute overflow-hidden rounded-lg border border-surface-border bg-card shadow-surface";

/** Decorative product UI fragments, not examples of generated artwork. */
function ExploreFeaturePreview() {
  return (
    <div
      className="relative h-24 w-full max-w-56 scale-90 select-none"
      aria-hidden
    >
      <div
        className={cn(
          FEATURE_PREVIEW_CARD,
          "left-1 top-3 h-20 w-24 -rotate-12 p-2",
        )}
      >
        <div className="h-1 w-8 rounded-full bg-state-pressed" />
        <div className="mt-3 flex items-center">
          <div className="size-5 rounded-md border border-[#d9e8fb] bg-[#eef5ff] dark:border-[#7b9fd3]/25 dark:bg-[#7b9fd3]/15" />
          <div className="h-px w-3 bg-[#b2ccef]" />
          <div className="flex flex-col gap-2 border-l border-[#b2ccef] py-1 pl-2">
            <div className="size-3 rounded border border-[#e5ddfa] bg-[#f4f0ff] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/15" />
            <div className="size-3 rounded border border-[#d9efe5] bg-[#eefaf5] dark:border-[#71ad98]/25 dark:bg-[#71ad98]/15" />
          </div>
        </div>
      </div>
      <div
        className={cn(
          FEATURE_PREVIEW_CARD,
          "right-1 top-3 flex h-20 w-24 rotate-12 flex-col gap-2 p-2",
        )}
      >
        {[
          "bg-[#d9efe5] dark:bg-[#71ad98]/25",
          "bg-[#e5ddfa] dark:bg-[#9480cf]/25",
          "bg-[#d9e8fb] dark:bg-[#7b9fd3]/25",
        ].map((color) => {
          return (
            <div
              key={color}
              className="flex flex-row-reverse items-center gap-2"
            >
              <div className={cn("size-3 shrink-0 rounded-full", color)} />
              <div className="flex flex-1 flex-col gap-1">
                <div className="ml-auto h-1 w-7 rounded-full bg-state-pressed" />
                <div className="ml-auto h-0.5 w-10 rounded-full bg-state-hover" />
              </div>
            </div>
          );
        })}
      </div>
      <div
        className={cn(
          FEATURE_PREVIEW_CARD,
          "left-1/2 top-1 h-20 w-32 -translate-x-1/2 -rotate-2",
        )}
      >
        <div className="flex h-4 items-center gap-1 border-b border-surface-border px-2">
          <span className="size-1 rounded-full bg-[#e7b1c7]" />
          <span className="size-1 rounded-full bg-[#c3b6ee]" />
          <span className="size-1 rounded-full bg-[#b0dcca]" />
          <span className="ml-1 h-1.5 flex-1 rounded-full bg-state-hover" />
        </div>
        <div className="flex gap-2 p-2">
          <div className="flex w-3 shrink-0 flex-col gap-2 pt-1">
            <div className="h-1 rounded-full bg-state-pressed" />
            <div className="h-1 rounded-full bg-state-hover" />
            <div className="h-1 rounded-full bg-state-hover" />
          </div>
          <div className="grid flex-1 grid-cols-2 gap-1.5">
            <div className="col-span-2 h-5 rounded border border-[#e5ddfa] bg-[#f4f0ff] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/15" />
            <div className="h-4 rounded border border-[#d9e8fb] bg-[#eef5ff] dark:border-[#7b9fd3]/25 dark:bg-[#7b9fd3]/15" />
            <div className="h-4 rounded border border-[#f5dce6] bg-[#fff0f5] dark:border-[#cd7e9e]/25 dark:bg-[#cd7e9e]/15" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ExploreBlogCard() {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.chat.capabilityHome.explore;
  });
  return (
    <a
      href="https://www.okou.ai/en/blog"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
      className={surfaceVariants({
        interactive: true,
        className:
          "group flex h-full flex-col overflow-hidden bg-linear-to-br from-[#fff4ee]/50 via-card to-card p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:from-[#cf947c]/5",
      })}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-base font-medium tracking-tight @2xl:text-lg">
          {title}
        </h2>
        <ArrowUpRight
          strokeWidth={1.8}
          className="size-4 shrink-0 text-muted-foreground duration-150 group-hover:text-foreground group-focus-visible:text-foreground motion-safe:transition-transform motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:translate-x-0.5"
          aria-hidden
        />
      </div>
      <div className="mt-2 flex flex-1 items-center justify-center">
        <ExploreFeaturePreview />
      </div>
    </a>
  );
}

function CapabilityCards({ signals }: { readonly signals: ComposerSignals }) {
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
  return (
    <div
      className="grid min-w-0 gap-3 @2xl:grid-cols-12"
      role="group"
      aria-label={copy.capabilities}
    >
      <div className="grid grid-cols-2 gap-3 @2xl:col-span-4 @2xl:grid-cols-1 @2xl:grid-rows-2">
        <ExploreCapabilityCard signals={signals} kind="search" />
        <ExploreCapabilityCard signals={signals} kind="research" />
      </div>
      <section
        className={surfaceVariants({
          className:
            "flex flex-col bg-linear-to-br from-[#f7f2ff]/50 via-card to-card p-4 dark:from-[#9480cf]/5 @2xl:col-span-8 @2xl:p-5",
        })}
        aria-label={copy.create.title}
      >
        <h2 className="text-base font-medium tracking-tight @2xl:text-lg">
          {copy.create.title}
        </h2>
        <div className="mt-3 grid flex-1 grid-cols-3 content-center gap-1 @2xl:mt-5 @2xl:grid-cols-5 @2xl:gap-y-3">
          {CREATE_TASKS.map(({ task, Icon, color }) => {
            const button = (
              <Button
                key={task}
                variant="quiet"
                aria-label={tasks[task]}
                className="group h-auto min-w-0 flex-col justify-start gap-2 rounded-2xl px-0 py-2 text-xs font-medium hover:bg-transparent active:bg-transparent motion-reduce:transition-none @2xl:gap-2.5 @2xl:text-sm [&_svg]:size-5 @2xl:[&_svg]:size-6"
                onClick={() => {
                  openTask(task);
                }}
              >
                <CapabilityIcon Icon={Icon} color={color} />
                <span className="max-w-full text-xs leading-5 break-words whitespace-normal @2xl:text-action">
                  {tasks[task]}
                </span>
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
        className={surfaceVariants({
          className:
            "bg-linear-to-br from-[#f2f7ff]/50 via-card to-card p-4 dark:from-[#7b9fd3]/5 @2xl:col-span-8 @2xl:p-5",
        })}
        aria-label={tasks.workflow}
      >
        <h2 className="text-base font-medium tracking-tight @2xl:text-lg">
          {tasks.workflow}
        </h2>
        <div className="mt-3 grid grid-cols-3 gap-1 @2xl:gap-3">
          {WORKFLOW_KINDS.map(({ kind, Icon, color }) => {
            return (
              <Button
                key={kind}
                variant="quiet"
                aria-label={copy.workflow[kind].title}
                className="group h-auto min-w-0 flex-col justify-start gap-2 rounded-2xl px-1 py-2 text-center whitespace-normal hover:bg-transparent active:bg-transparent motion-reduce:transition-none @2xl:gap-2.5 [&_svg]:size-5 @2xl:[&_svg]:size-6"
                onClick={() => {
                  openWorkflow(kind);
                }}
              >
                <CapabilityIcon Icon={Icon} color={color} />
                <span className="max-w-full text-xs font-medium leading-5 break-words @2xl:text-action @2xl:leading-6">
                  {copy.workflow[kind].title}
                </span>
              </Button>
            );
          })}
        </div>
      </section>
      <div className="@2xl:col-span-4">
        <ExploreBlogCard />
      </div>
    </div>
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
 * Shared discovery and template surface; the host owns its composer and
 * header, and may list suggestions under the capability cards.
 */
export function CapabilityHomeContent({
  signals,
  heading,
  suggestions,
}: {
  readonly signals: ComposerSignals;
  readonly heading?: ReactNode;
  readonly suggestions?: ReactNode;
}) {
  const { t } = useTranslation();
  const selected = useGet(signals.taskChips.home.task$);
  const close = useSet(signals.taskChips.home.close$);
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
        close();
      }}
    >
      <X aria-hidden />
    </Button>
  );
  return (
    <main
      className={cn(
        "isolate flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable] px-4 sm:px-6",
        // Reserve greeting space in empty chats, whose desktop thread header
        // already occupies 56px.
        heading === undefined && selected === null
          ? "pt-24 md:pt-14"
          : selected === null
            ? "pt-6 md:pt-8"
            : "pt-6 md:pt-10",
      )}
    >
      <div className="@container mx-auto flex w-full max-w-[900px] flex-1 flex-col">
        {selected === null ? (
          <div className="mt-auto mb-1 flex min-w-0 shrink-0 flex-col gap-5">
            {heading !== undefined && (
              <div className="flex min-h-14 justify-start">{heading}</div>
            )}
            <CapabilityCards signals={signals} />
            <CapabilityHomeCompliance />
            {suggestions}
          </div>
        ) : (
          <div className="flex flex-1 flex-col justify-end py-4">
            <div className="rounded-2xl border border-surface-border bg-card p-4 sm:p-5">
              {selected === "search" || selected === "research" ? (
                <HomeExploreSuggestions
                  signals={signals}
                  kind={selected}
                  headerAction={closeButton}
                />
              ) : selected === "workflow" ? (
                <HomeWorkflowSuggestions
                  signals={signals}
                  headerAction={closeButton}
                />
              ) : (
                <ComposerTaskTemplates
                  signals={signals}
                  selected={selected}
                  headerAction={closeButton}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export function CapabilityHomePage({
  signals,
  heading,
  suggestions,
}: {
  readonly signals: ComposerSignals;
  readonly heading: ReactNode;
  readonly suggestions: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <GrowthEntryHeader />
      <div className="isolate flex min-h-0 flex-1 flex-col">
        <CapabilityHomeContent
          signals={signals}
          heading={heading}
          suggestions={suggestions}
        />
        <footer data-chat-composer className="relative shrink-0">
          <div className="overflow-y-auto [scrollbar-gutter:stable] px-4 pb-safe-or-4 pt-3 sm:px-6">
            <div className="mx-auto max-w-[900px]">
              <ChatComposer signals={signals} layout="thread" />
              <SuggestionSaveErrors />
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
