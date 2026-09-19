import {
  Component,
  useCallback,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

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
  readonly inline: HTMLDivElement;
  readonly portal: HTMLDivElement;
};

type ScrollAnchorSnapshot = {
  readonly viewport: HTMLElement;
  readonly anchor: HTMLElement;
  readonly offset: number;
  readonly anchoringAlreadyDisabled: boolean;
};

function captureScrollAnchor(
  mount: FullscreenPanelMount,
  options: NonNullable<FullscreenPanelProps["scrollAnchor"]>,
): ScrollAnchorSnapshot | null {
  const viewport = mount.portal.querySelector<HTMLElement>(
    options.viewportSelector,
  );
  if (!viewport) {
    return null;
  }
  const viewportBounds = viewport.getBoundingClientRect();
  for (const anchor of viewport.querySelectorAll<HTMLElement>(
    options.anchorSelector,
  )) {
    // Prefer the visible paragraph inside a list item or table row over a
    // potentially much taller ancestor whose start has already scrolled away.
    if (anchor.querySelector(options.anchorSelector)) {
      continue;
    }
    const bounds = anchor.getBoundingClientRect();
    if (
      bounds.height <= 0 ||
      bounds.width <= 0 ||
      bounds.bottom <= viewportBounds.top ||
      bounds.top >= viewportBounds.bottom
    ) {
      continue;
    }
    const anchoringAlreadyDisabled = viewport.classList.contains(
      "[overflow-anchor:none]",
    );
    // This must happen before React changes the fullscreen geometry. Otherwise
    // browser anchoring may already have adjusted scrollTop for the new width.
    viewport.classList.add("[overflow-anchor:none]");
    return {
      viewport,
      anchor,
      offset: bounds.top - viewportBounds.top,
      anchoringAlreadyDisabled,
    };
  }
  return null;
}

function restoreScrollAnchor(snapshot: ScrollAnchorSnapshot) {
  const { viewport, anchor, offset } = snapshot;
  if (!viewport.contains(anchor)) {
    return;
  }
  const bounds = anchor.getBoundingClientRect();
  // If a clipped paragraph becomes shorter than its old clipped portion,
  // keep that paragraph in view instead of scrolling past it entirely.
  const targetOffset = bounds.height + offset > 0 ? offset : 0;
  viewport.scrollTop +=
    bounds.top - viewport.getBoundingClientRect().top - targetOffset;
}

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
    return captureScrollAnchor(mount, scrollAnchor);
  }

  public componentDidMount() {
    movePortal(this.props.mount, this.props.fullscreen);
  }

  public componentDidUpdate(
    _previous: FullscreenPanelPortalProps,
    _state: Record<string, never>,
    snapshot: ScrollAnchorSnapshot | null,
  ) {
    try {
      movePortal(this.props.mount, this.props.fullscreen);
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
