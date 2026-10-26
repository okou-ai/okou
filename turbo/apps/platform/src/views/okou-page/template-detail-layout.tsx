import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SCROLL_FADE_X_WHEN_OVERFLOWING } from "./scroll-fade.ts";
import { TEMPLATE_TILE_MEDIA } from "./template-tile.ts";

/**
 * The template detail page every template kind opens into: a stage or viewer,
 * a filmstrip where there are pages, a side column, and a footer holding the
 * action. Built-in and custom templates compose these pieces as one surface.
 */

// The template detail page: one body under the header, whose height the dialog
// alone owns, and a footer holding the actions. The page keeps one 24px margin
// on every side, the footer included, so nothing pools between the content and
// the actions. From lg the body is a size container: the stage takes the 16:9
// box that fits beside the side column and above a filmstrip of at least 85px,
// and the filmstrip takes whatever height is left, so its thumbnails grow
// rather than leaving a band of empty space above the footer.
export const TEMPLATE_DETAIL_BODY =
  "min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-0.5 duration-200 motion-reduce:animate-none lg:overflow-hidden lg:[container-type:size]";
export const TEMPLATE_DETAIL_GRID =
  "grid gap-3 lg:h-full lg:grid-cols-[auto_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-x-6";
export const TEMPLATE_DETAIL_FOOTER =
  "flex shrink-0 items-center gap-3 px-6 pb-6 [&>:last-child]:ml-auto";

// The stage is as wide as the body allows once the side column keeps its
// 220px floor and the 24px gap beside it, and as tall as the body allows once
// the filmstrip's smallest 85px row and the 12px gap under it are taken. The
// smaller of the two decides, so the slide is never cropped or letterboxed.
// Spelled out because Tailwind only emits what it finds written.
export const TEMPLATE_DETAIL_STAGE = cn(
  TEMPLATE_TILE_MEDIA,
  "group/stage isolate aspect-video focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:col-start-1 lg:row-start-1 lg:w-[min(calc(100cqw_-_244px),calc((100cqh_-_97px)*16/9))]",
);

// The stage controls sit on cover art, which looks the same in both themes, so
// the counter is literal white on a literal black like `TEMPLATE_TILE_SCRIM`
// (the `white` token flips in Dark). Arrows appear on hover where the pointer
// can hover, without an opacity transition, and stay visible on touch.
export const TEMPLATE_DETAIL_STAGE_ARROW =
  "absolute top-1/2 z-50 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 text-foreground backdrop-blur hover:bg-background focus-visible:outline-none disabled:hidden [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/stage:opacity-100 [@media(hover:hover)]:group-focus-visible/stage:opacity-100";

export function TemplateDetailStageControls({
  activeSlideIndex,
  slideCount,
  onChange,
}: {
  readonly activeSlideIndex: number;
  readonly slideCount: number;
  readonly onChange: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        aria-label={t(($) => {
          return $.artifacts.templates.previousSlide;
        })}
        disabled={activeSlideIndex === 0}
        tabIndex={-1}
        onClick={() => {
          onChange(activeSlideIndex - 1);
        }}
        className={cn(TEMPLATE_DETAIL_STAGE_ARROW, "left-3")}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        aria-label={t(($) => {
          return $.artifacts.templates.nextSlide;
        })}
        disabled={activeSlideIndex >= slideCount - 1}
        tabIndex={-1}
        onClick={() => {
          onChange(activeSlideIndex + 1);
        }}
        className={cn(TEMPLATE_DETAIL_STAGE_ARROW, "right-3")}
      >
        <ChevronRight size={16} />
      </button>
      <span className="pointer-events-none absolute bottom-3 right-3 z-50 rounded-md bg-[rgb(0_0_0_/_0.55)] px-2 py-0.5 text-xs font-medium tabular-nums text-[#ffffff]">
        {t(
          ($) => {
            return $.artifacts.templates.slideCounter;
          },
          { current: activeSlideIndex + 1, total: slideCount },
        )}
      </span>
    </>
  );
}

// The filmstrip's edge fade, `SCROLL_FADE_X_WHEN_OVERFLOWING`; change together.
const TEMPLATE_DETAIL_FILMSTRIP_FADE = 24;

// Keep this ref stable: the strip follows the selection only when a different
// thumbnail becomes the active one, not on every theme or HTML re-render. It
// moves the strip alone, by just enough to clear the edge fade, so a short
// dialog body is never scrolled to bring the filmstrip into view.
function scrollActiveTemplateThumbnailIntoStrip(
  thumbnail: HTMLButtonElement | null,
): (() => void) | undefined {
  if (!thumbnail) {
    return;
  }
  const frame = window.requestAnimationFrame(() => {
    // The thumbnail always renders inside the filmstrip's viewport.
    const strip = thumbnail.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!;
    const stripBox = strip.getBoundingClientRect();
    const tileBox = thumbnail.getBoundingClientRect();
    const hiddenBefore =
      stripBox.left + TEMPLATE_DETAIL_FILMSTRIP_FADE - tileBox.left;
    const hiddenAfter =
      tileBox.right - (stripBox.right - TEMPLATE_DETAIL_FILMSTRIP_FADE);
    if (hiddenBefore > 0) {
      strip.scrollLeft -= hiddenBefore;
    } else if (hiddenAfter > 0) {
      strip.scrollLeft += hiddenAfter;
    }
  });
  return () => {
    window.cancelAnimationFrame(frame);
  };
}

// A single row with no scrollbar of its own: the edge fades say there is more,
// and the stage arrows, the keyboard and the active tile's own scrolling move
// along it.
export function TemplateDetailFilmstrip({
  slideCount,
  activeSlideIndex,
  onChange,
  onKeyDown,
  renderThumbnail,
}: {
  readonly slideCount: number;
  readonly activeSlideIndex: number;
  readonly onChange: (index: number) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly renderThumbnail: (slideIndex: number) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ScrollArea.Root className="group relative -mx-0.5 min-w-0 lg:col-span-2 lg:row-start-2 lg:h-full">
      <ScrollArea.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          SCROLL_FADE_X_WHEN_OVERFLOWING,
          "focus-visible:outline-none lg:h-full",
        )}
      >
        <ScrollArea.Content
          className="flex w-max gap-2 p-0.5 lg:h-full"
          onKeyDown={onKeyDown}
        >
          {Array.from({ length: slideCount }, (_, slideIndex) => {
            const slideNumber = slideIndex + 1;
            const active = slideIndex === activeSlideIndex;
            return (
              <button
                key={slideNumber}
                ref={
                  active ? scrollActiveTemplateThumbnailIntoStrip : undefined
                }
                type="button"
                aria-label={t(
                  ($) => {
                    return $.artifacts.templates.previewSlide;
                  },
                  { slideNumber },
                )}
                aria-pressed={active}
                onClick={() => {
                  onChange(slideIndex);
                }}
                className={cn(
                  "relative aspect-video w-[144px] shrink-0 overflow-hidden rounded-lg border border-border bg-muted lg:h-full lg:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-lg after:border-(length:--border-width-emphasis) after:border-transparent after:transition-colors",
                  active
                    ? "after:border-primary"
                    : "hover:after:border-muted-foreground/40",
                )}
              >
                {renderThumbnail(slideIndex)}
              </button>
            );
          })}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
    </ScrollArea.Root>
  );
}

// The column beside the stage. From lg it is laid out against the stage's box
// and scrolls inside it, so it never adds height to the row.
export function TemplateDetailSideColumn({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div className="relative min-w-0 pt-3 lg:col-start-2 lg:row-start-1 lg:pt-0">
      <div className="flex flex-col lg:absolute lg:inset-0">{children}</div>
    </div>
  );
}

/**
 * A template's name, said once: as the last step of the header's breadcrumb,
 * editable in place where the member can manage it. The field sits beside the
 * dialog's title rather than inside it, so the heading that names the dialog
 * stays text; it matches the breadcrumb's type, shows its edge only on hover
 * and focus, and grows to wrap rather than scroll a long name. A textarea over an invisible mirror
 * of its value does the growing, so the mirror's `data-value` must follow the
 * field on every change. `-ml-1.5` keeps the text on the breadcrumb's line.
 */
export const TEMPLATE_DETAIL_TITLE_FIELD =
  "-my-1 -ml-1.5 grid min-w-0 max-w-full rounded-md border border-transparent px-1.5 py-1 text-base font-semibold leading-6 text-foreground transition-colors after:col-start-1 after:row-start-1 after:invisible after:whitespace-pre-wrap after:break-words after:content-[attr(data-value)_'_'] hover:border-[hsl(var(--gray-400))] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10";
export const TEMPLATE_DETAIL_TITLE_TEXTAREA =
  "col-start-1 row-start-1 resize-none overflow-hidden break-words bg-transparent p-0 outline-none";

export function normalizeTemplateTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Who can use a template: the level on the first line and what it means under
 * it, the way a select states a choice. Where the member can change it, the
 * whole block is the trigger, with its chevron on the level's line, so nothing
 * wraps by accident and no separator is left dangling at a line end.
 */
export function TemplateDetailAccess({
  icon: Icon,
  level,
  consequence,
  triggerLabel,
  disabled = false,
  children,
}: {
  readonly icon: LucideIcon;
  readonly level: ReactNode;
  readonly consequence?: ReactNode;
  readonly triggerLabel?: string;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  const body = (
    <>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">{level}</span>
        {consequence === undefined ? null : (
          <span className="text-xs text-muted-foreground">{consequence}</span>
        )}
      </span>
    </>
  );
  if (children === undefined) {
    return (
      <p className="flex items-start gap-2 text-muted-foreground">{body}</p>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 data-[popup-open]:bg-state-hover"
      >
        {body}
        {/* Named by what it shows, so the level a screen reader announces
            and the one a voice command says are the visible "Private". */}
        <span className="sr-only">{triggerLabel}</span>
        <ChevronDown size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[19rem] p-1.5"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Deleting is the one action that ends the template, so it waits in the footer
 * across from "Use this template" rather than standing in the side column as
 * the loudest thing there. Quiet at rest; destructive once pointed at.
 */
export function TemplateDetailDeleteButton({
  label,
  pending = false,
  onDelete,
}: {
  readonly label: string;
  readonly pending?: boolean;
  readonly onDelete: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      disabled={pending}
      className="-ml-3 hover:text-destructive"
      onClick={onDelete}
    >
      {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      {label}
    </Button>
  );
}
