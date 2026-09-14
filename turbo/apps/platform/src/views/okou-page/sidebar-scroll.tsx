import type { CSSProperties, ReactNode, UIEvent } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useSet } from "ccstate-react";
import type { SidebarChatThreadScrollSignals } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

interface OverlayScrollAreaProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
  readonly scrollSignals: SidebarChatThreadScrollSignals;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
  readonly tabIndex?: number;
}

/** Overlay scroll area with a draggable Base UI scrollbar. */
export function OverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  contentClassName,
  children,
  scrollSignals,
  style,
  "data-testid": dataTestId,
  tabIndex,
}: OverlayScrollAreaProps) {
  const setScrollMetrics = useSet(scrollSignals.setScrollMetrics$);
  const setViewportRef = useSet(scrollSignals.setScrollViewport$);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollMetrics({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    });
  };

  return (
    <ScrollArea.Root className={className}>
      <ScrollArea.Viewport
        ref={setViewportRef}
        className="h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={style}
        onScroll={handleScroll}
        tabIndex={tabIndex ?? -1}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        <ScrollArea.Content className={contentClassName}>
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        className="pointer-events-none m-px flex w-3 justify-center opacity-0 data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100"
        data-testid="sidebar-scrollbar"
      >
        <ScrollArea.Thumb
          className="w-[5px] rounded-full bg-foreground/15"
          data-testid="sidebar-scrollbar-thumb"
        />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
