import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { AppPageRoot } from "../components/app-page-root.tsx";
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Menu, Package, Share2, UserPlus } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RouteKey } from "../../signals/route-paths.ts";
import { Button, cn, useMediaQuery } from "@okouai/ui";
import { Sidebar } from "./sidebar.tsx";
import {
  AutomationMenuButton,
  ChatThreadHeaderTitle,
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
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ConcurrencyConfirmDialog } from "./components/org-manage/org-billing-tab.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { lightboxUrl$ } from "../../signals/okou-page/attachment-chips.ts";
import { AttachmentLightbox } from "./attachment-chips.tsx";
import {
  colorTheme$,
  shellDocumentAttributesRef$,
} from "../../signals/theme.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import { WorkspaceInset } from "./workspace-inset.tsx";
import { MobileChatThreadMoreMenu } from "./chat-thread-header-actions.tsx";

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
        open && "bg-primary/10 text-brand-text hover:text-brand-text",
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
  const headerActionsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadHeaderActions];
  const thread = useCurrentThread();
  if (headerActionsEnabled && activeId === "chat" && thread) {
    return <MobileChatThreadActions thread={thread} />;
  }
  const inChatRoute = isChatRoute(activeId);
  const showInviteFallback = inChatRoute && activeId !== "chat";
  return (
    <>
      {inChatRoute && <MobileShareButtonLeaf />}
      {inChatRoute && <MobileAutomationButtonLeaf />}
      {inChatRoute && <MobileArtifactsButtonLeaf />}
      {showInviteFallback && <InviteButtonLeaf />}
    </>
  );
}

function MobileTopBar() {
  const setExpanded = useSet(setSidebarExpanded$);
  const { t } = useTranslation();

  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  const activeId = useGet(activeRoute$);
  const thread = useCurrentThread();

  return (
    <div className="relative md:hidden shrink-0 flex items-center min-h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <MobileSharingOverlayLeaf />
      <Button
        showTooltip
        type="button"
        onClick={() => {
          setExpanded(true);
        }}
        variant="quiet"
        size="icon-sm"
        iconSize="md"
        className="shrink-0"
        aria-label={t(($) => {
          return $.appShell.sidebar.mobile.openMenu;
        })}
      >
        <Menu size={18} />
      </Button>
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
                  className="hover:opacity-70 transition-opacity no-underline text-inherit"
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

function MobileSidebarMount() {
  const expanded = useGet(sidebarExpanded$);
  const setExpanded = useSet(setSidebarExpanded$);
  const { t } = useTranslation();

  return (
    <>
      <Sidebar isDesktop={false} />
      <div
        data-sidebar-expanded={expanded || undefined}
        className="okou-pwa-fixed-cover fixed inset-0 z-30 bg-black/40 hidden data-[sidebar-expanded]:max-md:block"
        aria-label={t(($) => {
          return $.appShell.sidebar.mobile.overlay;
        })}
        onClick={() => {
          return setExpanded(false);
        }}
      />
    </>
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
  const colorTheme = useGet(colorTheme$);
  const features = useGet(featureSwitch$);
  const gradientColorThemesEnabled =
    features[FeatureSwitchKey.GradientColorThemes] ?? false;
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const shellDocumentAttributesRef = useSet(shellDocumentAttributesRef$);

  return withChatScrollLayout(
    <AppPageRoot
      ref={shellDocumentAttributesRef}
      bottomSafeArea="content"
      className="okou-app flex w-full bg-background md:bg-sidebar"
      data-gradient-color-themes={gradientColorThemesEnabled || undefined}
      data-color-theme={gradientColorThemesEnabled ? colorTheme : undefined}
    >
      <SettingsDialogMount />
      <ChatShortcutHelpDialog />
      <ConcurrencyConfirmDialog />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      <AttachmentLightboxMount />
      <QueueDrawer />
      {isDesktop ? <Sidebar isDesktop /> : <MobileSidebarMount />}
      <WorkspaceInset>
        <InstallBanner />
        <IosInstallModal />
        {!isDesktop && <MobileTopBar />}
        {children}
      </WorkspaceInset>
    </AppPageRoot>,
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
