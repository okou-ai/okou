import type { ChatLayoutSignals } from "../../signals/chat-page/chat-layout.ts";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  TransitionEvent as ReactTransitionEvent,
} from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
  CHAT_THREAD_SIDEBAR_MIN_WIDTH,
  chatThreadSidebarResizing$,
  chatThreadSidebarWidth$,
  startChatThreadSidebarResize$,
} from "../../signals/chat-page/chat-thread-sidebar-layout.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { syncActiveBrowserFitAction$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";

function chatThreadSidebarLayout(
  width: number | null,
  resizing: boolean,
  animateEntry: boolean,
): { style: CSSProperties; transition: string } {
  const widthValue =
    width === null
      ? "min(760px, 48vw)"
      : `clamp(${CHAT_THREAD_SIDEBAR_MIN_WIDTH}px, ${width}px, calc(100% - ${CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH}px))`;
  return {
    style: { "--chat-thread-sidebar-width": widthValue } as CSSProperties,
    transition:
      resizing || !animateEntry
        ? ""
        : "transition-[flex-basis,width] duration-[240ms]",
  };
}

function ChatThreadSidebarResizeHandle() {
  const { t } = useTranslation();
  const startResize = useSet(startChatThreadSidebarResize$);
  const pageSignal = useGet(pageSignal$);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = event.currentTarget.parentElement;
    if (!container) {
      return;
    }
    event.preventDefault();
    startResize(container, pageSignal);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(($) => {
        return $.chat.threadSidebar.resize;
      })}
      className="group relative hidden w-1 shrink-0 cursor-col-resize items-stretch justify-center xl:flex"
      onPointerDown={handlePointerDown}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-divider/60 transition-colors group-hover:bg-divider"
      />
    </div>
  );
}

export function ChatThreadSidebarShell({
  children,
  layout,
  animateEntry,
  open,
  sidebar,
  workspace,
}: {
  readonly children: ReactNode;
  readonly layout: ChatLayoutSignals;
  readonly animateEntry: boolean;
  readonly open: boolean;
  readonly sidebar: ReactNode;
  readonly workspace?: {
    readonly beside: "chat-list" | "nav-rail";
    readonly header: ReactNode;
    readonly footer: ReactNode;
    readonly pwaNavigation: boolean;
    readonly fullscreen: boolean;
  };
}) {
  const transitionRef = useSet(layout.transitionOnRef$);
  const syncActiveBrowserFitAction = useSet(syncActiveBrowserFitAction$);
  const { style, transition } = chatThreadSidebarLayout(
    useGet(chatThreadSidebarWidth$),
    useGet(chatThreadSidebarResizing$),
    animateEntry,
  );

  function handleSidebarTransitionEnd(
    event: ReactTransitionEvent<HTMLDivElement>,
  ): void {
    if (
      event.target !== event.currentTarget ||
      (event.propertyName !== "width" && event.propertyName !== "flex-basis")
    ) {
      return;
    }
    syncActiveBrowserFitAction();
  }

  const panes = (
    <>
      <div
        className={cn(
          "min-w-0 min-h-0",
          transition,
          open ? "hidden xl:flex flex-1 basis-0" : "flex flex-1",
        )}
      >
        {children}
      </div>
      {open && <ChatThreadSidebarResizeHandle />}
      <div
        data-testid="chat-thread-sidebar-pane"
        onTransitionEnd={handleSidebarTransitionEnd}
        className={cn(
          "flex min-h-0 min-w-0 overflow-hidden",
          workspace && "md:rounded-xl xl:rounded-l-none",
          workspace?.pwaNavigation &&
            !workspace.fullscreen &&
            "[--okou-safe-b:0px]",
          transition,
          open && animateEntry && "duration-[180ms]",
          open
            ? "flex-1 basis-0 xl:w-[var(--chat-thread-sidebar-width)] xl:flex-none xl:basis-[var(--chat-thread-sidebar-width)]"
            : "pointer-events-none w-0 flex-none basis-0",
        )}
        aria-hidden={!open}
      >
        {sidebar}
      </div>
    </>
  );

  return withChatScrollLayout(
    <div
      ref={transitionRef}
      // The shell frame must not establish a stacking context or containing
      // block: its sidebar's fixed surface needs to compete inside #root.
      className={`${cn(
        "flex flex-1 min-h-0",
        workspace &&
          "min-w-0 flex-col md:m-2 md:rounded-xl md:border md:border-border [anchor-name:--workspace-canvas]",
        workspace?.beside === "chat-list" && "md:ml-0",
      )} ${
        workspace
          ? "bg-workspace-canvas bg-workspace-canvas-image bg-[length:100%_100%]"
          : "bg-transparent"
      }`}
      style={style}
    >
      {workspace ? (
        <>
          {workspace.header}
          <div className="flex min-h-0 min-w-0 flex-1">{panes}</div>
          {workspace.footer}
        </>
      ) : (
        panes
      )}
    </div>,
  );
}
