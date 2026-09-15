import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
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
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
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
      className={cn(RAIL_TILE, width)}
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
          className="h-full w-full object-cover object-center transition-transform duration-200 group-hover/tile:scale-[1.04]"
        />
      </span>
      <span className={RAIL_TILE_CAPTION}>{preview.title}</span>
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
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
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
      <ComposerRail
        signals={signals}
        rail={`templates:${task}`}
        gap="gap-3"
        items={group.previews.map((preview) => {
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
      />
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
  const insertPrompt = useSet(signals.editor.replacePromptText$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const icons = IDEA_ICONS[task];
  return (
    <ComposerRail
      signals={signals}
      rail={`ideas:${task}`}
      label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
      gap="gap-2"
      items={ideas.map((idea, index) => {
        const Icon = icons[index % icons.length]!;
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
      })}
    />
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
      {selected !== null && (
        // Keyed by the type so switching remounts the panel: a CSS entry runs
        // on mount, and the rails inside start again from their first item and
        // their own left edge, which is where a new catalog should begin.
        <div
          key={selected}
          className={cn(
            "flex min-w-0 flex-col gap-5",
            "motion-safe:animate-composer-panel-in",
          )}
        >
          {selected === "presentation" && (
            <ComposerPresentationRecommendations signals={signals} />
          )}
          {selected === "workflow" && (
            <ComposerWorkflowRecommendations signals={signals} />
          )}
          {selected === "visualization" && (
            <ComposerVisualizationOptions signals={signals} />
          )}
          {selected !== "presentation" &&
            selected !== "workflow" &&
            selected !== "visualization" && (
              <>
                <ComposerTaskIdeas signals={signals} task={selected} />
                <ComposerTemplateShelf signals={signals} task={selected} />
              </>
            )}
        </div>
      )}
    </section>
  );
}
