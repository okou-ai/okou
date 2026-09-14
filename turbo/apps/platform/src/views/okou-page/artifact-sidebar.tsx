import type { ReactNode } from "react";
import {
  ArrowLeft,
  Maximize2,
  Minimize2,
  Ellipsis,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ArtifactRef } from "../../signals/chat-page/thread-sidebar.ts";
import {
  CsvPreviewTable,
  parseCsvRows,
  TextPreviewLoader,
} from "./attachment-chips.tsx";
import {
  artifactPreviewUrlsMatch,
  publicAttachmentUrl,
} from "./attachment-url.ts";
import { lightboxDialogVisible$ } from "../../signals/okou-page/attachment-chips.ts";
import { MarkdownEventBody } from "../components/markdown.tsx";
import { jsonParseOr } from "../../signals/utils.ts";
import type { TextPreviewComputed } from "../../signals/text-preview.ts";
import type { MarkdownPreviewTreeComputed } from "../../signals/markdown-preview-tree.ts";
import { retryRichMarkdown$ } from "../../signals/rich-markdown-retry.ts";
import type { ZoomableImageCanvasSignals } from "../../signals/zoomable-image-canvas.ts";
import { ZoomableArtifactImageCanvas } from "./zoomable-image-canvas.tsx";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import {
  ArtifactActionSeparator,
  ArtifactActionTooltip,
  ArtifactDownloadMenu,
  ArtifactImageNavigationControls,
  ArtifactImageNavigationKeydown,
  ArtifactImageZoomControls,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
  type ArtifactImageNavigationActions,
} from "./artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactTitleSubtitle,
} from "./artifact-display.ts";
import {
  currentEventImageArtifactNavigation,
  equalEventImageGroups,
  type ImageArtifactNavigationItem,
} from "./artifact-image-navigation.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { PresentationArtifactViewport } from "./presentation-artifact-viewport.tsx";
import { OfficeDocumentPreview } from "./office-document-preview.tsx";
import { isOfficeFilePreview } from "./office-file-preview.ts";

// ---------------------------------------------------------------------------
// ArtifactSidebar — thread-owned pane for rendering kind-specific artifact
// previews inline, with a fullscreen toggle that swaps to a full-viewport
// layout.
// ---------------------------------------------------------------------------

const ARTIFACT_FULLSCREEN_SHELL_CLASSNAME =
  "fixed inset-0 flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";
const ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME = "z-[100]";

type ArtifactSidebarFullscreenState = {
  readonly active: boolean;
  readonly toggle: () => void;
};

type ArtifactSidebarProps = {
  readonly artifactRef: ArtifactRef;
  readonly fullscreenState: ArtifactSidebarFullscreenState;
  readonly markdownTree$?: MarkdownPreviewTreeComputed;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly onNavigateImage: (url: string) => void;
  readonly text$?: TextPreviewComputed;
  readonly thread: ChatPanelSignals;
};

type ArtifactSidebarItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

type ArtifactSidebarContentProps = {
  agentId?: string | null;
  artifactRef: ArtifactRef;
  fullscreenState: ArtifactSidebarFullscreenState;
  imageCanvasSignals: ZoomableImageCanvasSignals;
  imageNavigation?: ArtifactImageNavigationActions;
  item?: ArtifactSidebarItem;
  markdownTree$?: MarkdownPreviewTreeComputed;
  onBack?: () => void;
  onClose: () => void;
  onSyncSuccess: () => void;
  text$?: TextPreviewComputed;
  threadId?: string;
};

export function ArtifactSidebar({
  artifactRef,
  fullscreenState,
  markdownTree$: providedMarkdownTree$,
  onBack,
  onClose,
  onNavigateImage,
  text$: providedText$,
  thread,
}: ArtifactSidebarProps) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = thread.agentId;
  const eventGroups = useLastResolved(thread.eventImageGroups$, {
    equalityFn: equalEventImageGroups,
  });
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const text$ = providedText$ ?? artifactRef.text$;
  const markdownTree$ = providedMarkdownTree$ ?? artifactRef.markdownTree$;
  const item =
    loadable.state === "hasData"
      ? findArtifactItemForUrl(loadable.data, artifactRef.url)
      : undefined;
  const imageNavigation =
    loadable.state === "hasData"
      ? currentEventImageArtifactNavigation(
          loadable.data,
          eventGroups ?? [],
          artifactRef.url,
        )
      : {};
  const imageNavigationAction = (
    navigationItem: ImageArtifactNavigationItem | undefined,
  ) => {
    if (!navigationItem) {
      return undefined;
    }
    return () => {
      onNavigateImage(navigationItem.url);
    };
  };

  return (
    <ArtifactSidebarContent
      agentId={agentId}
      artifactRef={artifactRef}
      fullscreenState={fullscreenState}
      imageCanvasSignals={thread.sidebar.imageCanvas}
      imageNavigation={{
        onNext: imageNavigationAction(imageNavigation.next),
        onPrevious: imageNavigationAction(imageNavigation.previous),
      }}
      item={item}
      markdownTree$={markdownTree$}
      onBack={onBack}
      onClose={onClose}
      onSyncSuccess={() => {
        reloadArtifacts();
      }}
      text$={text$}
      threadId={thread.threadId}
    />
  );
}

function artifactSidebarSyncTargetForItem({
  agentId,
  item,
  onSyncSuccess,
  threadId,
}: {
  agentId?: string | null;
  item?: ArtifactSidebarItem;
  onSyncSuccess: () => void;
  threadId?: string;
}): ArtifactDownloadSyncTarget | undefined {
  return item && threadId
    ? artifactSidebarSyncTarget({
        agentId,
        item,
        onSyncSuccess,
        threadId,
      })
    : undefined;
}

function ArtifactSidebarContent({
  agentId,
  artifactRef,
  fullscreenState,
  imageCanvasSignals,
  imageNavigation,
  item,
  markdownTree$,
  onBack,
  onClose,
  onSyncSuccess,
  text$,
  threadId,
}: ArtifactSidebarContentProps) {
  useTranslation();
  const fullscreen = fullscreenState.active;
  const toggleFullscreen = fullscreenState.toggle;
  const resourceUrl = useLastResolved(artifactRef.resourceUrl$) ?? null;
  const shareUrl = useLastResolved(artifactRef.shareUrl$);
  const display = resolveArtifactDisplay(artifactRef, item);
  const syncTarget = artifactSidebarSyncTargetForItem({
    agentId,
    item,
    onSyncSuccess,
    threadId,
  });

  return (
    <ArtifactSidebarResolvedContent
      resourceUrl={resourceUrl}
      shareUrl={shareUrl}
      closePreview={onClose}
      display={display}
      fullscreen={fullscreen}
      imageCanvasSignals={imageCanvasSignals}
      imageNavigation={imageNavigation}
      markdownTree$={markdownTree$}
      onBack={onBack}
      syncTarget={syncTarget}
      text$={text$}
      toggleFullscreen={toggleFullscreen}
    />
  );
}

type ArtifactSidebarResolvedContentProps = {
  readonly resourceUrl: string | null;
  readonly shareUrl: string | null | undefined;
  readonly closePreview: () => void;
  readonly display: ArtifactDisplay;
  readonly fullscreen: boolean;
  readonly imageCanvasSignals: ZoomableImageCanvasSignals;
  readonly imageNavigation?: ArtifactImageNavigationActions;
  readonly markdownTree$?: MarkdownPreviewTreeComputed;
  readonly onBack?: () => void;
  readonly syncTarget?: ArtifactDownloadSyncTarget;
  readonly text$?: TextPreviewComputed;
  readonly toggleFullscreen: () => void;
};

function ArtifactSidebarResolvedContent({
  resourceUrl,
  shareUrl,
  closePreview,
  display,
  fullscreen,
  imageCanvasSignals,
  imageNavigation,
  markdownTree$,
  onBack,
  syncTarget,
  text$,
  toggleFullscreen,
}: ArtifactSidebarResolvedContentProps) {
  return (
    <ArtifactSidebarSurface fullscreen={fullscreen}>
      <ArtifactSidebarHeader
        shareUrl={shareUrl}
        title={display.filename}
        kind={display.kind}
        artifactKind={display.artifactKind}
        subtitle={display.subtitle}
        shareAvailable={display.shareAvailable}
        syncTarget={syncTarget}
        url={display.url}
        fullscreen={fullscreen}
        onBack={onBack}
        onToggleFullscreen={toggleFullscreen}
        onClose={closePreview}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <ArtifactBody
          resourceUrl={resourceUrl}
          shareUrl={shareUrl}
          url={display.url}
          kind={display.kind}
          filename={display.filename}
          artifactKind={display.artifactKind}
          imageNavigation={imageNavigation}
          imageCanvasSignals={imageCanvasSignals}
          fullscreen={fullscreen}
          markdownTree$={markdownTree$}
          text$={text$}
        />
      </div>
    </ArtifactSidebarSurface>
  );
}

function ArtifactSidebarSurface({
  children,
  fullscreen,
}: {
  children: ReactNode;
  fullscreen: boolean;
}) {
  return (
    <div
      className={cn(
        fullscreen
          ? cn(
              ARTIFACT_FULLSCREEN_SHELL_CLASSNAME,
              ARTIFACT_FULLSCREEN_DEFAULT_LAYER_CLASSNAME,
            )
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
      )}
      data-testid="artifact-sidebar"
    >
      {children}
    </div>
  );
}

interface ArtifactDisplay {
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  subtitle: string;
  shareAvailable: boolean;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
}

type ArtifactKindForBody =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

function findArtifactItemForUrl(
  runs: { runId: string; files: ChatThreadArtifactFile[] }[],
  url: string,
): ArtifactSidebarItem | undefined {
  for (const run of runs) {
    const file = run.files.find((candidate) => {
      return (
        artifactPreviewUrlsMatch(candidate.url, url) ||
        (candidate.aliasUrl !== undefined &&
          artifactPreviewUrlsMatch(candidate.aliasUrl, url))
      );
    });
    if (file) {
      return { runId: run.runId, file };
    }
  }
  return undefined;
}

function artifactSidebarSyncTarget(params: {
  agentId: string | null | undefined;
  item: ArtifactSidebarItem;
  onSyncSuccess: () => void;
  threadId: string;
}): ArtifactDownloadSyncTarget {
  return {
    accountReady:
      params.item.file.googleDriveSync?.status !== "disconnected" &&
      params.item.file.googleDriveSync?.accountReady === true,
    agentId: params.agentId,
    disconnected: params.item.file.googleDriveSync?.status === "disconnected",
    recovery:
      params.item.file.googleDriveSync?.status === "disconnected"
        ? params.item.file.googleDriveSync.recovery
        : undefined,
    fileId: params.item.file.id,
    filename: params.item.file.filename,
    onSyncSuccess: params.onSyncSuccess,
    runId: params.item.runId,
    synced: params.item.file.googleDriveSync?.status === "synced",
    threadId: params.threadId,
  };
}

function resolveArtifactDisplay(
  ref: ArtifactRef,
  item?: ArtifactSidebarItem,
): ArtifactDisplay {
  if (item) {
    return {
      url: ref.url,
      kind: ref.kind,
      filename: item.file.filename,
      subtitle: artifactTitleSubtitle(ref.kind, item.file),
      shareAvailable: ref.shareAvailable ?? true,
      artifactKind: item.file.artifactKind,
    };
  }
  return {
    url: ref.url,
    kind: ref.kind,
    filename: ref.filename,
    subtitle: artifactFallbackSubtitle(ref.kind, ref.filename),
    shareAvailable: ref.shareAvailable ?? true,
  };
}

function ArtifactSidebarHeader({
  shareUrl,
  title,
  kind,
  artifactKind,
  subtitle,
  shareAvailable,
  syncTarget,
  url,
  fullscreen,
  onBack,
  onToggleFullscreen,
  onClose,
}: {
  shareUrl?: string | null;
  title: string;
  kind?: ArtifactKindForBody;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  subtitle: string;
  shareAvailable: boolean;
  syncTarget?: ArtifactDownloadSyncTarget;
  url?: string;
  fullscreen: boolean;
  onBack?: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const compactActions = onBack !== undefined;

  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
      {onBack && (
        <ArtifactActionTooltip
          label={t(($) => {
            return $.artifacts.actions.backToAll;
          })}
        >
          <Button
            type="button"
            onClick={onBack}
            aria-label={t(($) => {
              return $.artifacts.actions.backToAll;
            })}
            variant="quiet"
            size="icon-sm"
            className="shrink-0"
          >
            <ArrowLeft size={16} />
          </Button>
        </ArtifactActionTooltip>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
      <ArtifactSidebarActions
        shareUrl={shareUrl}
        compactActions={compactActions}
        artifactKind={artifactKind}
        fullscreen={fullscreen}
        kind={kind}
        onClose={onClose}
        onToggleFullscreen={onToggleFullscreen}
        shareAvailable={shareAvailable}
        syncTarget={syncTarget}
        title={title}
        url={url}
      />
    </div>
  );
}

function ArtifactSidebarActions({
  shareUrl,
  artifactKind,
  compactActions,
  fullscreen,
  kind,
  onClose,
  onToggleFullscreen,
  shareAvailable,
  syncTarget,
  title,
  url,
}: {
  shareUrl?: string | null;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  compactActions: boolean;
  fullscreen: boolean;
  kind?: ArtifactKindForBody;
  onClose: () => void;
  onToggleFullscreen: () => void;
  shareAvailable: boolean;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {url && (
        <ArtifactSidebarPreviewActions
          shareUrl={shareUrl}
          artifactKind={artifactKind}
          kind={kind}
          shareAvailable={shareAvailable}
          syncTarget={syncTarget}
          title={title}
          url={url}
        />
      )}
      <ArtifactFullscreenAction
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      {compactActions ? (
        <ArtifactMoreActions onClose={onClose} />
      ) : (
        <ArtifactCloseAction onClose={onClose} />
      )}
    </div>
  );
}

function ArtifactSidebarPreviewActions({
  shareUrl,
  artifactKind,
  kind,
  shareAvailable,
  syncTarget,
  title,
  url,
}: {
  shareUrl?: string | null;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  kind?: ArtifactKindForBody;
  shareAvailable: boolean;
  syncTarget?: ArtifactDownloadSyncTarget;
  title: string;
  url: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      {kind === "html" && <ArtifactOpenExternalAction url={url} />}
      {shareAvailable && (
        <ArtifactShareButton
          shareUrl={shareUrl}
          ariaLabel={t(($) => {
            return $.artifacts.actions.shareArtifact;
          })}
          url={url}
        />
      )}
      <ArtifactDownloadMenu
        key={`${url}:${title}`}
        ariaLabel={t(($) => {
          return $.artifacts.actions.downloadArtifact;
        })}
        artifactKind={artifactKind}
        filename={title}
        syncTarget={syncTarget}
        url={url}
      />
      <ArtifactActionSeparator />
    </>
  );
}

function ArtifactOpenExternalAction({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <ArtifactActionTooltip
      label={t(($) => {
        return $.artifacts.actions.openNewTab;
      })}
    >
      <a
        href={publicAttachmentUrl(url)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t(($) => {
          return $.artifacts.actions.openNewTab;
        })}
        data-testid="artifact-sidebar-open-external"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
      >
        <ExternalLink size={16} />
      </a>
    </ArtifactActionTooltip>
  );
}

function ArtifactFullscreenAction({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { t } = useTranslation();
  const label = fullscreen
    ? t(($) => {
        return $.artifacts.actions.exitFullscreen;
      })
    : t(($) => {
        return $.artifacts.actions.enterFullscreen;
      });
  return (
    <ArtifactActionTooltip label={label}>
      <Button
        type="button"
        onClick={onToggleFullscreen}
        aria-label={label}
        data-testid="artifact-sidebar-fullscreen-toggle"
        variant="quiet"
        size="icon-sm"
        className="hidden xl:inline-flex"
      >
        {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </Button>
    </ArtifactActionTooltip>
  );
}

function ArtifactMoreActions({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <ArtifactActionTooltip
        label={t(($) => {
          return $.artifacts.actions.more;
        })}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            aria-label={t(($) => {
              return $.artifacts.actions.more;
            })}
            variant="quiet"
            size="icon-sm"
          >
            <Ellipsis size={16} />
          </Button>
        </DropdownMenuTrigger>
      </ArtifactActionTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onClose}>
          {t(($) => {
            return $.artifacts.actions.closePreviewMenu;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactCloseAction({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ArtifactActionTooltip
      label={t(($) => {
        return $.artifacts.actions.closeArtifact;
      })}
    >
      <Button
        type="button"
        onClick={onClose}
        aria-label={t(($) => {
          return $.artifacts.actions.closeArtifact;
        })}
        data-testid="artifact-sidebar-close"
        variant="quiet"
        size="icon-sm"
        className="rounded-full"
      >
        <X size={16} />
      </Button>
    </ArtifactActionTooltip>
  );
}

function ArtifactBody({
  resourceUrl,
  shareUrl,
  url,
  kind,
  filename,
  artifactKind,
  imageCanvasSignals,
  imageNavigation,
  fullscreen,
  markdownTree$,
  text$,
}: {
  resourceUrl: string | null;
  shareUrl: string | null | undefined;
  url: string;
  kind: ArtifactKindForBody;
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  imageCanvasSignals: ZoomableImageCanvasSignals;
  imageNavigation?: ArtifactImageNavigationActions;
  fullscreen: boolean;
  markdownTree$?: MarkdownPreviewTreeComputed;
  text$?: TextPreviewComputed;
}) {
  const { t } = useTranslation();
  if (kind === "markdown") {
    return markdownTree$ ? (
      <ArtifactMarkdownBody tree$={markdownTree$} />
    ) : (
      <ArtifactBodyError
        message={t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      />
    );
  }
  if (kind === "text" || kind === "json") {
    return text$ ? (
      <ArtifactPlainTextBody kind={kind} text$={text$} />
    ) : (
      <ArtifactBodyError
        message={t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      />
    );
  }
  if (kind === "csv") {
    return text$ ? (
      <ArtifactCsvBody text$={text$} />
    ) : (
      <ArtifactBodyError
        message={t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      />
    );
  }
  if (kind === "image") {
    return (
      <ArtifactImageBody
        resourceUrl={resourceUrl}
        fullscreen={fullscreen}
        imageCanvasSignals={imageCanvasSignals}
        imageNavigation={imageNavigation}
        url={url}
        filename={filename}
      />
    );
  }
  if (kind === "video") {
    return <ArtifactVideoBody resourceUrl={resourceUrl} filename={filename} />;
  }
  if (kind === "audio") {
    return <ArtifactAudioBody resourceUrl={resourceUrl} filename={filename} />;
  }
  if (kind === "html" || kind === "pdf") {
    return (
      <ArtifactIframeBody
        resourceUrl={resourceUrl}
        kind={kind}
        filename={filename}
        artifactKind={artifactKind}
        fullscreen={fullscreen}
      />
    );
  }
  if (isOfficeFilePreview(filename)) {
    return (
      <ArtifactOfficeDocumentBody
        resourceUrl={shareUrl === undefined ? null : (shareUrl ?? resourceUrl)}
        filename={filename}
        fullscreen={fullscreen}
        url={url}
      />
    );
  }
  return <ArtifactGenericBody filename={filename} />;
}

function ArtifactSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

function ArtifactBodyError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <span>{message}</span>
      {onRetry !== undefined && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => {
            return $.chat.errors.recovery.tryAgain;
          })}
        </Button>
      )}
    </div>
  );
}

function ArtifactStageShell({
  centered = false,
  children,
  flush = false,
  gap = false,
  scrollable = true,
}: {
  centered?: boolean;
  children: ReactNode;
  flush?: boolean;
  gap?: boolean;
  scrollable?: boolean;
}) {
  return (
    <div
      className={cn(
        "h-full min-h-0 bg-muted/30",
        flush ? "p-0" : "p-5",
        scrollable ? "overflow-auto" : "overflow-hidden",
      )}
      data-testid="artifact-sidebar-stage"
    >
      <div
        className={cn(
          "mx-auto flex w-full flex-col",
          flush ? "max-w-none" : "max-w-[900px]",
          scrollable ? "min-h-full" : "h-full min-h-0",
          centered && "items-center justify-center",
          gap && "gap-3",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ArtifactStageCard({
  children,
  fillHeight = false,
}: {
  children: ReactNode;
  fillHeight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-1 flex-col overflow-hidden",
        fillHeight
          ? "h-full min-h-0 bg-transparent"
          : "min-h-[420px] rounded-xl border border-border/70 bg-background shadow-sm",
      )}
    >
      {children}
    </div>
  );
}

function ArtifactMarkdownBody({
  tree$,
}: {
  tree$: MarkdownPreviewTreeComputed;
}) {
  const { t } = useTranslation();
  const retry = useSet(retryRichMarkdown$);
  const loadable = useLoadable(tree$);
  if (loadable.state === "loading") {
    return (
      <ArtifactStageShell>
        <ArtifactStageCard>
          <ArtifactSpinner />
        </ArtifactStageCard>
      </ArtifactStageShell>
    );
  }
  if (loadable.state === "hasError") {
    return (
      <ArtifactStageShell>
        <ArtifactStageCard>
          <ArtifactBodyError
            message={t(
              ($) => {
                return $.artifacts.preview.unavailable;
              },
              {
                kind: t(($) => {
                  return $.artifacts.kinds.markdown;
                }),
              },
            )}
            onRetry={retry}
          />
        </ArtifactStageCard>
      </ArtifactStageShell>
    );
  }
  return (
    <ArtifactStageShell>
      <ArtifactStageCard>
        <div className="h-full overflow-auto p-6">
          <MarkdownEventBody tree={loadable.data} mediaPreview={false} />
        </div>
      </ArtifactStageCard>
    </ArtifactStageShell>
  );
}

function ArtifactPlainTextBody({
  kind,
  text$,
}: {
  kind: "text" | "json";
  text$: TextPreviewComputed;
}) {
  const { t } = useTranslation();
  return (
    <TextPreviewLoader text$={text$}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactSpinner />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        if (status === "error") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError
                  message={
                    kind === "json"
                      ? t(
                          ($) => {
                            return $.artifacts.preview.unavailable;
                          },
                          {
                            kind: t(($) => {
                              return $.artifacts.kinds.json;
                            }),
                          },
                        )
                      : t(
                          ($) => {
                            return $.artifacts.preview.unavailable;
                          },
                          {
                            kind: t(($) => {
                              return $.artifacts.kinds.text;
                            }),
                          },
                        )
                  }
                />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        const formatted = formatBodyText(kind, text);
        return (
          <ArtifactStageShell>
            <ArtifactStageCard>
              <pre
                className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground"
                data-testid={`artifact-sidebar-body-${kind}`}
              >
                {formatted}
              </pre>
            </ArtifactStageCard>
          </ArtifactStageShell>
        );
      }}
    </TextPreviewLoader>
  );
}

function formatBodyText(kind: "text" | "json", text: string): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

function ArtifactCsvBody({ text$ }: { text$: TextPreviewComputed }) {
  const { t } = useTranslation();
  return (
    <TextPreviewLoader text$={text$}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactSpinner />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        if (status === "error") {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError
                  message={t(
                    ($) => {
                      return $.artifacts.preview.unavailable;
                    },
                    {
                      kind: t(($) => {
                        return $.artifacts.kinds.csv;
                      }),
                    },
                  )}
                />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        const rows = parseCsvRows(text);
        if (rows.length === 0) {
          return (
            <ArtifactStageShell>
              <ArtifactStageCard>
                <ArtifactBodyError
                  message={t(($) => {
                    return $.artifacts.preview.emptyCsv;
                  })}
                />
              </ArtifactStageCard>
            </ArtifactStageShell>
          );
        }
        return (
          <ArtifactStageShell>
            <ArtifactStageCard>
              <div className="h-full overflow-auto p-5">
                <CsvPreviewTable rows={rows} />
              </div>
            </ArtifactStageCard>
          </ArtifactStageShell>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactImageBody({
  resourceUrl,
  fullscreen,
  imageCanvasSignals,
  imageNavigation,
  url,
  filename,
}: {
  resourceUrl: string | null;
  fullscreen: boolean;
  imageCanvasSignals: ZoomableImageCanvasSignals;
  imageNavigation?: ArtifactImageNavigationActions;
  url: string;
  filename: string;
}) {
  const modalOpen = useGet(lightboxDialogVisible$);

  if (resourceUrl === null) {
    return <ArtifactSpinner />;
  }

  return (
    <ArtifactStageShell flush scrollable={false}>
      <ArtifactStageCard fillHeight>
        <div className="relative h-full min-h-0">
          {/*
            The lightbox modal owns arrow keys while open. Focus only matters in
            the non-fullscreen sidebar, where the composer stays reachable.
          */}
          <ArtifactImageNavigationKeydown
            considerFocus={!fullscreen}
            enabled={!modalOpen}
            navigation={imageNavigation}
          />
          <ZoomableArtifactImageCanvas
            key={`${fullscreen ? "fullscreen" : "sidebar"}:${url}`}
            src={resourceUrl}
            alt={filename}
            signals={imageCanvasSignals}
            imageTestId="artifact-sidebar-body-image"
            contentClassName="p-6"
            pendingContent={<ArtifactSpinner />}
          >
            {(controls) => {
              return (
                <ArtifactImageZoomControls
                  controls={controls}
                  testIdPrefix="artifact-sidebar"
                />
              );
            }}
          </ZoomableArtifactImageCanvas>
          <ArtifactImageNavigationControls
            navigation={imageNavigation}
            testIdPrefix="artifact-sidebar"
          />
        </div>
      </ArtifactStageCard>
    </ArtifactStageShell>
  );
}

function ArtifactVideoBody({
  resourceUrl,
  filename,
}: {
  resourceUrl: string | null;
  filename: string;
}) {
  const { t } = useTranslation();
  return (
    <ArtifactStageShell centered>
      <div
        className="w-full overflow-hidden rounded-xl border border-border/70 bg-black shadow-sm"
        data-testid="artifact-sidebar-video-stage"
      >
        {resourceUrl !== null && (
          <video
            src={resourceUrl}
            controls
            playsInline
            className="block aspect-video w-full bg-black object-contain"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.videoLabel;
              },
              { filename },
            )}
            data-testid="artifact-sidebar-body-video"
          />
        )}
      </div>
    </ArtifactStageShell>
  );
}

function ArtifactAudioBody({
  resourceUrl,
  filename,
}: {
  resourceUrl: string | null;
  filename: string;
}) {
  const { t } = useTranslation();
  return (
    <ArtifactStageShell centered>
      <div className="flex w-full max-w-[520px] flex-col items-center gap-4 rounded-xl border border-border/70 bg-background p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">{filename}</p>
        {resourceUrl !== null && (
          <audio
            src={resourceUrl}
            controls
            preload="metadata"
            className="w-full"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.audioLabel;
              },
              { filename },
            )}
            data-testid="artifact-sidebar-body-audio"
          />
        )}
      </div>
    </ArtifactStageShell>
  );
}

function ArtifactIframeBody({
  resourceUrl,
  kind,
  filename,
  artifactKind,
  fullscreen,
}: {
  resourceUrl: string | null;
  kind: "html" | "pdf";
  filename: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  fullscreen: boolean;
}) {
  const { t } = useTranslation();
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail
  // (thumbnails / bookmarks) so the embedded preview shows just the page
  // and toolbar by default. Firefox/PDF.js silently ignores it.
  const src =
    resourceUrl !== null && kind === "pdf"
      ? `${resourceUrl}#navpanes=0`
      : resourceUrl;
  const isPresentationHtml =
    kind === "html" && artifactKind === "presentation-html";
  if (resourceUrl === null || src === null) {
    return <ArtifactSpinner />;
  }
  if (kind === "html") {
    const frame = (
      <AutoFocusedArtifactIframe
        focusKey={`${resourceUrl}:${fullscreen ? "fullscreen" : "sidebar"}`}
        focusOnMount={fullscreen && !isPresentationHtml}
        src={resourceUrl}
        title={t(
          ($) => {
            return $.artifacts.preview.dialogLabel;
          },
          { filename },
        )}
        sandbox="allow-same-origin allow-scripts"
        tabIndex={isPresentationHtml ? -1 : undefined}
        className="h-full w-full border-0 bg-background"
        data-testid={`artifact-sidebar-body-${kind}`}
      />
    );

    return (
      <div className="h-full w-full">
        {isPresentationHtml ? (
          <PresentationArtifactViewport>{frame}</PresentationArtifactViewport>
        ) : (
          frame
        )}
      </div>
    );
  }

  return (
    <ArtifactStageShell scrollable={false}>
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
        <iframe
          src={src}
          title={t(
            ($) => {
              return $.artifacts.preview.dialogLabel;
            },
            { filename },
          )}
          className="h-full min-h-0 w-full border-0 bg-background"
          data-testid={`artifact-sidebar-body-${kind}`}
        />
      </div>
    </ArtifactStageShell>
  );
}

function ArtifactOfficeDocumentBody({
  resourceUrl,
  filename,
  fullscreen,
  url,
}: {
  resourceUrl: string | null;
  filename: string;
  fullscreen: boolean;
  url: string;
}) {
  return (
    <ArtifactStageShell scrollable={false}>
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
        <OfficeDocumentPreview
          resourceUrl={resourceUrl}
          filename={filename}
          focusKey={`${url}:${fullscreen ? "fullscreen" : "sidebar"}`}
          focusOnMount={fullscreen}
          testId="artifact-sidebar-body-office"
        />
      </div>
    </ArtifactStageShell>
  );
}

function ArtifactGenericBody({ filename }: { filename: string }) {
  const { t } = useTranslation();
  return (
    <ArtifactStageShell centered>
      <div className="flex w-full max-w-md flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-background p-6 text-center text-muted-foreground shadow-sm">
        <p className="text-sm">
          {t(($) => {
            return $.artifacts.preview.noInline;
          })}
        </p>
        <p className="text-xs">{filename}</p>
      </div>
    </ArtifactStageShell>
  );
}
