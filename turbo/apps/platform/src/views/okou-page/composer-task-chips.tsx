import type { CSSProperties, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe,
  Image,
  Mail,
  MessageSquare,
  Presentation,
  RefreshCw,
  Route,
  Sparkles,
  UserRound,
  Video,
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
  workflow: Route,
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
/**
 * What one page can show inside the 900px column once the pagers take their
 * 88px. Idea labels are sentences and run 150-260px, so three is the count
 * that fits the widest three; covers are a fixed 200px, so four land 24px
 * into the 56px fade rather than past it.
 */
const IDEAS_PER_PAGE = 3;
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
const TEMPLATES_PER_PAGE = 4;
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
/**
 * The pager sits outside the rail, so it always has an unmasked surface. It is
 * the `icon` counterpart of the default-size neutral control the rows use.
 */
const ROW_PAGER = "shrink-0";
/**
 * Each page is exactly as wide as the rail, so the track can slide by whole
 * percentages without measuring anything. `--page` is the only runtime value
 * the component computes; the motion itself stays a utility.
 */
const ROW_TRACK = cn(
  "flex w-full [transform:translateX(calc(var(--page)*-100%))]",
  "transition-transform duration-300 ease-out motion-reduce:transition-none",
);
const ROW_PAGE = "flex w-full shrink-0 items-start";
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
 * One row, paged. The rail masks its right edge so a page that overruns the
 * column fades instead of being cut, and the two pagers sit outside that mask
 * so they always have a solid surface. `‹` appears only once there is a page
 * to go back to.
 */
function ComposerPagedRow({
  label,
  page,
  pageCount,
  onStep,
  gap,
  children,
}: {
  /** Set only when the row is the whole group; a shelf labels its wrapper. */
  readonly label?: string;
  readonly page: number;
  readonly pageCount: number;
  readonly onStep: (step: number) => void;
  readonly gap: string;
  /** One entry per page, in order; the key is the page it paints. */
  readonly children: readonly ReactNode[];
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="group"
      aria-label={label}
    >
      {page > 0 && (
        <Button
          type="button"
          variant="neutral"
          size="icon"
          className={ROW_PAGER}
          aria-label={t(($) => {
            return $.chat.taskChips.shelf.previousPage;
          })}
          onClick={() => {
            onStep(-1);
          }}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
      )}
      <div className={cn(ROW_RAIL, ROW_FADE)}>
        <div className={ROW_TRACK} style={{ "--page": page } as CSSProperties}>
          {children.map((content, index) => {
            const pageKey = `page-${String(index)}`;
            // Every page stays mounted so the track can slide, so the ones
            // off-screen have to leave the tab order and the accessibility
            // tree with it.
            return (
              <div
                key={pageKey}
                className={cn(ROW_PAGE, gap)}
                inert={index !== page}
              >
                {content}
              </div>
            );
          })}
        </div>
      </div>
      {page < pageCount - 1 && (
        <Button
          type="button"
          variant="neutral"
          size="icon"
          className={ROW_PAGER}
          aria-label={t(($) => {
            return $.chat.taskChips.shelf.nextPage;
          })}
          onClick={() => {
            onStep(1);
          }}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

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
  const stepPage = useSet(signals.taskChips.stepTemplatePage$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const pageCount = Math.max(
    Math.ceil(group.previews.length / TEMPLATES_PER_PAGE),
    1,
  );
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
  const pages = Array.from({ length: pageCount }, (_, index) => {
    return group.previews
      .slice(index * TEMPLATES_PER_PAGE, (index + 1) * TEMPLATES_PER_PAGE)
      .map((preview) => {
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
      });
  });
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
      <ComposerPagedRow
        page={page}
        pageCount={pageCount}
        gap="gap-3"
        onStep={(step) => {
          stepPage(task, step, pageCount);
        }}
      >
        {pages}
      </ComposerPagedRow>
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
  const stepPage = useSet(signals.taskChips.stepIdeaPage$);
  const insertPrompt = useSet(signals.editor.replacePromptText$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const icons = IDEA_ICONS[task];
  const pageCount = Math.max(Math.ceil(ideas.length / IDEAS_PER_PAGE), 1);
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => {
    return ideas
      .slice(pageIndex * IDEAS_PER_PAGE, (pageIndex + 1) * IDEAS_PER_PAGE)
      .map((idea, index) => {
        const Icon =
          icons[(pageIndex * IDEAS_PER_PAGE + index) % icons.length]!;
        return (
          <Button
            key={idea.label}
            type="button"
            variant="neutral"
            className="shrink-0"
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
            {idea.label}
          </Button>
        );
      });
  });
  return (
    <ComposerPagedRow
      label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
      page={page}
      pageCount={pageCount}
      gap="gap-2"
      onStep={(step) => {
        stepPage(task, step, pageCount);
      }}
    >
      {pages}
    </ComposerPagedRow>
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
          className="flex flex-wrap items-center justify-start gap-2"
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
                  variant="neutral"
                  onClick={() => {
                    selectTask(task);
                  }}
                >
                  <Icon
                    size={16}
                    className="text-muted-foreground"
                    aria-hidden
                  />
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
