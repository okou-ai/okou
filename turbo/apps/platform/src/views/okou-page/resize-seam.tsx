import type { Ref } from "react";
import { cn } from "@okouai/ui";

/**
 * A focusable 12px pointer target on the edge between two resizable panes.
 * The caller positions it and leaves the resting line to the panes' own
 * border. Hover waits 150ms before showing a 2px line, so a pointer passing
 * over the edge does not flash it; a drag darkens the line and keyboard focus
 * paints it in the ring colour.
 *
 * The target never takes a z-index. Each caller places it later in tree order
 * than the panes it overlaps, or wholly inside one of them, so ordinary paint
 * order puts it on top without ranking it against the shell.
 */
export function ResizeSeam({
  ref,
  label,
  valueMin,
  valueMax,
  valueNow,
  resizing,
  line,
  widthKey,
  className,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly label: string;
  readonly valueMin: number;
  readonly valueMax?: number;
  readonly valueNow: number | null;
  readonly resizing: boolean;
  /** Where the edge falls in the target: its middle, or its trailing side. */
  readonly line: "center" | "end";
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
        "group w-3 cursor-col-resize touch-none outline-none",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px transition-[width,background-color] delay-0 duration-150",
          line === "center" ? "left-1/2 -translate-x-1/2" : "right-0",
          "group-hover:w-0.5 group-hover:bg-gray-500 group-hover:delay-150",
          "group-focus-visible:w-0.5 group-focus-visible:bg-ring group-focus-visible:delay-0",
          "group-data-[resizing]:w-0.5 group-data-[resizing]:bg-gray-700 group-data-[resizing]:delay-0",
        )}
      />
    </div>
  );
}
