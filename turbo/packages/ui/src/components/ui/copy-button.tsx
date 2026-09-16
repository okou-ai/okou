"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export interface CopyButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  text: string;
  resetDelay?: number;
  showTooltip?: boolean;
}

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    { text, resetDelay = 2000, showTooltip = true, className, ...props },
    ref,
  ) => {
    const [copied, setCopied] = React.useState(false);

    React.useEffect(() => {
      if (!copied) return;

      const timer = setTimeout(() => {
        setCopied(false);
      }, resetDelay);

      return () => {
        return clearTimeout(timer);
      };
    }, [copied, resetDelay]);

    const handleCopy = () => {
      navigator.clipboard.writeText(text).then(
        () => {
          return setCopied(true);
        },
        () => {
          // Clipboard API not available or failed
        },
      );
    };

    const button = (
      <button
        ref={ref}
        onClick={handleCopy}
        className={cn(
          "p-2 hover:bg-state-hover rounded-md transition-colors shrink-0 group",
          className,
        )}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        {...props}
      >
        {/*
          Confirmation is carried by the glyph swap and the accessible name,
          not by a color. The control is monochrome at every call site — the
          Markdown code fence tints it through `text-muted-foreground` and
          `text-foreground` — so a raw ramp stop such as `green-500` painted a
          saturated mark no theme or preset owns. `text-foreground` is the same
          color the resting icon reaches on hover, one step above the resting
          muted fill, which reads as confirmation without introducing an accent.
        */}
        {copied ? (
          <Check className="h-4 w-4 text-foreground transition-colors" />
        ) : (
          <Copy className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        )}
      </button>
    );

    if (!showTooltip) {
      return button;
    }

    return (
      <TooltipProvider>
        <Tooltip open={copied}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>Copied!</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
