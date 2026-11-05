import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";

type RailViewportProps = ComponentPropsWithoutRef<"div"> & {
  readonly contentRevision: string;
  readonly onContentCommit: (
    element: HTMLDivElement,
    contentRevision: string,
  ) => void;
  readonly onViewportMount: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
};

/**
 * A native scrollport with an explicit content-request/DOM-commit boundary.
 * Geometry and native-event ownership stay with the caller; this primitive
 * only supplies the committed element and the exact requested revision.
 */
export function RailViewport({
  contentRevision,
  onContentCommit,
  onViewportMount,
  ...props
}: RailViewportProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      const cleanup = onViewportMount(element);
      return () => {
        if (viewport.current === element) {
          viewport.current = null;
        }
        cleanup?.();
      };
    },
    [onViewportMount],
  );
  useLayoutEffect(() => {
    if (viewport.current) {
      onContentCommit(viewport.current, contentRevision);
    }
  }, [contentRevision, onContentCommit]);
  return (
    <div {...props} ref={attach} data-rail-content-revision={contentRevision} />
  );
}
