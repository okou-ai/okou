import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@okouai/ui/lib/utils";

/**
 * Half the handle's width. The handle travels inside the track rather than
 * across its centre line, so at the lowest step its left edge sits on the
 * track's left edge and at the highest step its right edge sits on the right
 * edge. Base UI positions the handle by the value's percentage of the element
 * it lives in, so the inset is expressed as layout: the control is the visible
 * track, and the primitive's own track is that box pulled in by this much on
 * each side.
 */
const THUMB_WIDTH = "18px";
const THUMB_INSET = "9px";

/**
 * One mark per interior step. The track's two ends already read as the lowest
 * and highest step, so a mark drawn on top of them says the same thing twice;
 * the marks that remain divide the whole track evenly.
 */
function InteriorTicks({ count }: { count: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {Array.from({ length: Math.max(count - 2, 0) }, (_, index) => {
        return (
          <span
            key={index}
            className="absolute inset-y-0 -ml-px w-px bg-divider"
            style={{
              insetInlineStart: `${String(((index + 1) / (count - 1)) * 100)}%`,
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
        className="group/effort relative h-9 w-full touch-none select-none"
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
              the same travel the handle has rather than against the primitive's
              inset track. */}
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-200 ease-[cubic-bezier(0.34,1.32,0.58,1)] motion-reduce:transition-none bg-gray-400/60"
            style={{ width: fillWidth }}
          />
          <InteriorTicks count={steps} />
        </div>
        <InteriorTicks count={steps} />

        <SliderPrimitive.Track
          className="absolute inset-y-0"
          style={{ left: THUMB_INSET, right: THUMB_INSET }}
        >
          <SliderPrimitive.Thumb
            aria-label={label}
            aria-valuetext={valueText}
            className={cn(
              "h-10 w-[18px] bg-gray-300 outline-none [clip-path:var(--okou-effort-thumb-clip)] dark:bg-gray-500",
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
              className="absolute inset-px block h-[38px] w-4 bg-card [clip-path:var(--okou-effort-thumb-body-clip)] dark:bg-gray-700"
            />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
