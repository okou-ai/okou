import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  BookOpenCheck,
  ChartNoAxesCombined,
  Clock3,
  Files,
  GitBranch,
  Globe,
  Image,
  Presentation,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  cn,
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
  PEOPLE_SUGGESTION_COVERS,
  RESEARCH_SUGGESTION_COVERS,
} from "./capability-suggestion-cover.tsx";
import {
  AutomationPreview,
  SCHEDULE_SUGGESTIONS,
} from "./automation-suggestion-cover.tsx";
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
    surface: "from-[#f1faf6] dark:from-[#71ad98]/10",
  },
  {
    kind: "research",
    Icon: BookOpenCheck,
    color:
      "border-[#e5ddfa] bg-[#f4f0ff] text-[#9480cf] dark:border-[#9480cf]/25 dark:bg-[#9480cf]/10 dark:text-[#c3b6ee]",
    surface: "from-[#f7f2ff] dark:from-[#9480cf]/10",
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
        "flex size-14 shrink-0 items-center justify-center rounded-[18px] border transition-[border-color,filter] duration-150 group-hover:border-current group-hover:brightness-95 motion-reduce:transition-none dark:group-hover:brightness-110",
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
        "group h-auto min-h-24 items-center justify-start gap-4 rounded-3xl border border-surface-border bg-card bg-linear-to-br via-card to-card p-5 text-left whitespace-normal hover:bg-card hover:text-muted-foreground active:bg-card [&_svg]:size-7",
        surface,
      )}
      onClick={() => {
        return openExplore(kind);
      }}
    >
      <CapabilityIcon Icon={Icon} color={color} />
      <span className="min-w-0 text-xl font-medium tracking-tight">
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
    <div className="relative h-24 w-full max-w-56 select-none" aria-hidden>
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
      className="flex h-full flex-col overflow-hidden rounded-3xl border border-surface-border bg-card bg-linear-to-br from-[#fff4ee] via-card to-card p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:from-[#cf947c]/10"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 text-xl font-medium tracking-tight">{title}</h2>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-5 shrink-0 text-amber-400"
          aria-hidden
        >
          <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2m0-12a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2m-7 12a6 6 0 0 1 6-6a6 6 0 0 1-6-6a6 6 0 0 1-6 6a6 6 0 0 1 6 6" />
        </svg>
      </div>
      <div className="mt-4 flex flex-1 items-center justify-center">
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
      <div className="grid gap-3 @2xl:col-span-4 @2xl:grid-rows-2">
        <ExploreCapabilityCard signals={signals} kind="search" />
        <ExploreCapabilityCard signals={signals} kind="research" />
      </div>
      <section
        className="flex flex-col rounded-3xl border border-surface-border bg-card bg-linear-to-br from-[#f7f2ff] via-card to-card p-5 dark:from-[#9480cf]/10 @2xl:col-span-8"
        aria-label={copy.create.title}
      >
        <h2 className="text-xl font-medium tracking-tight">
          {copy.create.title}
        </h2>
        <div className="mt-8 grid flex-1 grid-cols-3 content-end gap-1 pb-3 @2xl:mt-10 @2xl:grid-cols-5">
          {CREATE_TASKS.map(({ task, Icon, color }) => {
            const button = (
              <Button
                key={task}
                variant="quiet"
                aria-label={tasks[task]}
                className="group h-auto min-w-0 flex-col justify-start gap-3 rounded-2xl px-0 py-2 text-sm font-medium hover:bg-transparent hover:text-muted-foreground active:bg-transparent [&_svg]:size-7"
                onClick={() => {
                  openTask(task);
                }}
              >
                <CapabilityIcon Icon={Icon} color={color} />
                <span className="max-w-full break-words whitespace-normal">
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
        className="rounded-3xl border border-surface-border bg-card bg-linear-to-br from-[#f2f7ff] via-card to-card p-5 dark:from-[#7b9fd3]/10 @2xl:col-span-8"
        aria-label={tasks.workflow}
      >
        <h2 className="text-xl font-medium tracking-tight">{tasks.workflow}</h2>
        <div className="mt-4 grid gap-3 @2xl:grid-cols-3">
          {WORKFLOW_KINDS.map(({ kind, Icon, color }) => {
            return (
              <Button
                key={kind}
                variant="quiet"
                aria-label={copy.workflow[kind].title}
                className="group h-auto min-w-0 justify-start gap-3 rounded-2xl px-1 py-2 text-left whitespace-normal hover:bg-transparent hover:text-muted-foreground active:bg-transparent @2xl:flex-col @2xl:text-center [&_svg]:size-7"
                onClick={() => {
                  openWorkflow(kind);
                }}
              >
                <CapabilityIcon Icon={Icon} color={color} />
                <span className="text-sm font-medium leading-6">
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
          "text-base font-medium leading-6",
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
      ? PEOPLE_SUGGESTION_COVERS.map(({ id, Preview }) => {
          return { id, title: copy.search.items[id], preview: <Preview /> };
        })
      : RESEARCH_SUGGESTION_COVERS.map(({ id, Preview }) => {
          return { id, title: copy.research.items[id], preview: <Preview /> };
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
        {suggestions.map(({ id, title, preview }) => {
          return (
            <HomeSuggestionCard
              key={id}
              title={title}
              preview={preview}
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
      ? SCHEDULE_SUGGESTIONS.map((id) => {
          const title = copy.workflow.scheduled.items[id];
          return {
            id,
            title,
            preview: <AutomationPreview kind={id} />,
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
    <div className="grid gap-3 @xl:grid-cols-2 @2xl:grid-cols-3">
      {suggestions.map((suggestion) => {
        const { id, title, preview, prompt } = suggestion;
        return (
          <HomeSuggestionCard
            key={id}
            title={title}
            preview={preview}
            description={
              "description" in suggestion ? suggestion.description : undefined
            }
            titlePosition={kind === "triggers" ? "top" : "bottom"}
            onClick={() => {
              detach(
                prepareWorkflow({ template: null, prompt }, pageSignal),
                Reason.DomCallback,
              );
            }}
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
  return (
    <section
      aria-label={copy.workflow[kind].title}
      className="flex min-w-0 flex-col gap-5"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{copy.workflow[kind].title}</h2>
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

/** Shared discovery and template surface; the host owns its composer and header. */
export function CapabilityHomeContent({
  signals,
  heading,
}: {
  readonly signals: ComposerSignals;
  readonly heading?: ReactNode;
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
        // Match the home's 56px greeting and 16px gap without rendering them
        // in empty chats. Their desktop thread header already occupies 56px.
        heading === undefined && selected === null
          ? "pt-24 md:pt-14"
          : "pt-6 md:pt-10",
      )}
    >
      <div className="@container mx-auto flex w-full max-w-[900px] flex-1 flex-col">
        {selected === null ? (
          <div className="my-auto flex min-w-0 shrink-0 flex-col gap-4 py-2">
            {heading !== undefined && (
              <div className="flex min-h-14 -translate-y-3 justify-start sm:-translate-y-5">
                {heading}
              </div>
            )}
            <CapabilityCards signals={signals} />
            <CapabilityHomeCompliance />
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
}: {
  readonly signals: ComposerSignals;
  readonly heading: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <GrowthEntryHeader />
      <div className="isolate flex min-h-0 flex-1 flex-col">
        <CapabilityHomeContent signals={signals} heading={heading} />
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
