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
  /** Opt in a reflowing document to reading-position preservation. */
  readonly scrollAnchor?: {
    readonly viewportSelector: string;
    readonly anchorSelector: string;
  };
};

type FullscreenPanelMount = {
  readonly portal: HTMLDivElement;
};

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

  public componentDidUpdate(
    _previous: FullscreenPanelPortalProps,
    _state: Record<string, never>,
    snapshot: ScrollAnchorSnapshot | null,
  ) {
    try {
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
    setMount({ portal });
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
