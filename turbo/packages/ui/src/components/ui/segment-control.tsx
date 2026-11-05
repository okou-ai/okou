"use client";

import * as React from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";

type SegmentControlSize = "xs" | "sm" | "default" | "lg";

/**
 * `default` is the tracked control: a recessed track with the selected segment
 * raised out of it. `plain` is the same control without the track -- segments
 * sit straight on whatever surface holds them, and the selection is marked
 * with the shared selected layer instead of a raised fill. The raised fill
 * needs a track to lift off; on a bare surface it reads as a stray card.
 *
 * The two treatments are variants rather than class overrides because the
 * selected fill and its shadow are separate utilities that a consumer's
 * `className` cannot reliably take back.
 */
type SegmentControlVariant = "default" | "plain";

interface SegmentControlContextValue {
  size: SegmentControlSize;
  variant: SegmentControlVariant;
}

const SegmentControlContext = React.createContext<SegmentControlContextValue>({
  size: "default",
  variant: "default",
});

/**
 * The track carries the same heights and radius as the rest of the control
 * scale, so a segment control drops into a toolbar next to a button, select,
 * or input without a step. The sizes mirror `buttonVariants` one for one --
 * `xs` h-7, `sm` h-8, `default` h-9 (also Input and SelectTrigger), `lg` h-10
 * -- and every size uses `rounded-lg`.
 *
 * `--muted` is gray-100 in light and gray-200 in dark, which is a recessed
 * step under the selected segment in both themes.
 */
const segmentControlVariants = cva(
  "inline-flex items-center gap-0.5 rounded-lg",
  {
    variants: {
      size: {
        xs: "h-7",
        sm: "h-8",
        default: "h-9",
        lg: "h-10",
      },
      variant: {
        default: "bg-segment-track p-0.5",
        // No track means nothing to inset the segments from, so the track
        // padding goes with it and a segment is the full control height.
        plain: "p-0",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  },
);

/**
 * `rounded-md` keeps the segment concentric with the track: the 8px outer
 * radius minus the 2px of track padding it sits inside.
 *
 * A selected `default` segment carries an opaque fill, so it must not take the
 * translucent `state-hover` layer -- the layer replaces a fill instead of
 * sitting on it, which would drop the segment back to the track colour. The
 * hover rule stays scoped to the unselected segments for `plain` too, where
 * the selection is itself a state layer.
 */
const segmentControlItemVariants = cva(
  "inline-flex h-full shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors select-none not-data-checked:hover:bg-state-hover not-data-checked:hover:text-foreground data-checked:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    // Segment padding runs one step tighter than the matching button size,
    // because the segment already sits inside the track's 2px inset -- that
    // puts the label the same optical distance from the outer edge as a
    // button of the same size. `xs` drops to `text-xs`: the h-7 track leaves a
    // 24px segment, where `text-sm`'s 20px line box would clear only 2px a
    // side against the 4px an h-7 button gives it.
    variants: {
      size: {
        xs: "px-2 text-xs",
        sm: "px-2.5 text-sm",
        default: "px-3 text-sm",
        lg: "px-5 text-sm",
      },
      variant: {
        default:
          "data-checked:bg-segment-selected data-checked:shadow-segment-selected",
        // The selected layer reads on any surface and reverses in dark, so a
        // trackless segment needs no raised fill -- and no shadow with it.
        plain: "data-checked:bg-state-selected",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  },
);

interface SegmentControlProps<Value> extends Omit<
  RadioGroupPrimitive.Props<Value>,
  "className"
> {
  className?: string;
  size?: SegmentControlSize;
  variant?: SegmentControlVariant;
}

function SegmentControl<Value>({
  className,
  size = "default",
  variant = "default",
  ...props
}: SegmentControlProps<Value>) {
  return (
    <SegmentControlContext value={{ size, variant }}>
      <RadioGroupPrimitive
        data-slot="segment-control"
        className={cn(segmentControlVariants({ size, variant }), className)}
        {...props}
      />
    </SegmentControlContext>
  );
}
SegmentControl.displayName = "SegmentControl";

interface SegmentControlItemProps<Value> extends Omit<
  RadioPrimitive.Root.Props<Value>,
  "className"
> {
  className?: string;
}

function SegmentControlItem<Value>({
  className,
  ...props
}: SegmentControlItemProps<Value>) {
  const { size, variant } = React.useContext(SegmentControlContext);

  return (
    <RadioPrimitive.Root
      data-slot="segment-control-item"
      className={cn(segmentControlItemVariants({ size, variant }), className)}
      {...props}
    />
  );
}
SegmentControlItem.displayName = "SegmentControlItem";

export {
  SegmentControl,
  SegmentControlItem,
  type SegmentControlProps,
  type SegmentControlItemProps,
};
