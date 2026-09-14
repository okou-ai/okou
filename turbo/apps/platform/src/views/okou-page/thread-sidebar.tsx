import type { UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ExternalLink, Maximize, Minimize, X } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { Button, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { openThreadArtifacts$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ThreadSidebarArtifactSource,
  ThreadSidebarTarget,
} from "../../signals/chat-page/thread-sidebar.ts";
import { artifactDetailPreview } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import {
  ArtifactCatalogEmpty,
  ArtifactCatalogError,
  ArtifactCatalogGrid,
  ArtifactCatalogSkeleton,
} from "../artifacts-page/artifact-catalog-page.tsx";
import { BrowserSessionSidebar } from "./browser-session-sidebar.tsx";
import { MailDraftSidebar } from "./mail-draft-sidebar.tsx";
import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { ArtifactSidebar } from "./artifact-sidebar.tsx";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar content.
//
// The outer ChatThreadSidebarShell owns width, resize, and the responsive
// split. This module chooses among the five mutually exclusive bodies and
// routes Close/Back/fullscreen into the owning thread's `sidebar` signals.
// ---------------------------------------------------------------------------

const ARTIFACT_AUTO_LOAD_THRESHOLD_PX = 800;

const THREAD_SIDEBAR_FULLSCREEN_CLASSNAME =
  "fixed inset-0 z-[100] flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";

/**
 * Open the thread's artifacts list and refresh its first page. Entry buttons
 * and the detail's Back action share this hook so the list is current on open.
 */
export function useOpenThreadArtifacts(thread: ChatPanelSignals): () => void {
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
}: {
  readonly title: string;
  readonly fullscreen?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onBack?: () => void;
  readonly onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
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

function ThreadArtifactsPanel({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const sidebar = thread.sidebar;
  const catalogLoadable = useLastLoadable(sidebar.artifactCatalog.catalog$);
  const fullscreen = useGet(sidebar.fullscreen$);
  const toggleFullscreen = useSet(sidebar.toggleFullscreen$);
  const close = useSet(sidebar.close$);
  const open = useSet(sidebar.open$);
  const loadMore = useSet(sidebar.artifactCatalog.loadMore$);
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
    if (!hasMore) {
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

  const panel = (
    <aside
      aria-label={t(($) => {
        return $.artifacts.sidebar.panelTitle;
      })}
      data-testid="thread-sidebar-artifacts"
      className={cn(
        fullscreen
          ? THREAD_SIDEBAR_FULLSCREEN_CLASSNAME
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
      )}
    >
      <ThreadSidebarHeader
        title={t(($) => {
          return $.artifacts.sidebar.panelTitle;
        })}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onClose={close}
      />
      <div
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {artifacts === null ? (
          catalogLoadable.state === "hasError" ? (
            <ArtifactCatalogError />
          ) : (
            <ArtifactCatalogSkeleton />
          )
        ) : artifacts.length === 0 ? (
          <ArtifactCatalogEmpty />
        ) : (
          <ArtifactCatalogGrid
            artifacts={artifacts}
            onOpen={(artifactId) => {
              open(
                {
                  type: "artifact",
                  source: { kind: "catalog", artifactId },
                },
                pageSignal,
              );
            }}
          />
        )}
      </div>
    </aside>
  );
  // This is an app-local fullscreen surface, not a modal. Keep it inside the
  // isolated app stack so body-level Base UI portals remain above it by
  // structure rather than by competing z-index values.
  const appRoot =
    typeof document === "undefined" ? null : document.getElementById("root");
  return fullscreen && appRoot ? createPortal(panel, appRoot) : panel;
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
  const openAttachment = useSet(sidebar.openAttachment$);
  const backToArtifacts = useOpenThreadArtifacts(thread);
  const pageSignal = useGet(pageSignal$);
  const detailLoadable = useLastLoadable(
    sidebar.artifactCatalog.selectedArtifactDetail$,
  );

  const fullscreenState = {
    active: fullscreen,
    toggle: toggleFullscreen,
  };
  const navigateImage = (url: string) => {
    openAttachment(url, pageSignal);
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
      <aside className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0">
        <ThreadSidebarHeader
          title={detail.title}
          onBack={backToArtifacts}
          onClose={close}
        />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <a
            href={`/share/threads/${encodeURIComponent(detail.sharedThread.id)}`}
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

  const preview = artifactDetailPreview(detail);
  return (
    <ArtifactSidebar
      artifactRef={{
        url: preview.url,
        resourceUrl$: sidebar.selectedArtifactResourceUrl$,
        shareUrl$: sidebar.selectedArtifactShareUrl$,
        kind: preview.kind,
        filename: preview.filename,
      }}
      thread={thread}
      text$={sidebar.selectedArtifactText$}
      markdownTree$={sidebar.selectedArtifactMarkdownTree$}
      fullscreenState={fullscreenState}
      onBack={backToArtifacts}
      onClose={close}
      onNavigateImage={navigateImage}
    />
  );
}

function ThreadMailDraftPanel({
  thread,
  signals,
}: {
  readonly thread: ChatPanelSignals;
  readonly signals: MailDraftSignals;
}) {
  const close = useSet(thread.sidebar.close$);
  return <MailDraftSidebar signals={signals} onClose={close} />;
}

function ThreadBrowserSessionPanel({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const close = useSet(thread.sidebar.close$);
  return (
    <BrowserSessionSidebar
      signals={thread.browserSessionSignals}
      onClose={close}
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
      // Rendered by ChatThreadPage directly: the automations body lives in
      // the page module and importing it here would create an import cycle.
      return null;
    }
    case "email-draft": {
      return <ThreadMailDraftPanel thread={thread} signals={target.signals} />;
    }
    case "browser": {
      return <ThreadBrowserSessionPanel thread={thread} />;
    }
  }
}
