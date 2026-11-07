import type { ChatLayoutSignals } from "../../signals/chat-page/chat-layout.ts";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import type { CSSProperties, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { cn, LayoutPanel, RequestCommit } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import {
  CHAT_THREAD_SIDEBAR_DEFAULT_SHARE,
  CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
  CHAT_THREAD_SIDEBAR_MIN_WIDTH,
  chatThreadSidebarResizing$,
  chatThreadSidebarResizeHandleRef$,
  chatThreadSidebarWidths$,
} from "../../signals/chat-page/chat-thread-sidebar-layout.ts";
import {
  chatListWidth$,
  chatListResizing$,
} from "../../signals/okou-page/unified-chat-workspace.ts";
import { ResizeSeam } from "./resize-seam.tsx";
import { sidebarOff$ } from "../../signals/okou-page/nav.ts";
import { workspaceResizing$ } from "../../signals/chat-page/workspace-resize.ts";
import {
  workspaceLayoutThreads$,
  type WorkspaceLayoutThreads,
} from "../../signals/chat-page/workspace-layout-commit.ts";

function sidebarWidthValue(width: number | null): string {
  const preferred =
    width === null
      ? `${Math.round(CHAT_THREAD_SIDEBAR_DEFAULT_SHARE * 100)}%`
      : `${width}px`;
  return `clamp(${CHAT_THREAD_SIDEBAR_MIN_WIDTH}px, ${preferred}, calc(100% - ${CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH}px))`;
}

function chatThreadSidebarLayout(
  width: number | null,
  resizing: boolean,
  animateEntry: boolean,
  open: boolean,
): { style: CSSProperties; transition: string } {
  const widthValue = sidebarWidthValue(width);
  return {
    style: { "--chat-thread-sidebar-width": widthValue } as CSSProperties,
    transition:
      resizing || !animateEntry
        ? "transition-none"
        : cn(
            "transition-[flex-basis,width] motion-reduce:transition-none",
            open ? "duration-[180ms]" : "duration-[240ms]",
          ),
  };
}

function ChatThreadSidebarResizeHandle({
  widthKey,
  width,
  resizing,
}: {
  readonly widthKey: string;
  readonly width: number | null;
  readonly resizing: boolean;
}) {
  const { t } = useTranslation();
  const resizeHandleRef = useSet(chatThreadSidebarResizeHandleRef$);

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

function workspaceFrameClassName(
  beside: "chat-list" | "nav-rail" | undefined,
): string {
  const frame = cn(
    "flex flex-1 min-h-0",
    beside &&
      "min-w-0 flex-col md:m-2 md:rounded-2xl md:border md:border-border [anchor-name:--workspace-canvas]",
    // The chat list supplies this sheet's left edge and corners.
    beside === "chat-list" && "md:ml-0 md:rounded-l-none",
    // Positions the divider without a stacking context; fixed surfaces inside
    // still compete in #root.
    !beside && "relative",
  );
  const fill = beside
    ? "bg-workspace-canvas bg-workspace-canvas-image bg-[length:100%_100%]"
    : "bg-transparent";
  return `${frame} ${fill}`;
}

function sidebarPanelClassName({
  open,
  transition,
  workspace,
}: {
  readonly open: boolean;
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
    open
      ? "flex-1 basis-0 xl:w-[var(--chat-thread-sidebar-width)] xl:flex-none xl:basis-[var(--chat-thread-sidebar-width)]"
      : "pointer-events-none w-0 flex-none basis-0",
    open && "xl:border-l xl:border-border",
  );
}

interface ChatThreadSidebarShellProps {
  readonly children: ReactNode;
  readonly layout: ChatLayoutSignals;
  readonly animateEntry: boolean;
  readonly onSidebarLayoutCommit?: () => void;
  readonly onWorkspaceLayoutCommit?: (threads: WorkspaceLayoutThreads) => void;
  readonly ownerKey?: string;
  readonly open: boolean;
  readonly sidebar: ReactNode;
  /** Which remembered width this panel takes. */
  readonly widthKey?: string;
  readonly workspace?: {
    readonly beside: "chat-list" | "nav-rail";
    readonly header: ReactNode;
    readonly footer: ReactNode;
    readonly pwaNavigation: boolean;
    readonly fullscreen: boolean;
  };
}

export function ChatThreadSidebarShell({
  children,
  layout,
  animateEntry,
  onSidebarLayoutCommit,
  onWorkspaceLayoutCommit,
  ownerKey = "",
  open,
  sidebar,
  widthKey = "default",
  workspace,
}: ChatThreadSidebarShellProps) {
  const transitionRef = useSet(layout.transitionOnRef$);
  // The remembered panel width; each panel kind keeps its own.
  const width = useGet(chatThreadSidebarWidths$)[widthKey] ?? null;
  const resizing = useGet(chatThreadSidebarResizing$);
  const workspaceResizing = useGet(workspaceResizing$);
  const workspaceThreads = useGet(workspaceLayoutThreads$);
  // The chat list shares the workspace row, so its geometry sizes this panel.
  const chatListWidth = useGet(chatListWidth$);
  const chatListHidden = useGet(sidebarOff$);
  const chatListResizing = useGet(chatListResizing$);
  const { style, transition } = chatThreadSidebarLayout(
    width,
    workspaceResizing,
    animateEntry,
    open,
  );

  const sidebarLayoutKey = JSON.stringify([
    open,
    ownerKey,
    widthKey,
    width,
    resizing,
    animateEntry,
    chatListWidth,
    chatListHidden,
    chatListResizing,
    workspace?.beside,
    workspace?.pwaNavigation,
    workspace?.fullscreen,
  ]);

  const handle = open ? (
    <ChatThreadSidebarResizeHandle
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
          open ? "hidden xl:flex flex-1 basis-0" : "flex flex-1",
        )}
      >
        {children}
      </div>
      <LayoutPanel
        active={open}
        layoutKey={sidebarLayoutKey}
        onLayoutCommit={onSidebarLayoutCommit}
        data-testid="chat-thread-sidebar-pane"
        data-sidebar-layout-owner="panel"
        data-sidebar-layout-key={sidebarLayoutKey}
        data-sidebar-layout-resizing={workspaceResizing ? "true" : undefined}
        className={sidebarPanelClassName({
          open,
          transition,
          workspace,
        })}
        aria-hidden={!open}
      >
        {sidebar}
      </LayoutPanel>
      {handle}
    </>
  );

  const frame = (
    <div
      ref={transitionRef}
      // The shell frame must not establish a stacking context or containing
      // block: its sidebar's fixed surface needs to compete inside #root.
      className={workspaceFrameClassName(workspace?.beside)}
      style={style}
    >
      {workspace ? (
        <>
          {workspace.header}
          <div className="relative flex min-h-0 min-w-0 flex-1">{panes}</div>
          {workspace.footer}
        </>
      ) : (
        panes
      )}
    </div>
  );
  return onWorkspaceLayoutCommit ? (
    <RequestCommit
      request={workspaceThreads}
      commitKey={sidebarLayoutKey}
      onCommit={onWorkspaceLayoutCommit}
    >
      {frame}
    </RequestCommit>
  ) : (
    withChatScrollLayout(frame)
  );
}
