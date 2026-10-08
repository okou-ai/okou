import type { Ref } from "react";
import { cn, Toggle, ToggleGroup } from "@okouai/ui";

import {
  SCROLLBAR_HIDDEN,
  SCROLL_FADE_X,
  type ScrollFade,
} from "./scroll-fade.ts";

interface TemplateFilterPill {
  readonly id: string;
  readonly label: string;
}

/**
 * The template picker's filter row: a wall of cards below a search box, with
 * one control for narrowing it.
 *
 * `layout` lets a caller choose how the pills use the dialog's height. The
 * workflow tab's personas grow with the catalog and `wrap` onto as many lines
 * as they need; a fixed set of groups stays on one `scroll`ing line instead.
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
    <ToggleGroup
      ref={scrollerRef}
      value={[active]}
      onValueChange={(value) => {
        onSelect(value[0] ?? active);
      }}
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
        return (
          <Toggle key={pill.id} value={pill.id} variant="filter">
            {pill.label}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}
