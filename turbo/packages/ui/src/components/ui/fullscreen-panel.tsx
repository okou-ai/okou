import {
  Component,
  useCallback,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  type ScrollAnchorSnapshot,
} from "../../lib/scroll-anchor";

type FullscreenPanelProps = ComponentPropsWithoutRef<"div"> & {
  readonly as?: "div" | "aside";
  readonly fullscreen: boolean;
  /** Disable relocation only inside a stable, shell-owned fullscreen host. */
  readonly relocate?: boolean;
  /** Opt in a reflowing document to reading-position preservation. */
  readonly scrollAnchor?: {
    readonly viewportSelector: string;
    readonly anchorSelector: string;
  };
};

type FullscreenPanelMount = {
  readonly inline: HTMLDivElement;
  readonly portal: HTMLDivElement;
};

function movePortal(mount: FullscreenPanelMount, fullscreen: boolean) {
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
}

type FullscreenPanelPortalProps = FullscreenPanelProps & {
  readonly mount: FullscreenPanelMount;
};

// getSnapshotBeforeUpdate is the React boundary that can read the old layout
// before any DOM mutations. A layout effect would see the new fullscreen width.
class FullscreenPanelPortal extends Component<
  FullscreenPanelPortalProps,
  Record<string, never>,
  ScrollAnchorSnapshot | null
> {
  public getSnapshotBeforeUpdate(previous: FullscreenPanelPortalProps) {
    const { fullscreen, mount, scrollAnchor } = this.props;
    if (previous.fullscreen === fullscreen || !scrollAnchor) {
      return null;
    }
    return captureScrollAnchor(mount.portal, scrollAnchor);
  }

  public componentDidMount() {
    if (this.props.relocate !== false) {
      movePortal(this.props.mount, this.props.fullscreen);
    }
  }

  public componentDidUpdate(
    _previous: FullscreenPanelPortalProps,
    _state: Record<string, never>,
    snapshot: ScrollAnchorSnapshot | null,
  ) {
    try {
      if (this.props.relocate !== false) {
        movePortal(this.props.mount, this.props.fullscreen);
      }
      if (snapshot) {
        restoreScrollAnchor(snapshot);
      }
    } finally {
      if (snapshot && !snapshot.anchoringAlreadyDisabled) {
        snapshot.viewport.classList.remove("[overflow-anchor:none]");
      }
    }
  }

  public render() {
    const {
      as: Surface = "div",
      children,
      className,
      fullscreen,
      mount,
      relocate: _relocate,
      scrollAnchor: _scrollAnchor,
      ...props
    } = this.props;
    return createPortal(
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
    );
  }
}

export function FullscreenPanel(props: FullscreenPanelProps) {
  const [mount, setMount] = useState<FullscreenPanelMount | null>(null);
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

  return (
    <div ref={inlineRef} className="contents">
      {mount && <FullscreenPanelPortal {...props} mount={mount} />}
    </div>
  );
}
