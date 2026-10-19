import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { titleOverflowRef$ } from "../../signals/chat-page/title-overflow.ts";

/**
 * Fade clipped titles and reveal their end while the containing control is hovered
 * or keyboard-focused. The measured overflow drives both the mask and travel,
 * so fitting titles stay still. The registered shift property is inherited by
 * the text span and stays at zero for reduced motion.
 *
 * `variant="tile"` labels an icon tile: the title fills the tile's width,
 * centres when it fits, and fades over 12px because the label is only a few
 * dozen pixels wide. Auto inline margins cannot go negative, so a clipped tile
 * title still starts at the leading edge, where the measured overflow and the
 * trailing fade expect it.
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
  const measureTitle = useSet(titleOverflowRef$);

  return (
    <span
      data-slot={slot}
      ref={measureTitle}
      className={cn(
        "min-w-0 overflow-hidden",
        variant === "tile"
          ? "w-full [--okou-nav-title-fade:12px]"
          : "flex-1 [--okou-nav-title-fade:24px]",
        "[--okou-nav-title-overflow:0px] [--okou-nav-title-duration:780ms]",
        "[mask-image:linear-gradient(90deg,transparent_0,#000_clamp(0px,calc(-1*var(--okou-nav-title-shift)),var(--okou-nav-title-fade)),#000_calc(100%_-_clamp(0px,calc(var(--okou-nav-title-overflow)_+_var(--okou-nav-title-shift)),var(--okou-nav-title-fade))),transparent_100%)]",
        "mask-no-repeat [mask-size:100%_100%]",
        // Restore the start without a delay when the pointer or focus leaves.
        "[transition:--okou-nav-title-shift_660ms_cubic-bezier(0.4,0,0.2,1)]",
        // Keep the sidebar's coarse-pointer behavior: group-hover would gate
        // this behind @media (hover: hover). The delay ignores passing pointers.
        "[:is(a:hover,a:focus-visible,button:hover,button:focus-visible)_&]:[transition:--okou-nav-title-shift_var(--okou-nav-title-duration)_cubic-bezier(0.33,0,0.2,1)_750ms]",
        "motion-safe:[:is(a:hover,a:focus-visible,button:hover,button:focus-visible)_&]:[--okou-nav-title-shift:calc(-1*var(--okou-nav-title-overflow))]",
        className,
      )}
    >
      <span
        className={cn(
          "block w-max whitespace-nowrap [transform:translateX(var(--okou-nav-title-shift))]",
          variant === "tile" && "mx-auto",
        )}
      >
        {title}
      </span>
    </span>
  );
}
