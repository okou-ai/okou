import {
  type AnimationEvent,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

type RunningIndicatorProps = HTMLAttributes<HTMLSpanElement> & {
  /** Fraction of a breathing cycle by which this indicator trails phase zero. */
  phaseOffset?: number;
};

function synchronizeAnimation({
  currentTarget,
}: AnimationEvent<HTMLSpanElement>) {
  // CSS recreates animations after an ancestor stops being display:none.
  // Align every start to the same document timeline origin, including restarts.
  for (const animation of currentTarget.getAnimations()) {
    animation.startTime = 0;
  }
}

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
function RunningIndicator({
  className,
  style,
  phaseOffset = 0,
  ...rest
}: RunningIndicatorProps) {
  // Equivalent nonpositive delay: enter the wave immediately, even on a young
  // document or at a large list index. CSS updates preserve the shared origin.
  const phasedStyle: CSSProperties & { "--running-indicator-phase": number } = {
    ...style,
    "--running-indicator-phase": ((phaseOffset % 1) - 1) % 1,
  };

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-[0.86rem] rounded-full text-sky-600",
        className,
      )}
      style={phasedStyle}
      {...rest}
    >
      <span
        className="absolute top-1/2 left-1/2 rounded-[inherit] origin-center size-[calc(100%-5px)] bg-current opacity-[0.34] [transform:translate(-50%,-50%)_scale(0.64)] [animation-delay:calc(var(--running-indicator-phase)*var(--duration-running-indicator))] animate-running-indicator-center"
        onAnimationStart={synchronizeAnimation}
        aria-hidden
      />
      <span
        className="absolute top-1/2 left-1/2 rounded-[inherit] origin-center size-[calc(100%-3px)] border border-current opacity-0 [transform:translate(-50%,-50%)_scale(0.8)] [animation-delay:calc(var(--running-indicator-phase)*var(--duration-running-indicator))] animate-running-indicator-ripple"
        onAnimationStart={synchronizeAnimation}
        aria-hidden
      />
    </span>
  );
}

export { RunningIndicator, type RunningIndicatorProps };
