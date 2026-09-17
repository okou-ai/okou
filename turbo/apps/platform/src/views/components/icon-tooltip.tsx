import type { ComponentPropsWithRef, ReactElement } from "react";
import {
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";

export function IconTooltip({
  children,
  wrapperClassName,
}: {
  readonly children: ReactElement<{
    "aria-label": string;
    disabled?: boolean;
  }>;
  /**
   * Styles the span this component wraps a disabled child in so the tooltip
   * still receives pointer events. That wrapper is the one element a caller
   * cannot reach, and it becomes the diagram box's layout parent while a
   * Mermaid diagram is still rendering. An enabled child is its own trigger,
   * so it takes its classes from the caller directly.
   */
  readonly wrapperClassName?: string;
}) {
  // `cn` rather than a plain join: the wrapper's own `inline-flex` and a
  // caller's display utility land in the same Tailwind layer, where class-
  // attribute order decides nothing. Merging lets a caller replace the display.
  const trigger = children.props.disabled ? (
    <span className={cn("inline-flex", wrapperClassName)}>{children}</span>
  ) : (
    children
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent side="top">
          <p className="text-xs">{children.props["aria-label"]}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type IconTooltipButtonProps = ComponentPropsWithRef<"button"> & {
  readonly "aria-label": string;
  readonly wrapperClassName?: string;
};

export function IconTooltipButton({
  children,
  ref,
  wrapperClassName,
  ...props
}: IconTooltipButtonProps) {
  return (
    <IconTooltip wrapperClassName={wrapperClassName}>
      <button ref={ref} {...props}>
        {children}
      </button>
    </IconTooltip>
  );
}
