import type { ChatLayoutSignals } from "../../signals/chat-page/chat-layout.ts";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import type { CSSProperties, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn, LayoutPanel } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
  CHAT_THREAD_SIDEBAR_MIN_WIDTH,
  UNIFIED_CHAT_THREAD_SIDEBAR_DEFAULT_SHARE,
  UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
  chatThreadSidebarResizing$,
  chatThreadSidebarWidth$,
  chatThreadSidebarResizeHandleRef$,
  unifiedChatThreadSidebarWidths$,
} from "../../signals/chat-page/chat-thread-sidebar-layout.ts";
import {
  chatListWidth$,
  storedChatListHidden$,
  unifiedChatWorkspace$,
} from "../../signals/okou-page/unified-chat-workspace.ts";
import { ResizeSeam } from "./resize-seam.tsx";

function sidebarWidthValue(width: number | null, unified: boolean): string {
  if (!unified) {
    return width === null
      ? "min(760px, 48vw)"
      : `clamp(${CHAT_THREAD_SIDEBAR_MIN_WIDTH}px, ${width}px, calc(100% - ${CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH}px))`;
  }
  const preferred =
    width === null
      ? `${Math.round(UNIFIED_CHAT_THREAD_SIDEBAR_DEFAULT_SHARE * 100)}%`
      : `${width}px`;
  return `clamp(${CHAT_THREAD_SIDEBAR_MIN_WIDTH}px, ${preferred}, calc(100% - ${UNIFIED_CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH}px))`;
}

function chatThreadSidebarLayout(
  width: number | null,
  unified: boolean,
  resizing: boolean,
  animateEntry: boolean,
): { style: CSSProperties; transition: string } {
  const widthValue = sidebarWidthValue(width, unified);
  return {
    style: { "--chat-thread-sidebar-width": widthValue } as CSSProperties,
    transition:
      resizing || !animateEntry
        ? ""
        : "transition-[flex-basis,width] duration-[240ms] motion-reduce:transition-none [html:active-view-transition-type(thread-mail)_&]:transition-none",
  };
}

function ChatThreadSidebarResizeHandle({
  unified,
  widthKey,
  width,
  resizing,
}: {
  readonly unified: boolean;
  readonly widthKey: string;
  readonly width: number | null;
  readonly resizing: boolean;
}) {
  const { t } = useTranslation();
  const resizeHandleRef = useSet(chatThreadSidebarResizeHandleRef$);

  if (unified) {
    // Rendered after the panel and centred on its leading edge, so ordinary
    // paint order puts the target above both panes without a z-index. The
    // panel's own border draws the resting line.
    return (
      <ResizeSeam
        ref={resizeHandleRef}
        label={t(($) => {
          return $.chat.threadSidebar.resize;
        })}
        valueMin={CHAT_THREAD_SIDEBAR_MIN_WIDTH}
        valueNow={width}
        resizing={resizing}
        line="center"
        className="absolute inset-y-0 right-[var(--chat-thread-sidebar-width)] hidden translate-x-1/2 xl:block"
        widthKey={widthKey}
      />
    );
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(($) => {
        return $.chat.threadSidebar.resize;
      })}
      className="group relative hidden w-1 shrink-0 cursor-col-resize touch-none items-stretch justify-center xl:flex"
      ref={resizeHandleRef}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-divider/60 transition-colors group-hover:bg-divider"
      />
    </div>
  );
}

/** The remembered panel width; the unified workspace keeps one per kind. */
function useChatThreadSidebarWidth(widthKey: string): {
  readonly unified: boolean;
  readonly width: number | null;
} {
  const unified = useGet(unifiedChatWorkspace$);
  const legacyWidth = useGet(chatThreadSidebarWidth$);
  const unifiedWidths = useGet(unifiedChatThreadSidebarWidths$);
  return {
    unified,
    width: unified ? (unifiedWidths[widthKey] ?? null) : legacyWidth,
  };
}

function workspaceFrameClassName(
  beside: "chat-list" | "nav-rail" | undefined,
  unified: boolean,
): string {
  const frame = cn(
    "flex flex-1 min-h-0",
    beside &&
      "min-w-0 flex-col md:m-2 md:rounded-2xl md:border md:border-border [anchor-name:--workspace-canvas]",
    beside === "chat-list" && "md:ml-0",
    // The unified chat list supplies this sheet's left edge and corners.
    beside === "chat-list" && unified && "md:rounded-l-none",
    // Positions the unified divider without a stacking context; fixed
    // surfaces inside still compete in #root.
    !beside && unified && "relative",
  );
  const fill = beside
    ? "bg-workspace-canvas bg-workspace-canvas-image bg-[length:100%_100%]"
    : "bg-transparent";
  return `${frame} ${fill}`;
}

function sidebarPanelClassName({
  open,
  unified,
  animateEntry,
  transition,
  workspace,
}: {
  readonly open: boolean;
  readonly unified: boolean;
  readonly animateEntry: boolean;
  readonly transition: string;
  readonly workspace:
    | { readonly pwaNavigation: boolean; readonly fullscreen: boolean }
    | undefined;
}): string {
  return cn(
    "flex min-h-0 min-w-0 overflow-hidden",
    workspace && "md:rounded-2xl xl:rounded-l-none",
    workspace?.pwaNavigation && !workspace.fullscreen && "[--okou-safe-b:0px]",
    transition,
    open && animateEntry && "duration-[180ms]",
    open
      ? "flex-1 basis-0 xl:w-[var(--chat-thread-sidebar-width)] xl:flex-none xl:basis-[var(--chat-thread-sidebar-width)]"
      : "pointer-events-none w-0 flex-none basis-0",
    open && unified && "xl:border-l xl:border-border",
  );
}

export function ChatThreadSidebarShell({
  children,
  layout,
  animateEntry,
  onSidebarLayoutCommit,
  open,
  sidebar,
  widthKey = "default",
  workspace,
}: {
  readonly children: ReactNode;
  readonly layout: ChatLayoutSignals;
  readonly animateEntry: boolean;
  readonly onSidebarLayoutCommit?: () => void;
  readonly open: boolean;
  readonly sidebar: ReactNode;
  /** Which remembered width the unified workspace gives this panel. */
  readonly widthKey?: string;
  readonly workspace?: {
    readonly beside: "chat-list" | "nav-rail";
    readonly header: ReactNode;
    readonly footer: ReactNode;
    readonly pwaNavigation: boolean;
    readonly fullscreen: boolean;
  };
}) {
  const transitionRef = useSet(layout.transitionOnRef$);
  const { unified, width } = useChatThreadSidebarWidth(widthKey);
  const resizing = useGet(chatThreadSidebarResizing$);
  // The chat list shares the workspace row, so its geometry sizes this panel.
  const chatListWidth = useGet(chatListWidth$);
  const chatListHidden = useGet(storedChatListHidden$);
  const { style, transition } = chatThreadSidebarLayout(
    width,
    unified,
    resizing,
    animateEntry,
  );

  const sidebarLayoutKey = [
    width,
    unified,
    resizing,
    animateEntry,
    chatListWidth,
    chatListHidden,
    workspace?.beside,
    workspace?.pwaNavigation,
    workspace?.fullscreen,
  ].join(":");

  const handle = open ? (
    <ChatThreadSidebarResizeHandle
      unified={unified}
      widthKey={widthKey}
      width={width}
      resizing={resizing}
    />
  ) : null;

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
      {!unified && handle}
      <LayoutPanel
        active={open}
        layoutKey={sidebarLayoutKey}
        onLayoutCommit={onSidebarLayoutCommit}
        data-testid="chat-thread-sidebar-pane"
        className={sidebarPanelClassName({
          open,
          unified,
          animateEntry,
          transition,
          workspace,
        })}
        aria-hidden={!open}
      >
        {sidebar}
      </LayoutPanel>
      {unified && handle}
    </>
  );

  return withChatScrollLayout(
    <div
      ref={transitionRef}
      // The shell frame must not establish a stacking context or containing
      // block: its sidebar's fixed surface needs to compete inside #root.
      className={workspaceFrameClassName(workspace?.beside, unified)}
      style={style}
    >
      {workspace ? (
        <>
          {workspace.header}
          <div
            className={cn("flex min-h-0 min-w-0 flex-1", unified && "relative")}
          >
            {panes}
          </div>
          {workspace.footer}
        </>
      ) : (
        panes
      )}
    </div>,
    { measureWidth: true },
  );
}
