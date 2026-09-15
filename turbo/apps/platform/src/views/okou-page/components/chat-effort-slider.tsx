import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@okouai/ui/lib/utils";

/** Keep in step with the handle's own width and the track's margin. */
const THUMB_WIDTH = "18px";
const THUMB_INSET = "9px";

/**
 * One dot per interior step. The track's two ends already read as the lowest
 * and highest step, so a mark drawn on top of them says the same thing twice;
 * the dots that remain divide the whole track evenly.
 *
 * `bg-divider` is the usual token for a painted rule, but it resolves to the
 * same value as `--gray-200`, which is this track's own fill -- a mark drawn in
 * it is invisible on the track and reads as a white speck over the texture.
 * These dots sit on the track rather than on a page surface, so they take the
 * ramp stop the shared `Slider` already uses for its own ticks.
 *
 * `passed` marks how many steps the handle has gone by. Those dots carry a
 * little more weight, because they sit on the heavier fill rather than on the
 * bare track.
 */
function InteriorTicks({
  count,
  passed,
}: {
  count: number;
  passed?: number | undefined;
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {Array.from({ length: Math.max(count - 2, 0) }, (_, index) => {
        const step = index + 1;
        return (
          <span
            key={index}
            className={cn(
              // A dot rather than a rule: it marks the stop without drawing a
              // line through the bar, which is what Claude and ChatGPT do.
              "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200",
              passed === undefined
                ? // The top step wipes the plain track away, taking the heavier
                  // marks with it, so the layer that survives carries the weight
                  // itself against the texture underneath.
                  "bg-gray-500/80 group-data-[at-max=true]/effort:bg-[color:var(--okou-effort-dot-on-texture)]"
                : step <= passed
                  ? "bg-gray-600/75"
                  : "bg-transparent",
            )}
            style={{
              insetInlineStart: `${String((step / (count - 1)) * 100)}%`,
            }}
          />
        );
      })}
    </div>
  );
}

interface ChatEffortSliderProps {
  /** Step count, lowest first. */
  readonly steps: number;
  /** Index of the selected step. */
  readonly value: number;
  readonly disabled: boolean;
  readonly label: string;
  /** The selected step in the user's words, for assistive technology. */
  readonly valueText: string;
  readonly onValueChange: (index: number) => void;
}

/**
 * The reasoning-effort bar.
 *
 * Below the highest step it is an ordinary slider: a grey track, a slightly
 * heavier grey up to the handle, and interior marks. At the highest step a warm
 * aurora is revealed underneath it.
 *
 * The reveal is one event, not two. The aurora is always painted; the plain
 * slider is an opaque layer on top of it, and reaching the top step wipes that
 * layer away by sliding its mask. So "the grey leaves" and "the colour
 * arrives" cannot drift apart, and there is nothing to keep in step. Earlier
 * attempts animated a custom property inside the mask's `calc()`, which some
 * engines snap to the end state in a single frame; `mask-position` is an
 * ordinary animatable property and interpolates everywhere.
 */
export function ChatEffortSlider({
  steps,
  value,
  disabled,
  label,
  valueText,
  onValueChange,
}: ChatEffortSliderProps) {
  const atMax = value === steps - 1;
  const progress = steps > 1 ? value / (steps - 1) : 1;
  const fillWidth = `calc(${THUMB_INSET} + ${String(progress)} * (100% - ${THUMB_WIDTH}))`;
  return (
    <SliderPrimitive.Root
      data-slot="chat-effort-slider"
      min={0}
      max={steps - 1}
      step={1}
      value={value}
      disabled={disabled}
      className="flex w-full flex-col"
      onValueChange={onValueChange}
    >
      <SliderPrimitive.Control
        data-at-max={atMax}
        className="group/effort relative h-8 w-full touch-none select-none"
      >
        {/* The aurora, always painted, always underneath. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 overflow-hidden rounded-[10px] bg-effort-aurora-ground"
        >
          <div
            className={cn(
              "absolute inset-0 bg-effort-aurora-peaks opacity-0 [background-size:97px_100%,61px_100%]",
              // Left weak, right strong: the texture is a function of x, so the
              // bar reads as an intensity ramp rather than as decoration.
              "[mask-image:linear-gradient(90deg,transparent_4%,#000_82%)]",
              "group-data-[at-max=true]/effort:animate-effort-aurora-peaks group-data-[at-max=true]/effort:opacity-100",
              "motion-reduce:animate-none",
            )}
          />
          <div
            className={cn(
              "absolute inset-0 bg-effort-aurora-curtain opacity-0 [background-size:151px_100%,211px_100%]",
              "group-data-[at-max=true]/effort:animate-effort-aurora-curtain group-data-[at-max=true]/effort:opacity-100",
              "motion-reduce:animate-none",
            )}
          />
        </div>

        {/* The plain slider, opaque, wiped away at the top step. Its mask is
            twice the track's width so the soft edge travels the full length
            instead of compressing into it. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 overflow-hidden rounded-[10px] bg-gray-200",
            "[mask-image:linear-gradient(90deg,#000_0_45%,transparent_100%)] [mask-position:0%_0] [mask-repeat:no-repeat] [mask-size:220%_100%]",
            "transition-[mask-position] duration-[900ms] ease-[cubic-bezier(0.37,0,0.63,1)]",
            "group-data-[at-max=true]/effort:[mask-position:200%_0] group-data-[at-max=true]/effort:duration-[1600ms]",
            "motion-reduce:transition-none",
          )}
        >
          {/* The fill ends on the handle's middle, so it is measured against
                the same travel the handle has. */}
          <div
            className="absolute inset-y-0 left-0 bg-gray-400/60 transition-[width] duration-200 ease-[cubic-bezier(0.34,1.32,0.58,1)] motion-reduce:transition-none"
            style={{ width: fillWidth }}
          />
          <InteriorTicks count={steps} passed={value} />
        </div>
        <InteriorTicks count={steps} />

        {/* The handle travels inside the track rather than across its centre
            line: at the lowest step its left edge sits on the track's left
            edge, at the highest its right edge sits on the right edge. The
            primitive centres the handle on the value within this element, so
            the inset is expressed as layout. It has to be a margin: the
            primitive sets `position: relative` on the track inline, which beats
            a class, and `inset-inline-start`/`inset-inline-end` do not size a
            relatively positioned box. */}
        <SliderPrimitive.Track className="relative mx-[9px] h-full">
          <SliderPrimitive.Thumb
            aria-label={label}
            aria-valuetext={valueText}
            className={cn(
              "h-9 w-[18px] bg-gray-300 outline-none [clip-path:var(--okou-effort-thumb-clip)] dark:bg-gray-500",
              "drop-shadow-[0_1px_2px_hsl(var(--state-layer)/0.22)]",
              // Quantized values want a magnetic landing rather than a linear
              // one, so the handle overshoots its stop slightly and settles.
              "transition-[inset-inline-start] duration-200 ease-[cubic-bezier(0.34,1.32,0.58,1)]",
              "motion-reduce:transition-none",
            )}
          >
            {/* The handle's body. `clip-path` cuts a border off with everything
                else, so the outline is this shape inset by 1px inside the one
                above. */}
            <span
              aria-hidden="true"
              className="absolute inset-px block h-[34px] w-4 bg-card [clip-path:var(--okou-effort-thumb-body-clip)] dark:bg-gray-700"
            />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
