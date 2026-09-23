import { type HTMLAttributes, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

type RunningIndicatorProps = HTMLAttributes<HTMLSpanElement>;

// Keep this in sync with the animation durations in globals.css.
const RUNNING_INDICATOR_CYCLE_MS = 2400;

/**
 * A decorative breathing dot; its owner supplies localized status text.
 * Both animated layers set `transform` directly rather than
 * Tailwind's `translate`/`scale` utilities: the keyframes animate `transform`,
 * and the individual properties would compose on top of that animation instead
 * of being replaced by it, which would double the centring offset for the whole
 * cycle. The resting values match each animation's 0% frame so a layer that has
 * not started yet — iOS WebKit after the mobile sidebar becomes visible — still
 * sits where the first frame puts it.
 */
function RunningIndicator({ className, ...rest }: RunningIndicatorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  // Anchor every indicator to the same wall-clock cycle grid via a negative
  // animation-delay so the pulses stay in phase regardless of when each row
  // mounts (e.g. virtualized sidebar rows that mount at different times).
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    node.style.setProperty(
      "--running-indicator-delay",
      `-${Date.now() % RUNNING_INDICATOR_CYCLE_MS}ms`,
    );
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-[0.86rem] rounded-full text-sky-600",
        className,
      )}
      {...rest}
    >
      <span
        className="absolute top-1/2 left-1/2 rounded-[inherit] origin-center [animation-delay:var(--running-indicator-delay,0ms)] size-[calc(100%-5px)] bg-current opacity-[0.34] [transform:translate(-50%,-50%)_scale(0.64)] animate-running-indicator-center"
        aria-hidden
      />
      <span
        className="absolute top-1/2 left-1/2 rounded-[inherit] origin-center [animation-delay:var(--running-indicator-delay,0ms)] size-[calc(100%-3px)] border border-current opacity-0 [transform:translate(-50%,-50%)_scale(0.8)] animate-running-indicator-ripple"
        aria-hidden
      />
    </span>
  );
}

export { RunningIndicator, type RunningIndicatorProps };
