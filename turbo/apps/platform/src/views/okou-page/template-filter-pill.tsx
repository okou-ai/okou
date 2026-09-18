import type { Ref } from "react";
import { cn } from "@okouai/ui";

import type { ScrollFade } from "../../signals/okou-page/intro-video-picker.ts";
import { SCROLLBAR_HIDDEN, SCROLL_FADE_X } from "./scroll-fade.ts";

interface TemplateFilterPill {
  readonly id: string;
  readonly label: string;
}

/**
 * The template picker's filter row, shared by the workflow tab and the intro
 * video style gallery. The two filter the same kind of surface — a wall of
 * cards below a search box — so they have to read as one control, which is
 * what stopped the intro video gallery from keeping its own outlined toggle
 * buttons.
 *
 * `layout` is the one thing the two tabs disagree on. The workflow tab's
 * personas grow with the catalog and `wrap` onto as many lines as they need;
 * the style groups are a fixed seven, so they stay on one `scroll`ing line
 * rather than spending a second line of the dialog's height.
 *
 * The caller owns the row's padding, because each tab indents its content to a
 * different gutter, and supplies `label` when the row is a named group for
 * assistive technology.
 */
export function TemplateFilterPillRow({
  pills,
  active,
  label,
  className,
  layout = "wrap",
  fade,
  scrollerRef,
  onSelect,
}: {
  readonly pills: readonly TemplateFilterPill[];
  readonly active: string;
  readonly label?: string;
  readonly className?: string;
  readonly layout?: "wrap" | "scroll";
  readonly fade?: ScrollFade;
  readonly scrollerRef?: Ref<HTMLDivElement>;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <div
      ref={scrollerRef}
      role={label === undefined ? undefined : "group"}
      aria-label={label}
      data-fade={fade === "none" ? undefined : fade}
      className={cn(
        "flex items-center gap-1.5",
        layout === "wrap"
          ? "flex-wrap"
          : ["overflow-x-auto", SCROLLBAR_HIDDEN, SCROLL_FADE_X],
        className,
      )}
    >
      {pills.map((pill) => {
        const isActive = active === pill.id;
        return (
          <button
            key={pill.id}
            type="button"
            aria-pressed={isActive}
            className={cn(
              "h-7 shrink-0 cursor-pointer rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
            onClick={() => {
              onSelect(pill.id);
            }}
          >
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
