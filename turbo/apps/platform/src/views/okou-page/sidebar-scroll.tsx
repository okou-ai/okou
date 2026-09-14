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

/** Sidebar scroll state with shadcn's Base UI scrollbar styling. */
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
        className="flex h-full w-2.5 touch-none select-none border-l border-l-transparent p-px transition-colors"
        data-testid="sidebar-scrollbar"
      >
        <ScrollArea.Thumb
          className="relative flex-1 rounded-full bg-border"
          data-testid="sidebar-scrollbar-thumb"
        />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
