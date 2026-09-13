import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  FileText,
  Globe,
  Image,
  Mail,
  MessageSquare,
  Presentation,
  RefreshCw,
  Sparkles,
  UserRound,
  Video,
  Workflow,
} from "lucide-react";
import { Button } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ComposerIdeaTask,
  ComposerTask,
} from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ComposerPresentationRecommendations } from "./chat-composer.tsx";
import { ComposerWorkflowRecommendations } from "./composer-workflow-recommendations.tsx";
import { ComposerVisualizationOptions } from "./composer-visualization-options.tsx";

const TASK_ICONS = {
  workflow: Workflow,
  presentation: Presentation,
  image: Image,
  video: Video,
  website: Globe,
  visualization: ChartNoAxesCombined,
} as const;
const IDEA_ICONS = {
  image: [
    Image,
    UserRound,
    CalendarDays,
    Sparkles,
    FileText,
    ChartNoAxesCombined,
  ],
  video: [
    Image,
    Video,
    MessageSquare,
    CalendarDays,
    Presentation,
    RefreshCw,
    Sparkles,
    Mail,
  ],
  website: [
    Globe,
    UserRound,
    CalendarDays,
    Sparkles,
    FileText,
    Presentation,
    ArrowUpRight,
    CalendarDays,
  ],
} as const;
const IDEAS_PER_PAGE = 4;
const IMAGE_IDEAS = [
  "productScene",
  "headshot",
  "eventPoster",
  "businessLogo",
  "newsletterCover",
  "infographic",
  "storePhoto",
  "roomDesign",
  "birthdayInvitation",
  "presentationVisual",
  "profileBanner",
  "cafeMenu",
  "websiteImage",
  "packaging",
  "photoLighting",
  "finishedSketch",
  "greetingCard",
  "brandCharacter",
] as const;
const VIDEO_IDEAS = [
  "animatePhoto",
  "productDemo",
  "socialClip",
  "eventPromo",
  "visualExplainer",
  "loopingBackground",
  "brandIntro",
  "videoGreeting",
] as const;
const WEBSITE_IDEAS = [
  "businessSite",
  "portfolio",
  "eventPage",
  "productLaunch",
  "cafeMenu",
  "coursePage",
  "linkPage",
  "bookingPage",
] as const;
const CHIP_CLASS =
  "gap-2 rounded-full border border-transparent px-3 font-normal hover:bg-gray-50";

function ComposerTaskIdeas({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: Exclude<ComposerIdeaTask, "workflow">;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.ideas;
    },
    { returnObjects: true },
  );
  const ideas = {
    image: IMAGE_IDEAS.map((key) => {
      return copy.image[key];
    }),
    video: VIDEO_IDEAS.map((key) => {
      return copy.video[key];
    }),
    website: WEBSITE_IDEAS.map((key) => {
      return copy.website[key];
    }),
  }[task];
  const page = useGet(signals.taskChips.ideaPages$)[task];
  const nextIdeas = useSet(signals.taskChips.nextIdeas$);
  const insertPrompt = useSet(signals.editor.selectOrAppendText$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const icons = IDEA_ICONS[task];
  const pageIdeas = Array.from({ length: IDEAS_PER_PAGE }, (_, index) => {
    return ideas[(page * IDEAS_PER_PAGE + index) % ideas.length]!;
  });
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]"
      role="group"
      aria-label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
    >
      <div className="grid min-w-0 grid-cols-1 gap-1">
        {pageIdeas.map((idea, index) => {
          const ideaIndex = (page * IDEAS_PER_PAGE + index) % ideas.length;
          const Icon = icons[ideaIndex % icons.length]!;
          return (
            <Button
              key={idea.label}
              type="button"
              variant="quiet"
              size="sm"
              className="group h-auto min-h-11 min-w-0 justify-start gap-3 px-3 py-2 text-left font-normal hover:bg-gray-50"
              onClick={() => {
                insertPrompt(idea.prompt);
                detach(saveDraft(pageSignal), Reason.DomCallback);
              }}
            >
              <Icon
                size={16}
                className="shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="min-w-0 flex-1 whitespace-normal text-[13px] leading-5">
                {idea.label}
              </span>
              <ArrowUpRight
                size={14}
                className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden
              />
            </Button>
          );
        })}
      </div>
      <div className="flex flex-col items-end gap-1 sm:pt-2">
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="gap-2 font-normal hover:bg-gray-50"
          onClick={() => {
            nextIdeas(task, Math.ceil(ideas.length / IDEAS_PER_PAGE));
          }}
        >
          <RefreshCw size={14} aria-hidden />
          {t(($) => {
            return $.chat.taskChips.moreIdeas;
          })}
        </Button>
        {task === "website" && (
          <Button
            type="button"
            variant="quiet"
            size="xs"
            className="font-normal hover:bg-gray-50"
            onClick={() => {
              openTemplates({ kind: "insert", category: "website" });
            }}
          >
            {t(($) => {
              return $.chat.taskChips.moreTemplates;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ComposerTaskChips({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selected = useGet(signals.taskChips.task$);
  const selectTask = useSet(signals.taskChips.selectTask$);
  const labels = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const tasks: readonly ComposerTask[] = [
    "workflow",
    "presentation",
    "image",
    "video",
    "website",
    "visualization",
  ];
  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t(($) => {
        return $.chat.taskChips.label;
      })}
    >
      {selected === null && (
        <div
          className="flex flex-wrap items-center justify-start gap-1.5"
          role="group"
          aria-label={t(($) => {
            return $.chat.taskChips.chooseTask;
          })}
        >
          {tasks
            .filter((task) => {
              return (
                task === "workflow" ||
                task === "website" ||
                task === "visualization" ||
                signals.create.modes.includes(task)
              );
            })
            .map((task) => {
              const Icon = TASK_ICONS[task];
              return (
                <Button
                  key={task}
                  type="button"
                  size="sm"
                  variant="quiet"
                  className={CHIP_CLASS}
                  onClick={() => {
                    selectTask(task);
                  }}
                >
                  <Icon size={16} aria-hidden />
                  {labels[task]}
                </Button>
              );
            })}
        </div>
      )}
      {selected === "presentation" && (
        <ComposerPresentationRecommendations signals={signals} />
      )}
      {selected === "workflow" && (
        <ComposerWorkflowRecommendations signals={signals} />
      )}
      {selected === "visualization" && (
        <ComposerVisualizationOptions signals={signals} />
      )}
      {selected !== null &&
        selected !== "presentation" &&
        selected !== "workflow" &&
        selected !== "visualization" && (
          <ComposerTaskIdeas signals={signals} task={selected} />
        )}
    </section>
  );
}
