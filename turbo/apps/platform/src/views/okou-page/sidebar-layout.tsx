import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { chatLayout } from "../../signals/chat-page/chat-layout.ts";
import {
  activeThreadSidebar$,
  activeThreadSidebarFullscreen$,
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
import { Menu, Package, Share2, UserPlus } from "lucide-react";
import type { RouteKey } from "../../signals/route-paths.ts";
import { Button, Sheet, SheetTrigger, cn, useMediaQuery } from "@okouai/ui";
import { Sidebar, ThreeColumnSearchDialogContainer } from "./sidebar.tsx";
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
import {
  sidebarExpanded$,
  setSidebarExpanded$,
  sidebarOff$,
  isChatRoute,
} from "../../signals/okou-page/nav.ts";
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
import { useOpenThreadArtifacts } from "./thread-sidebar.tsx";
import { ChatShortcutHelpDialog } from "./chat-shortcut-help-dialog.tsx";
import { ConcurrencyConfirmDialog } from "./components/org-manage/org-billing-tab.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { lightboxUrl$ } from "../../signals/okou-page/attachment-chips.ts";
import { AttachmentLightbox } from "./attachment-chips.tsx";
import { skillImportDialogOpen$ } from "../../signals/skill-import/skill-import-dialog.ts";
import { SkillImportDialog } from "../skill-import/skill-import-dialog.tsx";
import {
  paletteColorTheme$,
  shellDocumentAttributesRef$,
} from "../../signals/theme.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import { WorkspaceInset } from "./workspace-inset.tsx";
import { MobileChatThreadMoreMenu } from "./chat-thread-header-actions.tsx";
import {
  pwaChatListVisible$,
  pwaNavigationEnabled$,
} from "../../signals/okou-page/pwa-navigation.ts";
import { PwaBackToChats, PwaBottomNavigation } from "./pwa-navigation.tsx";
import { ChatThreadDialogs } from "./sidebar-threads.tsx";
import { NotFoundPage } from "../not-found-page.tsx";

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

function MobileArtifactsButtonInner({ thread }: { thread: ChatPanelSignals }) {
  const sidebarTarget = useGet(thread.sidebar.target$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openThreadArtifacts = useOpenThreadArtifacts(thread);
  const { t } = useTranslation();
  const open = sidebarTarget?.type === "artifacts";

  return (
    <Button
      showTooltip
      type="button"
      onClick={() => {
        reloadArtifacts();
        openThreadArtifacts();
      }}
      variant="quiet"
      size="icon-sm"
      className={cn(
        "shrink-0",
        open &&
          "bg-primary/10 text-selected-foreground hover:text-selected-foreground",
      )}
      aria-label={t(($) => {
        return $.appShell.sidebar.mobile.openArtifacts;
      })}
      aria-pressed={open}
    >
      <Package size={16} />
    </Button>
  );
}

function useCurrentThread() {
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  return leftThread ?? rightThread;
}

function MobileArtifactsButtonLeaf() {
  const thread = useCurrentThread();

  if (!thread) {
    return null;
  }

  return <MobileArtifactsButtonInner thread={thread} />;
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
    <Button
      showTooltip
      type="button"
      onClick={() => {
        detach(
          start(pageSignal),
          Reason.DomCallback,
          "start shared thread selection",
        );
      }}
      variant="quiet"
      size="icon-sm"
      iconSize={largeTarget ? "md" : "sm"}
      className={cn("shrink-0", largeTarget && "size-11")}
      aria-label={t(($) => {
        return $.chat.sharing.start;
      })}
    >
      <Share2 size={16} />
    </Button>
  );
}

function MobileShareButtonLeaf() {
  const thread = useCurrentThread();
  return thread ? <MobileShareButtonInner thread={thread} /> : null;
}

function MobileSharingOverlayInner({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const close = useSet(thread.sharing.close$);
  const pageSignal = useGet(pageSignal$);
  if (phase === "idle") {
    return null;
  }
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-between bg-background px-4">
      <span className="text-sm font-medium text-foreground">
        {t(
          ($) => {
            return $.chat.sharing.selectedCount;
          },
          { count: selectedCount },
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          detach(
            close(pageSignal),
            Reason.DomCallback,
            "close shared thread selection",
          );
        }}
      >
        {t(($) => {
          return $.chat.sharing.cancel;
        })}
      </Button>
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
          <MobileArtifactsButtonLeaf />
        </SettledChatThreadActions>
      )}
      {showInviteFallback && <InviteButtonLeaf />}
    </>
  );
}

function MobileTopBar({ pwaNavigation = false }: { pwaNavigation?: boolean }) {
  const { t } = useTranslation();

  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);
  const thread = useCurrentThread();

  return (
    <div className="relative md:hidden shrink-0 flex items-center min-h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <MobileSharingOverlayLeaf />
      {pwaNavigation ? (
        isChatRoute(activeId) ? (
          <PwaBackToChats />
        ) : null
      ) : (
        <SheetTrigger
          render={
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className="shrink-0"
              aria-label={t(($) => {
                return $.appShell.sidebar.mobile.openMenu;
              })}
            />
          }
        >
          <Menu size={18} />
        </SheetTrigger>
      )}
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

function MobileSidebarMount() {
  const expanded = useGet(sidebarExpanded$);
  const setExpanded = useSet(setSidebarExpanded$);

  return (
    <Sheet open={expanded} onOpenChange={setExpanded}>
      <MobileTopBar />
      <Sidebar isDesktop={false} />
    </Sheet>
  );
}

function StableChatWorkspace({
  children,
  beside,
  header,
  footer,
  pwaNavigation,
}: {
  readonly children: ReactNode;
  readonly beside: "chat-list" | "nav-rail";
  readonly header: ReactNode;
  readonly footer: ReactNode;
  readonly pwaNavigation: boolean;
}) {
  const active = useGet(activeThreadSidebar$);
  const fullscreen = useGet(activeThreadSidebarFullscreen$);
  return (
    <ChatThreadSidebarShell
      layout={chatLayout}
      animateEntry={active?.animateEntry ?? true}
      open={active !== null}
      sidebar={<ChatThreadSidebarPane />}
      workspace={{ beside, header, footer, pwaNavigation, fullscreen }}
    >
      <WorkspaceInset
        beside={beside}
        framed={false}
        className={active ? "md:rounded-l-xl" : "md:rounded-xl"}
      >
        {children}
      </WorkspaceInset>
    </ChatThreadSidebarShell>
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
  const paletteColorTheme = useGet(paletteColorTheme$);
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const chatListHidden = useGet(sidebarOff$);
  const shellDocumentAttributesRef = useSet(shellDocumentAttributesRef$);
  const pwaNavigation = useGet(pwaNavigationEnabled$);
  const chatListVisible = useGet(pwaChatListVisible$);
  const activeRoute = useGet(activeRoute$);
  const stableHost =
    useGet(featureSwitch$)[FeatureSwitchKey.StablePreviewFullscreen];

  if (activeRoute === "me" && !pwaNavigation) {
    return <NotFoundPage />;
  }

  const workspaceHeader = (
    <>
      <InstallBanner />
      <IosInstallModal />
      {!isDesktop &&
        !(
          pwaNavigation &&
          (activeRoute === "me" ||
            (activeRoute === "agentChat" && chatListVisible))
        ) &&
        (pwaNavigation ? (
          <MobileTopBar pwaNavigation />
        ) : (
          <MobileSidebarMount />
        ))}
    </>
  );
  const workspaceContent = pwaNavigation ? (
    <div className="flex min-h-0 flex-1 flex-col [--okou-safe-b:0px]">
      {children}
    </div>
  ) : (
    children
  );
  const workspaceFooter = pwaNavigation ? <PwaBottomNavigation /> : null;
  const beside = chatListHidden ? "nav-rail" : "chat-list";

  return withChatScrollLayout(
    <div
      ref={shellDocumentAttributesRef}
      data-slot="app-shell"
      className="box-border flex h-full max-h-full min-h-full w-full overflow-hidden bg-background pb-0 md:bg-sidebar"
      data-gradient-color-themes={
        paletteColorTheme === undefined ? undefined : true
      }
      data-color-theme={paletteColorTheme}
    >
      <SettingsDialogMount />
      <ChatShortcutHelpDialog />
      <ConcurrencyConfirmDialog />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      <AttachmentLightboxMount />
      <SkillImportDialogMount />
      <QueueDrawer />
      {pwaNavigation ? (
        <>
          <ChatThreadDialogs />
          <ThreeColumnSearchDialogContainer />
        </>
      ) : isDesktop ? (
        <Sidebar isDesktop />
      ) : null}
      {stableHost && activeRoute === "chat" ? (
        <StableChatWorkspace
          beside={beside}
          header={workspaceHeader}
          footer={workspaceFooter}
          pwaNavigation={pwaNavigation}
        >
          {workspaceContent}
        </StableChatWorkspace>
      ) : (
        <WorkspaceInset beside={beside}>
          {workspaceHeader}
          {workspaceContent}
          {workspaceFooter}
        </WorkspaceInset>
      )}
    </div>,
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
