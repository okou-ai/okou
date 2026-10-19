import { useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { threadTitleOverflowRef$ } from "../../signals/chat-page/thread-title-overflow.ts";

/**
 * Fade clipped titles and reveal their end while the containing link is hovered
 * or keyboard-focused. The measured overflow drives both the mask and travel,
 * so fitting titles stay still. The registered shift property is inherited by
 * the text span and stays at zero for reduced motion.
 */
export function ChatThreadTitle({
  title,
  className,
  "data-slot": slot = "chat-thread-title",
}: {
  readonly title: string;
  readonly className?: string;
  readonly "data-slot"?: string;
}) {
  const measureTitle = useSet(threadTitleOverflowRef$);

  return (
    <span
      data-slot={slot}
      ref={measureTitle}
      className={cn(
        "min-w-0 flex-1 overflow-hidden",
        "[--okou-nav-title-overflow:0px] [--okou-nav-title-duration:780ms] [--okou-nav-title-fade:24px]",
        "[mask-image:linear-gradient(90deg,transparent_0,#000_clamp(0px,calc(-1*var(--okou-nav-title-shift)),var(--okou-nav-title-fade)),#000_calc(100%_-_clamp(0px,calc(var(--okou-nav-title-overflow)_+_var(--okou-nav-title-shift)),var(--okou-nav-title-fade))),transparent_100%)]",
        "mask-no-repeat [mask-size:100%_100%]",
        // Restore the start without a delay when the pointer or focus leaves.
        "[transition:--okou-nav-title-shift_660ms_cubic-bezier(0.4,0,0.2,1)]",
        // Keep the sidebar's coarse-pointer behavior: group-hover would gate
        // this behind @media (hover: hover). The delay ignores passing pointers.
        "[:is(a:hover,a:focus-visible)_&]:[transition:--okou-nav-title-shift_var(--okou-nav-title-duration)_cubic-bezier(0.33,0,0.2,1)_750ms]",
        "motion-safe:[:is(a:hover,a:focus-visible)_&]:[--okou-nav-title-shift:calc(-1*var(--okou-nav-title-overflow))]",
        className,
      )}
    >
      <span className="block w-max whitespace-nowrap [transform:translateX(var(--okou-nav-title-shift))]">
        {title}
      </span>
    </span>
  );
}
