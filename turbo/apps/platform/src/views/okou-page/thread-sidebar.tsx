import type { UIEvent as ReactUIEvent } from "react";
import { ArrowLeft, ExternalLink, Maximize, Minimize, X } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, FullscreenPanel, buttonVariants, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "../../i18n/format.ts";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  closeThreadMailDraft$,
  closeDeletedThreadArtifact$,
  openThreadArtifacts$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ThreadSidebarArtifactSource,
  ThreadSidebarTarget,
} from "../../signals/chat-page/thread-sidebar.ts";
import { artifactDetailPreview } from "../../signals/artifacts-page/artifact-catalog-preview.ts";
import {
  ArtifactCatalogEmpty,
  ArtifactCatalogError,
  ArtifactCatalogGrid,
  ArtifactCatalogSkeleton,
} from "../artifacts-page/artifact-catalog-page.tsx";
import { BrowserSessionSidebar } from "./browser-session-sidebar.tsx";
import { BrowserPresence } from "./browser-presence.tsx";
import { MailDraftPanel } from "./mail-draft-panel.tsx";
import { ThreadMailLink } from "./thread-mail.tsx";
import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import {
  ArtifactSidebar,
  ArtifactSidebarContent,
  artifactSidebarSyncTarget,
} from "./artifact-sidebar.tsx";
import { ArtifactDiagramLightbox } from "../components/artifact-diagram-lightbox.tsx";
import type { ImageArtifactNavigationItem } from "./artifact-image-navigation.ts";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar content.
//
// The outer ChatThreadSidebarShell owns width, resize, and the responsive
// split. This module chooses among the five mutually exclusive bodies and
// routes Close/Back/fullscreen into the owning thread's `sidebar` signals.
// ---------------------------------------------------------------------------

const ARTIFACT_AUTO_LOAD_THRESHOLD_PX = 800;

/**
 * Return from an artifact detail to the thread's gallery and refresh its first page.
 */
function useOpenThreadArtifacts(thread: ChatPanelSignals): () => void {
  const open = useSet(openThreadArtifacts$);
  const reloadArtifacts = useSet(thread.sidebar.artifactCatalog.reload$);
  return () => {
    open(thread);
    reloadArtifacts();
  };
}

function ThreadSidebarHeader({
  title,
  fullscreen,
  onToggleFullscreen,
  onBack,
  onClose,
  separated = true,
}: {
  readonly title: string;
  readonly fullscreen?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly separated?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-1 px-4",
        separated && "border-b border-border/60",
      )}
    >
      {onBack ? (
        <Button
          showTooltip
          type="button"
          onClick={onBack}
          aria-label={t(($) => {
            return $.artifacts.actions.backToArtifacts;
          })}
          variant="quiet"
          size="icon-sm"
        >
          <ArrowLeft size={16} />
        </Button>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      {onToggleFullscreen ? (
        <Button
          showTooltip
          type="button"
          onClick={onToggleFullscreen}
          aria-label={
            fullscreen
              ? t(($) => {
                  return $.artifacts.actions.exitFullscreen;
                })
              : t(($) => {
                  return $.artifacts.actions.enterFullscreen;
                })
          }
          data-testid="thread-sidebar-fullscreen-toggle"
          variant="quiet"
          size="icon-sm"
          className="hidden xl:inline-flex"
        >
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </Button>
      ) : null}
      <Button
        showTooltip
        type="button"
        onClick={onClose}
        aria-label={t(
          ($) => {
            return $.artifacts.actions.closeNamed;
          },
          {
            title: title.toLocaleLowerCase(
              i18n.resolvedLanguage ?? i18n.language,
            ),
          },
        )}
        variant="quiet"
        size="icon-sm"
      >
        <X size={16} />
      </Button>
    </div>
  );
}

function ThreadArtifactsPanel({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.artifacts.sidebar.panelTitle;
  });
  const sidebar = thread.sidebar;
  const catalogLoadable = useLastLoadable(sidebar.artifactCatalog.catalog$);
  const fullscreen = useGet(sidebar.fullscreen$);
  const toggleFullscreen = useSet(sidebar.toggleFullscreen$);
  const close = useSet(sidebar.close$);
  const openCatalogArtifact = useSet(sidebar.openCatalogArtifact$);
  const [paging, loadMore] = useLoadableSet(sidebar.artifactCatalog.loadMore$);
  const pageSignal = useGet(pageSignal$);

  // useLastLoadable keeps the previously resolved pages rendered while the
  // session's background refresh replaces the first page, so reopening the
  // sidebar never falls back to the skeleton once data exists.
  const artifacts =
    catalogLoadable.state === "hasData" ? catalogLoadable.data.artifacts : null;
  const hasMore =
    catalogLoadable.state === "hasData" &&
    catalogLoadable.data.nextCursor !== null;

  const handleScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (!hasMore || paging.state === "loading") {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > ARTIFACT_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(
      loadMore(pageSignal),
      Reason.DomCallback,
      "thread artifacts sidebar paging",
    );
  };

  const artifactsContent =
    artifacts === null ? (
      catalogLoadable.state === "hasError" ? (
        <ArtifactCatalogError />
      ) : (
        <ArtifactCatalogSkeleton appearance="gallery" />
      )
    ) : artifacts.length === 0 ? (
      <ArtifactCatalogEmpty />
    ) : (
      <ArtifactCatalogGrid
        artifacts={artifacts}
        appearance="gallery"
        onOpen={(artifactId) => {
          detach(
            openCatalogArtifact(artifactId, pageSignal),
            Reason.DomCallback,
            "thread artifact catalog preview",
          );
        }}
      />
    );

  return (
    <FullscreenPanel
      as="aside"
      fullscreen={fullscreen}
      className={
        fullscreen ? "h-viewport max-h-viewport min-h-viewport" : undefined
      }
      aria-label={title}
      data-testid="thread-sidebar-artifacts"
    >
      <ThreadSidebarHeader
        title={title}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onClose={close}
        separated={false}
      />
      <div className="shrink-0 border-b border-border/60 px-4 pb-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {t(($) => {
            return $.artifacts.sidebar.panelTitle;
          })}
          {artifacts !== null && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {formatLocalizedNumber(artifacts.length)}
              {hasMore ? "+" : ""}
            </span>
          )}
        </h3>
      </div>
      <div
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
      >
        {artifactsContent}
      </div>
    </FullscreenPanel>
  );
}

function ThreadArtifactUnavailable({
  thread,
  showBack,
}: {
  readonly thread: ChatPanelSignals;
  readonly showBack: boolean;
}) {
  const { t } = useTranslation();
  const close = useSet(thread.sidebar.close$);
  const backToArtifacts = useOpenThreadArtifacts(thread);
  return (
    <aside
      aria-label={t(($) => {
        return $.artifacts.sidebar.singularTitle;
      })}
      data-testid="thread-sidebar-artifact-unavailable"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <ThreadSidebarHeader
        title={t(($) => {
          return $.artifacts.sidebar.singularTitle;
        })}
        onBack={showBack ? backToArtifacts : undefined}
        onClose={close}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.sidebar.unavailable;
        })}
      </div>
    </aside>
  );
}

function ThreadSharedArtifactDetail({
  title,
  sharedThreadId,
  onBack,
  onClose,
}: {
  readonly title: string;
  readonly sharedThreadId: string;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0">
      <ThreadSidebarHeader title={title} onBack={onBack} onClose={onClose} />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <a
          href={`/share/threads/${encodeURIComponent(sharedThreadId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          <ExternalLink size={16} />
          {t(($) => {
            return $.artifacts.sidebar.openSharedConversation;
          })}
        </a>
      </div>
    </aside>
  );
}

function ThreadArtifactDetail({
  thread,
  source,
}: {
  readonly thread: ChatPanelSignals;
  readonly source: ThreadSidebarArtifactSource;
}) {
  const { t } = useTranslation();
  const sidebar = thread.sidebar;
  const fullscreen = useGet(sidebar.fullscreen$);
  const toggleFullscreen = useSet(sidebar.toggleFullscreen$);
  const close = useSet(sidebar.close$);
  const closeDeleted = useSet(closeDeletedThreadArtifact$);
  const openAttachment = useSet(sidebar.openAttachment$);
  const backToArtifacts = useOpenThreadArtifacts(thread);
  const pageSignal = useGet(pageSignal$);
  const detailLoadable = useLastLoadable(
    sidebar.artifactCatalog.selectedArtifactDetail$,
  );
  const reloadDetail = useSet(
    sidebar.artifactCatalog.reloadSelectedArtifactDetail$,
  );

  const fullscreenState = {
    active: fullscreen,
    toggle: toggleFullscreen,
  };
  const navigateImage = (item: ImageArtifactNavigationItem) => {
    openAttachment(
      {
        url: item.url,
        filename: item.filename,
        ...(item.preview ? { preview: item.preview } : {}),
      },
      pageSignal,
    );
  };

  if (source.kind === "attachment") {
    return (
      <ArtifactSidebar
        artifactRef={source.ref}
        thread={thread}
        fullscreenState={fullscreenState}
        onClose={close}
        onNavigateImage={navigateImage}
      />
    );
  }

  if (detailLoadable.state === "loading") {
    return (
      <aside
        aria-label={t(($) => {
          return $.artifacts.sidebar.singularTitle;
        })}
        className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
      >
        <ThreadSidebarHeader
          title={t(($) => {
            return $.artifacts.sidebar.singularTitle;
          })}
          onBack={backToArtifacts}
          onClose={close}
        />
        <div className="min-h-0 flex-1 px-4 py-4">
          <div className="h-full w-full animate-pulse rounded-lg bg-muted/30" />
        </div>
      </aside>
    );
  }

  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  if (!detail) {
    // 404 (or a load error) keeps the sidebar mounted so the page layout does
    // not jump; the list stays one Back away.
    return <ThreadArtifactUnavailable thread={thread} showBack />;
  }

  if (detail.kind === "shared-thread") {
    return (
      <ThreadSharedArtifactDetail
        title={detail.title}
        sharedThreadId={detail.sharedThread.id}
        onBack={backToArtifacts}
        onClose={close}
      />
    );
  }

  const preview = artifactDetailPreview(detail);
  return (
    <>
      <ArtifactSidebarContent
        artifactId={detail.id}
        onDeleted={() => {
          closeDeleted(thread, pageSignal);
        }}
        syncTarget={artifactSidebarSyncTarget({
          agentId: thread.agentId,
          file: {
            artifactId: detail.id,
            filename: preview.filename,
            googleDriveConnectionId: detail.googleDriveConnectionId,
            googleDriveSync: detail.googleDriveSync,
          },
          onSyncSuccess: reloadDetail,
        })}
        artifactRef={{
          url: preview.url,
          resourceUrl$: sidebar.selectedArtifactResourceUrl$,
          shareUrl$: sidebar.selectedArtifactShareUrl$,
          kind: preview.kind,
          filename: preview.filename,
        }}
        artifactKind={
          detail.kind === "presentation"
            ? "presentation-html"
            : detail.kind === "hosted-site"
              ? "hosted-site"
              : undefined
        }
        imageCanvasSignals={sidebar.imageCanvas}
        text$={sidebar.selectedArtifactText$}
        markdownTree$={sidebar.selectedArtifactMarkdownTree$}
        fullscreenState={fullscreenState}
        onBack={backToArtifacts}
        onClose={close}
      />
      <ArtifactDiagramLightbox signals={sidebar.diagram} />
    </>
  );
}

function ThreadMailDraftPanel({
  thread,
  signals,
  fromMailList,
}: {
  readonly thread: ChatPanelSignals;
  readonly signals: MailDraftSignals;
  readonly fromMailList?: true;
}) {
  const closeDraft = useSet(closeThreadMailDraft$);
  const close = () => {
    closeDraft(thread, signals);
  };
  const backLinkRef = useSet(thread.mail.backLinkRef$);
  const listOpen = useGet(thread.mail.open$);
  const { t } = useTranslation();
  if (!fromMailList) {
    return <MailDraftPanel signals={signals} onClose={close} />;
  }
  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col bg-background",
        !listOpen && "[view-transition-name:thread-email-panel]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
        <ThreadMailLink
          ref={backLinkRef}
          thread={thread}
          destination={{ view: "list" }}
          className={buttonVariants({ variant: "quiet", size: "sm" })}
        >
          <ArrowLeft size={16} />
          {t(($) => {
            return $.chat.mail.manager.back;
          })}
        </ThreadMailLink>
        <Button
          showTooltip
          type="button"
          onClick={close}
          aria-label={t(($) => {
            return $.chat.mail.closeDetails;
          })}
          variant="quiet"
          size="icon-sm"
        >
          <X size={16} />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <MailDraftPanel
          signals={signals}
          onClose={close}
          showCloseButton={false}
        />
      </div>
    </div>
  );
}

function ThreadBrowserSessionPanel({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const close = useSet(thread.sidebar.close$);
  const takeOver = useSet(thread.browserPresence.takeOver$);
  const pageSignal = useGet(pageSignal$);
  return (
    <BrowserSessionSidebar
      signals={thread.browserSessionSignals}
      onClose={close}
      overlay={<BrowserPresence thread={thread} />}
      onPageInput={() => {
        detach(
          takeOver(
            t(($) => {
              return $.browserSession.presence.takeOverMessage;
            }),
            pageSignal,
          ),
          Reason.DomCallback,
          "take over the cloud browser from page input",
        );
      }}
    />
  );
}

export function ThreadSidebarSlot({
  thread,
  target,
}: {
  readonly thread: ChatPanelSignals;
  readonly target: ThreadSidebarTarget;
}) {
  switch (target.type) {
    case "artifacts": {
      return <ThreadArtifactsPanel thread={thread} />;
    }
    case "artifact": {
      return <ThreadArtifactDetail thread={thread} source={target.source} />;
    }
    case "automations": {
      // Rendered by ChatThreadSidebarPane: the automations body lives in
      // the page module and importing it here would create an import cycle.
      return null;
    }
    case "email-draft": {
      return (
        <ThreadMailDraftPanel
          thread={thread}
          signals={target.signals}
          fromMailList={target.fromMailList}
        />
      );
    }
    case "browser": {
      return <ThreadBrowserSessionPanel thread={thread} />;
    }
  }
}
