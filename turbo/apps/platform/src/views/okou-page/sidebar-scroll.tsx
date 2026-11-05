import type { CSSProperties, ReactNode, UIEvent } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { cn, RequestCommit, ScrollBar } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { chatListLayoutRequest$ } from "../../signals/chat-page/chat-list-layout.ts";
import type { SidebarChatThreadScrollSignals } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

interface OverlayScrollAreaProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly viewportClassName?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
  readonly scrollSignals: SidebarChatThreadScrollSignals;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
  readonly tabIndex?: number;
}

/**
 * A layout request is written together with the state that changes the space
 * around the chat list, so its commit already carries that change. A leaf after
 * the viewport keeps the request from re-rendering the list.
 */
function ChatListLayoutCommit({
  scrollSignals,
}: {
  readonly scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const request = useGet(chatListLayoutRequest$);
  const commitLayoutRequest = useSet(scrollSignals.commitLayoutRequest$);
  return (
    <RequestCommit
      request={request}
      commitKey="chat-list-viewport"
      onCommit={commitLayoutRequest}
    >
      {null}
    </RequestCommit>
  );
}

/** Sidebar scroll state with shadcn's Base UI scrollbar styling. */
export function OverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  viewportClassName,
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
        data-slot="scroll-area-viewport"
        className={cn(
          "h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          viewportClassName,
        )}
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
      <ChatListLayoutCommit scrollSignals={scrollSignals} />
      <ScrollBar data-testid="sidebar-scrollbar" />
    </ScrollArea.Root>
  );
}
