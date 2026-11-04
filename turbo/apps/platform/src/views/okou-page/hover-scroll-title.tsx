import { cn } from "@okouai/ui";

/**
 * CSS compares the max-content text width (100%) with its clipping container
 * (100cqw). Both fades and travel therefore stay correct without measuring at
 * mount or after content/layout changes. Only pacing is sampled by the
 * containing control's useTitleReveal input handlers.
 *
 * Tile titles centre when they fit. Auto inline margins cannot go negative,
 * so clipped titles still start at the leading edge.
 */
export function HoverScrollTitle({
  title,
  className,
  variant = "row",
  "data-slot": slot = "hover-scroll-title",
}: {
  readonly title: string;
  readonly className?: string;
  readonly variant?: "row" | "tile";
  readonly "data-slot"?: string;
}) {
  return (
    <span
      data-slot={slot}
      data-title-reveal=""
      className={cn(
        "min-w-0 overflow-hidden [container-type:inline-size]",
        variant === "tile"
          ? "w-full [--okou-nav-title-fade:12px]"
          : "flex-1 [--okou-nav-title-fade:24px]",
        "[--okou-nav-title-progress:0]",
        // CSS reversals shorten the full-distance duration to the remaining
        // fraction. Both directions stop immediately for reduced motion.
        "motion-safe:[transition:--okou-nav-title-progress_660ms_cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
        "motion-safe:data-title-revealing:[transition:--okou-nav-title-progress_var(--okou-nav-title-duration)_linear_750ms]",
        "motion-safe:data-title-revealing:[--okou-nav-title-progress:1]",
        className,
      )}
    >
      <span
        className={cn(
          "block w-max whitespace-nowrap motion-reduce:[--okou-nav-title-progress:0]",
          "[--okou-nav-title-distance:max(0px,calc(100%_-_100cqw))]",
          "[--okou-nav-title-offset:calc(var(--okou-nav-title-progress)*var(--okou-nav-title-distance))]",
          "[transform:translateX(calc(-1*var(--okou-nav-title-offset)))]",
          "[mask-image:linear-gradient(90deg,transparent_var(--okou-nav-title-offset),#000_calc(var(--okou-nav-title-offset)_+_min(var(--okou-nav-title-offset),var(--okou-nav-title-fade))),#000_calc(100cqw_+_var(--okou-nav-title-offset)_-_min(calc((1_-_var(--okou-nav-title-progress))*var(--okou-nav-title-distance)),var(--okou-nav-title-fade))),transparent_calc(100cqw_+_var(--okou-nav-title-offset)))]",
          "mask-no-repeat [mask-size:100%_100%]",
          variant === "tile" && "mx-auto",
        )}
      >
        {title}
      </span>
    </span>
  );
}
