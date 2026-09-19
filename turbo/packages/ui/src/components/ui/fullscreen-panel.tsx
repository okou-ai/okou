import {
  useCallback,
  useLayoutEffect,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

type FullscreenPanelProps = ComponentPropsWithoutRef<"div"> & {
  readonly as?: "div" | "aside";
  readonly fullscreen: boolean;
};

export function FullscreenPanel({
  as: Surface = "div",
  children,
  className,
  fullscreen,
  ...props
}: FullscreenPanelProps) {
  const [mount, setMount] = useState<{
    inline: HTMLDivElement;
    portal: HTMLDivElement;
  } | null>(null);
  const inlineRef = useCallback((inline: HTMLDivElement | null) => {
    if (!inline) {
      return;
    }
    const portal = inline.ownerDocument.createElement("div");
    portal.className = "contents";
    inline.appendChild(portal);
    setMount({ inline, portal });
    return () => {
      portal.remove();
    };
  }, []);

  useLayoutEffect(() => {
    if (!mount) {
      return;
    }
    // Escape workspace stacking contexts, while remaining below body-level
    // dialogs and menus inside the isolated app root.
    const target = fullscreen
      ? mount.inline.ownerDocument.getElementById("root")
      : mount.inline;
    if (!target) {
      throw new Error("FullscreenPanel requires an app root");
    }
    if (mount.portal.parentElement === target) {
      return;
    }
    // Keep the portal target stable so React state and scroll positions survive.
    // Native state-preserving moves also retain iframe and media state.
    if (typeof target.moveBefore === "function") {
      target.moveBefore(mount.portal, null);
    } else {
      const scrollPositions = Array.from(
        mount.portal.querySelectorAll("*"),
        (element) => {
          return {
            element,
            top: element.scrollTop,
            left: element.scrollLeft,
          };
        },
      ).filter(({ top, left }) => {
        return top !== 0 || left !== 0;
      });
      target.appendChild(mount.portal);
      for (const { element, top, left } of scrollPositions) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
  }, [fullscreen, mount]);

  return (
    <div ref={inlineRef} className="contents">
      {mount &&
        createPortal(
          <Surface
            {...props}
            className={cn(
              fullscreen
                ? "fixed inset-0 z-40 flex min-h-0 flex-col bg-background p-safe"
                : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
              className,
            )}
          >
            {children}
          </Surface>,
          mount.portal,
        )}
    </div>
  );
}
