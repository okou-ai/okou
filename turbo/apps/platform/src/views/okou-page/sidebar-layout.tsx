import {
  ChatShareCloseButton,
  ChatShareSelectionControls,
} from "./chat-share-selection-controls.tsx";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import { ProjectDialogs } from "../projects/project-dialogs.tsx";
import { PersonalSubscriptionDialogs } from "./subscription-linking.tsx";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import {
  activeThreadSidebar$,
  activeThreadSidebarFullscreen$,
  threadSidebarLayoutRootRef$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { ChatThreadSidebarShell } from "./chat-thread-sidebar-shell.tsx";
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Share2, UserPlus } from "lucide-react";
import type { RouteKey } from "../../signals/route-paths.ts";
import { Button, cn } from "@okouai/ui";
import {
  ChatListPane,
  Sidebar,
  ThreeColumnSearchDialogContainer,
} from "./sidebar.tsx";
import {
  AutomationMenuButton,
  ChatThreadHeaderTitle,
  ChatThreadSidebarPane,
  SettledChatThreadActions,
} from "./chat-thread-page.tsx";
import { currentChatAgent$ } from "../../signals/agent-chat.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import { QueueDrawer } from "../queue-page/queue-drawer.tsx";
import { sidebarOff$, isChatRoute } from "../../signals/okou-page/nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { mobileBreadcrumb$ } from "../../signals/okou-page/mobile-breadcrumb.ts";
import { Link } from "../router/link.tsx";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { SettingsDialogMount } from "./components/settings/settings-dialog.tsx";
import {
  InstallBanner,
  IosInstallModal,
} from "../pwa-install/install-banner.tsx";
import { ChatShortcutHelpDialog } from "./chat-shortcut-help-dialog.tsx";
import { ConcurrencyConfirmDialog } from "./components/org-manage/org-billing-tab.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { CheckoutAbandonedSurveyDialog } from "./components/billing-survey.tsx";
import { lightboxUrl$ } from "../../signals/okou-page/attachment-chips.ts";
import { AttachmentLightbox } from "./attachment-chips.tsx";
import { skillImportDialogOpen$ } from "../../signals/skill-import/skill-import-dialog.ts";
import { SkillImportDialog } from "../skill-import/skill-import-dialog.tsx";
import { CreateAgentDialogContainer } from "../agents-page/create-agent-dialog.tsx";
import { paletteColorTheme$ } from "../../signals/theme.ts";
import {
  SHEET_PANE_LEADING_CORNERS,
  WorkspaceInset,
} from "./workspace-inset.tsx";
import { MobileChatThreadMoreMenu } from "./chat-thread-header-actions.tsx";
import { ThreadMailButton } from "./thread-mail.tsx";
import { ChatHeaderIconButton } from "./chat-header-icon-button.tsx";
import { ChatResourcesButton } from "./chat-resources.tsx";
import {
  pwaChatListVisible$,
  mobileChatViewport$,
} from "../../signals/okou-page/pwa-navigation.ts";
import {
  PwaBackToChats,
  PwaBackToParent,
  PwaBottomNavigation,
} from "./pwa-navigation.tsx";
import { ChatThreadDialogs } from "./sidebar-threads.tsx";
import { NotFoundPage } from "../not-found-page.tsx";
import { ThreadRemoteAccessDialog } from "./remote-access-controls.tsx";
import { ChatForwardDialogMount } from "./chat-feedback-selection.tsx";

function ThreadComposerDialogs({ thread }: { thread: ChatPanelSignals }) {
  return (
    <>
      <ThreadRemoteAccessDialog signals={thread.composer} />
      <ChatForwardDialogMount feedback={thread.feedback} />
    </>
  );
}

function ThreadComposerDialogsMount() {
  const route = useGet(activeRoute$);
  const left = useGet(currentLeftThread$);
  const right = useGet(currentRightThread$);
  if (route !== "chat") {
    return null;
  }
  return (
    <>
      {left && <ThreadComposerDialogs key={left.threadId} thread={left} />}
      {right && right !== left && (
        <ThreadComposerDialogs key={right.threadId} thread={right} />
      )}
    </>
  );
}

function AgentAvatarInTopBar() {
  const agent = useLastResolved(currentChatAgent$);
  if (!agent) {
    return (
      <div className="h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden />
    );
  }
  return (
    <AvatarFromUrl
      avatarUrl={agent.avatarUrl}
      alt=""
      className="h-6 w-6 shrink-0 rounded-full object-cover object-top"
      data-testid="agent-avatar"
    />
  );
}

function InviteButtonLeaf() {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin = isAdminLoadable.state === "hasData" && isAdminLoadable.data;
  const openSettings = useSet(openSettingsDialogAt$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();
  if (!isAdmin) {
    return null;
  }
  return (
    <Button
      type="button"
      onClick={() => {
        detach(openSettings("people", pageSignal), Reason.DomCallback);
      }}
      variant="quiet"
      size="sm"
      className="shrink-0 gap-1.5"
    >
      <UserPlus size={14} />
      {t(($) => {
        return $.appShell.sidebar.mobile.invite;
      })}
    </Button>
  );
}

function useCurrentThread() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  return leftThread ?? rightThread;
}

function MobileResourcesButtonLeaf() {
  const thread = useCurrentThread();

  if (!thread) {
    return null;
  }

  return <ChatResourcesButton thread={thread} />;
}

function MobileAutomationButtonLeaf() {
  const thread = useCurrentThread();
  const { t } = useTranslation();

  if (!thread) {
    return null;
  }

  return (
    <AutomationMenuButton
      thread={thread}
      ariaLabel={t(($) => {
        return $.appShell.sidebar.mobile.openAutomations;
      })}
    />
  );
}

function MobileShareButtonInner({
  thread,
  largeTarget = false,
}: {
  thread: ChatPanelSignals;
  largeTarget?: boolean;
}) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const start = useSet(thread.sharing.start$);
  const pageSignal = useGet(pageSignal$);
  if (phase !== "idle") {
    return null;
  }
  return (
    <ChatHeaderIconButton
      thread={thread}
      icon={<Share2 size={18} />}
      label={t(($) => {
        return $.chat.sharing.start;
      })}
      largeTarget={largeTarget}
      usage={{
        kind: "action",
        onClick: () => {
          detach(
            start(pageSignal),
            Reason.DomCallback,
            "start shared thread selection",
          );
        },
      }}
    />
  );
}

function MobileShareButtonLeaf() {
  const thread = useCurrentThread();
  return thread ? <MobileShareButtonInner thread={thread} /> : null;
}

function MobileSharingOverlayInner({ thread }: { thread: ChatPanelSignals }) {
  const phase = useGet(thread.sharing.phase$);
  if (phase === "idle") {
    return null;
  }
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-between gap-2 bg-background px-4">
      <ChatShareSelectionControls sharing={thread.sharing} />
      <ChatShareCloseButton sharing={thread.sharing} />
    </div>
  );
}

function MobileSharingOverlayLeaf() {
  const thread = useCurrentThread();
  return thread ? <MobileSharingOverlayInner thread={thread} /> : null;
}

function MobileChatThreadActions({ thread }: { thread: ChatPanelSignals }) {
  const phase = useGet(thread.sharing.phase$);
  if (phase !== "idle") {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <MobileShareButtonInner thread={thread} largeTarget />
      <ThreadMailButton thread={thread} largeTarget />
      <ChatResourcesButton thread={thread} largeTarget />
      <MobileChatThreadMoreMenu thread={thread} />
    </div>
  );
}

function MobileTopBarActions({ activeId }: { activeId: RouteKey | null }) {
  const thread = useCurrentThread();
  if (activeId === "chat" && thread) {
    return (
      <SettledChatThreadActions thread={thread}>
        <MobileChatThreadActions thread={thread} />
      </SettledChatThreadActions>
    );
  }
  const inChatRoute = isChatRoute(activeId);
  const showInviteFallback = inChatRoute && activeId !== "chat";
  return (
    <>
      {inChatRoute && thread && (
        <SettledChatThreadActions thread={thread}>
          <MobileShareButtonLeaf />
          <MobileAutomationButtonLeaf />
          <MobileResourcesButtonLeaf />
        </SettledChatThreadActions>
      )}
      {showInviteFallback && <InviteButtonLeaf />}
    </>
  );
}

function MobileTopBar() {
  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);
  const thread = useCurrentThread();

  return (
    <div className="relative md:hidden shrink-0 flex items-center min-h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <MobileSharingOverlayLeaf />
      {isChatRoute(activeId) ? <PwaBackToChats /> : <PwaBackToParent />}
      {activeId === "chat" ? (
        <div className="flex-1 min-w-0">
          {thread && <ChatThreadHeaderTitle thread={thread} />}
        </div>
      ) : breadcrumb ? (
        <div className="flex-1 min-w-0 flex items-center gap-2 min-w-0">
          {breadcrumb.avatarAgentId && <AgentAvatarInTopBar />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium text-foreground flex items-center gap-1 min-w-0">
              {breadcrumb.sectionPath ? (
                <Link
                  pathname={breadcrumb.sectionPath}
                  options={breadcrumb.sectionOptions}
                  className="hover:opacity-70 no-underline text-inherit"
                >
                  {breadcrumb.section}
                </Link>
              ) : (
                <span>{breadcrumb.section}</span>
              )}
              {breadcrumb.name && (
                <>
                  <span className="text-foreground/30 select-none">/</span>
                  <span className="truncate" data-testid="breadcrumb-name">
                    {breadcrumb.name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <MobileTopBarActions activeId={activeId} />
    </div>
  );
}

function AttachmentLightboxMount() {
  const lightboxUrl = useGet(lightboxUrl$);
  return lightboxUrl ? <AttachmentLightbox /> : null;
}

/** Mounted only while open, so a closed dialog costs the shell nothing. */
function SkillImportDialogMount() {
  const open = useGet(skillImportDialogOpen$);
  return open ? <SkillImportDialog /> : null;
}

function ChatWorkspace({
  children,
  header,
  footer,
  pwaNavigation,
}: {
  readonly children: ReactNode;
  readonly header: ReactNode;
  readonly footer: ReactNode;
  readonly pwaNavigation: boolean;
}) {
  const route = useGet(activeRoute$);
  const threadSidebar = useGet(activeThreadSidebar$);
  const threadFullscreen = useGet(activeThreadSidebarFullscreen$);
  // A route can change before its setup releases the previous thread graph.
  const active = route === "chat" ? threadSidebar : null;
  const fullscreen = active !== null && threadFullscreen;
  return (
    <ChatThreadSidebarShell
      animateEntry={active?.animateEntry ?? true}
      open={active !== null}
      sidebar={active ? <ChatThreadSidebarPane /> : null}
      // Each panel kind remembers its own width, so widening the browser or a
      // preview never carries over to a list.
      widthKey={active?.target.type}
      workspace={{ header, footer, pwaNavigation, fullscreen }}
    >
      <WorkspaceInset
        surface="transparent"
        // The side panel, when open, holds the sheet's trailing corners.
        className={cn(
          SHEET_PANE_LEADING_CORNERS,
          !active && "md:rounded-r-2xl",
        )}
      >
        {children}
      </WorkspaceInset>
    </ChatThreadSidebarShell>
  );
}

function SidebarWorkspaceFrame({
  children,
  header,
  footer,
  pwaNavigation,
  chatWorkspace,
}: {
  children: ReactNode;
  header: ReactNode;
  footer: ReactNode;
  pwaNavigation: boolean;
  chatWorkspace: boolean;
}) {
  return chatWorkspace ? (
    <ChatWorkspace
      header={header}
      footer={footer}
      pwaNavigation={pwaNavigation}
    >
      {children}
    </ChatWorkspace>
  ) : (
    <WorkspaceInset>
      {header}
      {children}
      {footer}
    </WorkspaceInset>
  );
}

function SidebarWorkspace({
  children,
  pwaNavigation,
}: {
  children: ReactNode;
  pwaNavigation: boolean;
}) {
  const chatListVisible = useGet(pwaChatListVisible$);
  const activeRoute = useGet(activeRoute$);
  const singleAgent = useLastResolved(singleAgentEnabled$);
  const agentChatPage =
    activeRoute === "agentChat" || (activeRoute === "home" && singleAgent);

  if (activeRoute === "home" && singleAgent === undefined) {
    return null;
  }

  const workspaceHeader = (
    <>
      <InstallBanner />
      <IosInstallModal />
      {pwaNavigation &&
        activeRoute !== "me" &&
        !(agentChatPage && chatListVisible) && <MobileTopBar />}
    </>
  );
  // Keep the transcript mounted when rotation crosses the mobile breakpoint.
  // Native scroll anchoring needs the same reading DOM on both sides.
  const workspaceContent = (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        pwaNavigation && "[--okou-safe-b:0px]",
      )}
    >
      {children}
    </div>
  );
  const workspaceFooter = pwaNavigation ? <PwaBottomNavigation /> : null;
  return (
    <SidebarWorkspaceFrame
      chatWorkspace={
        Boolean(agentChatPage) ||
        activeRoute === "chat" ||
        activeRoute === "project"
      }
      header={workspaceHeader}
      footer={workspaceFooter}
      pwaNavigation={pwaNavigation}
    >
      {workspaceContent}
    </SidebarWorkspaceFrame>
  );
}

/**
 * The workspace sheet: one framed card holding the chat list and the
 * workspace pane, in the shape of shadcn's inset sidebar. It owns the margin,
 * hairline and corners. While the list is expanded the sheet joins the nav
 * rail's edge; collapsed, it keeps the frame on all four sides. Descendants
 * read the list's state from `data-chat-list` through the `workspace-sheet`
 * group rather than a prop.
 *
 * The sheet must not establish a stacking context or containing block: the
 * thread sidebar's fixed surface competes inside #root.
 */
function WorkspaceSheet({
  chatList,
  children,
}: {
  readonly chatList: ReactNode;
  readonly children: ReactNode;
}) {
  const chatListHidden = useGet(sidebarOff$);
  // Keep the workspace in the same child slot whether or not the list
  // renders, so crossing the mobile breakpoint does not remount it.
  return (
    <div
      data-slot="workspace-sheet"
      data-chat-list={chatList && !chatListHidden ? "expanded" : "collapsed"}
      className="group/workspace-sheet flex min-h-0 min-w-0 flex-1 md:m-2 md:rounded-2xl md:border md:border-border md:data-[chat-list=expanded]:ml-0"
    >
      {chatList}
      {children}
    </div>
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
  const paletteColorTheme = useGet(paletteColorTheme$);
  const shellRef = useSet(threadSidebarLayoutRootRef$);
  const pwaNavigation = useGet(mobileChatViewport$);

  return withChatScrollLayout(
    <div
      ref={shellRef}
      data-slot="app-shell"
      className={cn(
        "box-border flex h-full max-h-full min-h-full w-full overflow-hidden bg-background pb-0",
        // The workspace's ground is the whole rail, not a thin frame, so it
        // sits one stop below the sheet in either theme.
        "md:bg-workspace-ground",
      )}
      data-gradient-color-themes={
        paletteColorTheme === undefined ? undefined : true
      }
      data-color-theme={paletteColorTheme}
    >
      <ProjectDialogs />
      <SettingsDialogMount />
      <PersonalSubscriptionDialogs />
      <ChatShortcutHelpDialog />
      <ConcurrencyConfirmDialog />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      <CheckoutAbandonedSurveyDialog />
      <AttachmentLightboxMount />
      <SkillImportDialogMount />
      <CreateAgentDialogContainer />
      <QueueDrawer />
      {/* Keep in-flight remote permission actions with the workspace owner. */}
      <ThreadComposerDialogsMount />
      {pwaNavigation ? (
        <>
          <ChatThreadDialogs />
          <ThreeColumnSearchDialogContainer />
        </>
      ) : (
        <Sidebar />
      )}
      <WorkspaceSheet chatList={pwaNavigation ? null : <ChatListPane />}>
        <SidebarWorkspace pwaNavigation={pwaNavigation}>
          {children}
        </SidebarWorkspace>
      </WorkspaceSheet>
    </div>,
  );
}

function SidebarRouteGuard({ children }: { children: ReactNode }) {
  const activeRoute = useGet(activeRoute$);
  const pwaNavigation = useGet(mobileChatViewport$);

  return activeRoute === "me" && !pwaNavigation ? <NotFoundPage /> : children;
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  // Route availability updates the guard while the shell keeps its element
  // identity. Route-specific workspace and navigation own their subscriptions.
  return (
    <SidebarRouteGuard>
      <SidebarLayoutInner>{children}</SidebarLayoutInner>
    </SidebarRouteGuard>
  );
}
