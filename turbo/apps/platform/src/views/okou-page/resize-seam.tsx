import type { Ref } from "react";
import { cn } from "@okouai/ui";

/**
 * A focusable divider on the boundary between two resizable panes, shaped
 * like shadcn's `ResizableHandle`: the element itself has no width, an
 * `::after` layer widens the pointer target to 12px across the boundary, and
 * a `::before` line takes the brand colour for hover (after 150ms, so a
 * pointer passing over the edge does not flash it), drag and keyboard focus.
 * Only the line's colour changes, so the divider never shifts either pane.
 *
 * The caller places it and owns the resting line: either the divider's own
 * border, in flow between the panes, or the pane border it is positioned on.
 * The primitive does not assign a z-index. The owning layout decides whether
 * the target must paint above a later pane to keep both halves reachable.
 */
export function ResizeSeam({
  ref,
  label,
  valueMin,
  valueMax,
  valueNow,
  resizing,
  widthKey,
  className,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly label: string;
  readonly valueMin: number;
  readonly valueMax?: number;
  readonly valueNow: number | null;
  readonly resizing: boolean;
  readonly widthKey?: string;
  readonly className?: string;
}) {
  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow ?? undefined}
      data-width-key={widthKey}
      data-resizing={resizing ? "" : undefined}
      className={cn(
        "relative w-0 shrink-0 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:transition-colors before:delay-0 before:duration-150",
        "hover:before:bg-primary hover:before:delay-150",
        "focus-visible:before:bg-primary focus-visible:before:delay-0",
        "data-[resizing]:before:bg-primary data-[resizing]:before:delay-0",
        className,
      )}
    />
  );
}
