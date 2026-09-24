"use client";

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { Check, Share2 } from "lucide-react";
import { cn } from "../../lib/utils";

export type ShareLinkButtonProps = Omit<
  useRender.ComponentProps<"button", { copied: boolean }>,
  "children"
> & {
  /**
   * Starts sharing. It must copy the link synchronously inside the click; the
   * button confirms immediately. Call `revert` if sharing later fails. The
   * caller owns any async work, so this component never holds a promise.
   */
  onShare: (revert: () => void) => void;
  resetDelay?: number;
  label?: string;
  copiedLabel?: string;
};

const ShareLinkButton = React.forwardRef<
  HTMLButtonElement,
  ShareLinkButtonProps
>(
  (
    {
      onShare,
      resetDelay = 2000,
      label = "Share",
      copiedLabel = "Share link copied",
      render,
      className,
      ...props
    },
    ref,
  ) => {
    const [copiedRequest, setCopiedRequest] = React.useState<number | null>(
      null,
    );
    const shareRequest = React.useRef(0);
    const copied = copiedRequest !== null;

    React.useEffect(() => {
      return () => {
        shareRequest.current += 1;
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

    const handleShare = () => {
      const request = ++shareRequest.current;
      // Confirm in the same event: the link is already on the clipboard.
      setCopiedRequest(request);
      const revert = () => {
        if (shareRequest.current === request) {
          setCopiedRequest(null);
        }
      };
      onShare(revert);
    };

    return useRender({
      defaultTagName: "button",
      render,
      ref,
      state: { copied },
      props: {
        type: "button",
        onClick: handleShare,
        className: cn(
          "inline-flex items-center gap-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
          className,
        ),
        "aria-label": copied ? copiedLabel : label,
        ...props,
        children: copied ? (
          <>
            <Check className="h-4 w-4" />
            <span className="text-xs">{copiedLabel}</span>
          </>
        ) : (
          <Share2 className="h-4 w-4" />
        ),
      },
    });
  },
);
ShareLinkButton.displayName = "ShareLinkButton";

export { ShareLinkButton };
