import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronRight,
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
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ComposerTask,
  ComposerTemplateTask,
} from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ComposerPresentationRecommendations } from "./chat-composer.tsx";
import {
  slashTemplatePreviewGroup,
  type SlashTemplatePreview,
  type SlashTemplatePreviewCategory,
} from "./composer-template-catalog.ts";
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
const TEMPLATES_PER_PAGE = 5;
const CHIP_CLASS =
  "gap-2 rounded-full border border-transparent px-3 font-normal hover:bg-gray-50";
/**
 * Both rows are a single line that usually overruns the 900px column. The rail
 * hides the overrun and the mask dissolves its last 56px, so the row ends in a
 * fade instead of a hard cut through a chip or a cover. Focus lifts the mask:
 * the page is fixed, so a keyboard user could otherwise land on a control that
 * the fade has dimmed.
 */
const ROW_RAIL = "min-w-0 flex-1 overflow-hidden";
const ROW_FADE = cn(
  "[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_56px),transparent)]",
  "[mask-image:linear-gradient(to_right,#000_calc(100%_-_56px),transparent)]",
  "focus-within:[-webkit-mask-image:none] focus-within:[mask-image:none]",
);
/** The pager sits outside the rail, so it always has an unmasked surface. */
const ROW_PAGER = "shrink-0";
/**
 * Illustration styles run 20 portrait, 9 square and 3 landscape, so their own
 * proportions cannot line up. One 4:5 tile centre-crops them into a single
 * rhythm; a style sample is judged on texture and palette, and the uncropped
 * artwork is still what the picker dialog shows. The other two catalogs are
 * screenshots of 16:9 artifacts and keep that ratio.
 */
const TASK_TEMPLATE_SHELF = {
  image: {
    category: "illustration",
    width: "w-[118px]",
    ratio: "aspect-[4/5]",
  },
  video: { category: "video", width: "w-[200px]", ratio: "aspect-video" },
  website: { category: "website", width: "w-[200px]", ratio: "aspect-video" },
} as const satisfies Record<
  ComposerTemplateTask,
  {
    readonly category: SlashTemplatePreviewCategory;
    readonly width: string;
    readonly ratio: string;
  }
>;

/**
 * One cover. Selecting it attaches the template to the composer the same way
 * the slash panel does; the catalog already pairs each preview with the
 * attachment its chip stores.
 */
function ComposerTemplateCover({
  preview,
  width,
  ratio,
  onSelect,
}: {
  readonly preview: SlashTemplatePreview;
  readonly width: string;
  readonly ratio: string;
  readonly onSelect: (preview: SlashTemplatePreview) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="quiet"
      className={cn(
        "group/cover block h-auto shrink-0 rounded-lg p-0 text-left font-normal",
        width,
      )}
      aria-label={t(
        ($) => {
          return $.chat.composer.slashPanel.useTemplate;
        },
        { title: preview.title },
      )}
      onClick={() => {
        onSelect(preview);
      }}
    >
      <span
        className={cn(
          "block overflow-hidden rounded-lg border border-border bg-muted",
          ratio,
        )}
      >
        <img
          src={preview.coverUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover object-center transition-transform duration-200 group-hover/cover:scale-[1.04]"
        />
      </span>
      <span className="mt-2 block truncate text-[12px] leading-4">
        {preview.title}
      </span>
    </Button>
  );
}

/**
 * The cover shelf for a type. Its header owns the two actions that used to
 * float in a column of their own: the catalog link stays on the title line,
 * and paging stays beside the covers it moves.
 */
function ComposerTemplateShelf({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: ComposerTemplateTask;
}) {
  const { t } = useTranslation();
  const { category, width, ratio } = TASK_TEMPLATE_SHELF[task];
  const group = slashTemplatePreviewGroup(category);
  const page = useGet(signals.taskChips.templatePages$)[task];
  const nextTemplates = useSet(signals.taskChips.nextTemplates$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const pageCount = Math.ceil(group.previews.length / TEMPLATES_PER_PAGE);
  // Named one key at a time: the extractor only keeps keys it can see.
  const labels = {
    image: t(($) => {
      return $.chat.taskChips.shelf.image;
    }),
    video: t(($) => {
      return $.chat.taskChips.shelf.video;
    }),
    website: t(($) => {
      return $.chat.taskChips.shelf.website;
    }),
  };
  const label = labels[task];
  const pagePreviews = group.previews.slice(
    page * TEMPLATES_PER_PAGE,
    (page + 1) * TEMPLATES_PER_PAGE,
  );
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] font-medium">{label}</p>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="shrink-0 gap-1.5 font-normal"
          onClick={() => {
            openTemplates({ kind: "insert", category });
          }}
        >
          {t(($) => {
            return task === "image"
              ? $.chat.taskChips.shelf.browseStyles
              : $.chat.taskChips.shelf.browseTemplates;
          })}
          <ArrowRight className="size-3" aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className={cn(ROW_RAIL, ROW_FADE)}>
          <div className="flex w-max items-start gap-3">
            {pagePreviews.map((preview) => {
              return (
                <ComposerTemplateCover
                  key={preview.slug}
                  preview={preview}
                  width={width}
                  ratio={ratio}
                  onSelect={() => {
                    insertTemplate(preview.template, preview.attachment);
                    detach(saveDraft(pageSignal), Reason.DomCallback);
                  }}
                />
              );
            })}
          </div>
        </div>
        {pageCount > 1 && (
          <Button
            type="button"
            variant="neutral"
            size="icon-sm"
            className={ROW_PAGER}
            aria-label={t(($) => {
              return $.chat.taskChips.shelf.nextTemplates;
            })}
            onClick={() => {
              nextTemplates(task, pageCount);
            }}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

function ComposerTaskIdeas({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: ComposerTemplateTask;
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
  const icons = IDEA_ICONS[task];
  const pageIdeas = Array.from({ length: IDEAS_PER_PAGE }, (_, index) => {
    return ideas[(page * IDEAS_PER_PAGE + index) % ideas.length]!;
  });
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="group"
      aria-label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
    >
      <div className={cn(ROW_RAIL, ROW_FADE)}>
        <div className="flex w-max items-center gap-1.5">
          {pageIdeas.map((idea, index) => {
            const ideaIndex = (page * IDEAS_PER_PAGE + index) % ideas.length;
            const Icon = icons[ideaIndex % icons.length]!;
            return (
              <Button
                key={idea.label}
                type="button"
                variant="quiet"
                size="sm"
                className="shrink-0 gap-2 rounded-full border border-border px-3 font-normal"
                onClick={() => {
                  insertPrompt(idea.prompt);
                  detach(saveDraft(pageSignal), Reason.DomCallback);
                }}
              >
                <Icon size={14} className="shrink-0" aria-hidden />
                <span className="text-[13px] leading-5">{idea.label}</span>
              </Button>
            );
          })}
        </div>
      </div>
      <Button
        type="button"
        variant="neutral"
        size="icon-sm"
        className={ROW_PAGER}
        aria-label={t(($) => {
          return $.chat.taskChips.moreIdeas;
        })}
        onClick={() => {
          nextIdeas(task, Math.ceil(ideas.length / IDEAS_PER_PAGE));
        }}
      >
        <ChevronRight className="size-4" aria-hidden />
      </Button>
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
          <>
            <ComposerTaskIdeas signals={signals} task={selected} />
            <ComposerTemplateShelf signals={signals} task={selected} />
          </>
        )}
    </section>
  );
}
