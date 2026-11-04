import {
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

/** A semantic host commit without introducing another layout element. */
export function LayoutCommit({
  children,
  layoutKey,
  onLayoutCommit,
}: {
  readonly children: ReactNode;
  readonly layoutKey: string;
  readonly onLayoutCommit: () => void;
}) {
  useLayoutEffect(() => {
    onLayoutCommit();
  }, [layoutKey, onLayoutCommit]);
  return children;
}

/** Fulfill an existing request only at its corresponding destination commit. */
export function RequestCommit<T>({
  children,
  request,
  commitKey,
  onCommit,
}: {
  readonly children: ReactNode;
  readonly request: T | null;
  readonly commitKey: string;
  readonly onCommit: (request: T) => void;
}) {
  useLayoutEffect(() => {
    if (request !== null) {
      onCommit(request);
    }
  }, [request, commitKey, onCommit]);
  return children;
}

type LayoutPanelProps = ComponentPropsWithoutRef<"div"> & {
  readonly active: boolean;
  readonly layoutKey: string;
  readonly onLayoutCommit?: () => void;
};

/** A panel that keeps embedded imperative widgets aligned with its layout. */
export function LayoutPanel({
  active,
  layoutKey,
  onLayoutCommit,
  ...props
}: LayoutPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !active || !onLayoutCommit) {
      return;
    }
    const completeTransition = (event: TransitionEvent) => {
      if (
        event.target === panel &&
        (event.propertyName === "width" || event.propertyName === "flex-basis")
      ) {
        onLayoutCommit();
      }
    };
    panel.addEventListener("transitionend", completeTransition);
    panel.addEventListener("transitioncancel", completeTransition);
    // The owner supplies a semantic layout key after its layout action. This
    // also acknowledges commits with no transition, including reduced motion.
    onLayoutCommit();
    return () => {
      panel.removeEventListener("transitionend", completeTransition);
      panel.removeEventListener("transitioncancel", completeTransition);
    };
  }, [active, layoutKey, onLayoutCommit]);

  return <div {...props} ref={panelRef} />;
}
