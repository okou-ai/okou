"use client";

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export type CopyButtonProps = Omit<
  useRender.ComponentProps<"button", { copied: boolean }>,
  "children"
> & {
  resetDelay?: number;
  showTooltip?: boolean;
} & (
    | { text: string; copyAction?: never }
    | { text?: never; copyAction: () => Promise<boolean> }
  );

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      text,
      copyAction,
      resetDelay = 2000,
      showTooltip = true,
      render,
      className,
      ...props
    },
    ref,
  ) => {
    const [copiedRequest, setCopiedRequest] = React.useState<number | null>(
      null,
    );
    const copyRequest = React.useRef(0);
    const copied = copiedRequest !== null;

    React.useEffect(() => {
      return () => {
        copyRequest.current += 1;
      };
    }, []);

    React.useEffect(() => {
      if (copiedRequest === null) return;

      const timer = setTimeout(() => {
        setCopiedRequest(null);
      }, resetDelay);

      return () => {
        return clearTimeout(timer);
      };
    }, [copiedRequest, resetDelay]);

    const handleCopy = () => {
      const request = ++copyRequest.current;
      const finishCopy = (success: boolean) => {
        if (copyRequest.current === request) {
          setCopiedRequest(success ? request : null);
        }
      };
      const copy = async () => {
        if (copyAction) {
          return await copyAction();
        }
        await navigator.clipboard.writeText(text);
        return true;
      };
      copy().then(finishCopy, () => {
        finishCopy(false);
      });
    };

    const button = useRender({
      defaultTagName: "button",
      render,
      ref,
      state: { copied },
      props: {
        onClick: handleCopy,
        className: cn(
          "p-2 hover:bg-state-hover rounded-md transition-colors shrink-0 group",
          className,
        ),
        "aria-label": copied ? "Copied" : "Copy to clipboard",
        ...props,
        children: copied ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        ),
      },
    });

    if (render || !showTooltip) {
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
