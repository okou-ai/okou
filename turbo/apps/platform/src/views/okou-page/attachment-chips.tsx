import type { ReactNode } from "react";
import { Button, Dialog, DialogBody, DialogContent } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  FileMusic,
  Image,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatAttachment } from "../../signals/okou-page/chat-draft";
import type { AttachmentPreviewSignals } from "../../signals/attachment-resource-url.ts";
import { canonicalUserMessageFileUrl } from "../../signals/chat-page/user-message-files.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  connectorConnectionProgressActive$,
  dismissConnectorConnectionProgress$,
  registerConnectorConnectionDialog$,
} from "../../signals/connector-connection-progress.ts";
import { ConnectorConnectionStatus } from "../components/connector-connection-dialog-body.tsx";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import {
  detach,
  jsonParseOr,
  Reason,
  withCleanup,
} from "../../signals/utils.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import type { TextPreviewComputed } from "../../signals/text-preview.ts";
import type { MarkdownPreviewTreeComputed } from "../../signals/markdown-preview-tree.ts";
import { retryRichMarkdown$ } from "../../signals/rich-markdown-retry.ts";
import { MarkdownEventBody } from "../components/markdown.tsx";
import {
  attachmentSidebarRef,
  attachmentLightboxImageCanvasSignals,
  lightboxUrl$,
  closeLightboxImmediately$,
  closeLightboxWithDialogExit$,
  lightboxDialogFullscreen$,
  lightboxDialogVisible$,
  lightboxDialogMountRef$,
  completeLightboxDialogExit$,
  lightboxDialogElement$,
  navigateImageLightbox$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openFileLightbox$,
  openImageLightbox$,
  toggleLightboxDialogFullscreen$,
  type AttachmentArtifactMetadata,
  type AttachmentLightboxState,
} from "../../signals/okou-page/attachment-chips.ts";
import { openThreadArtifactSplitView$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { closeArtifactCatalogPreview$ } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import {
  artifactPreviewUrlsMatch,
  attachmentFilenameFromUrl,
} from "./attachment-url.ts";
import { AnnotationMarkLayer } from "./image-annotation-marks.tsx";
import {
  annotationMarkCount,
  DEFAULT_ANNOTATION_INK,
  type ImageAnnotationSignals,
} from "../../signals/okou-page/image-annotation.ts";
import { composerImageAnnotationEnabled$ } from "../../signals/external/feature-switch.ts";
import {
  ArtifactActionSeparator,
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
import { ZoomableArtifactImageCanvas } from "./zoomable-image-canvas.tsx";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { PresentationArtifactViewport } from "./presentation-artifact-viewport.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { OfficeDocumentPreview } from "./office-document-preview.tsx";
import { isOfficeFilePreview } from "./office-file-preview.ts";

type TextPreviewLoadState = {
  readonly status: "loading" | "loaded" | "error";
  readonly text: string;
};

type DocumentAttachmentPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf";

function contentTypeForDocumentAttachmentPreviewKind(
  kind: DocumentAttachmentPreviewKind,
): string {
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "html") {
    return "text/html";
  }
  return "application/pdf";
}

// ---------------------------------------------------------------------------
// AttachmentLightbox — full-screen attachment viewer
// ---------------------------------------------------------------------------

export function TextPreviewLoader({
  text$,
  children,
}: {
  text$: TextPreviewComputed;
  children: (state: TextPreviewLoadState) => ReactNode;
}) {
  const loadable = useLoadable(text$);
  if (loadable.state === "hasData") {
    return children({ status: "loaded", text: loadable.data });
  }
  if (loadable.state === "hasError") {
    return children({ status: "error", text: "" });
  }
  return children({ status: "loading", text: "" });
}

function formatPlainPreviewText(
  kind: "text" | "json" | "csv",
  text: string,
): string {
  if (kind === "json") {
    const parsed = jsonParseOr<unknown>(text, null);
    return parsed === null ? text : JSON.stringify(parsed, null, 2);
  }
  return text;
}

export function parseCsvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      return line.trimEnd();
    })
    .filter((line) => {
      return line.length > 0;
    })
    .map((line) => {
      return line.split(",").map((cell) => {
        return cell.trim();
      });
    });
}

export function CsvPreviewTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows;

  return (
    <div className="overflow-auto rounded-lg border border-foreground/10">
      <table className="min-w-full divide-y divide-foreground/10 text-sm">
        <thead className="bg-muted/40">
          <tr>
            {header.map((cell) => {
              return (
                <th
                  key={`header-${cell}`}
                  className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground"
                >
                  {cell}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-foreground/10 bg-background">
          {body.map((row) => {
            const rowKey = `row-${row.join("\u0001")}`;
            return (
              <tr key={rowKey}>
                {header.map((column, cellIndex) => {
                  const value = row[cellIndex] ?? "";
                  return (
                    <td
                      key={`${rowKey}-${column}-${value}`}
                      className="whitespace-nowrap px-3 py-2 text-foreground"
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DialogIconButton({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      showTooltip
      type="button"
      onClick={onClick}
      variant="quiet"
      size="icon-sm"
      className="shrink-0"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {children}
    </Button>
  );
}

function ArtifactDialogSplitViewButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogIconButton
      ariaLabel={t(($) => {
        return $.artifacts.actions.openSplitView;
      })}
      onClick={onClick}
    >
      <Columns2 size={18} />
    </DialogIconButton>
  );
}

function ArtifactDialogFullscreenButton({
  fullscreen,
  onClick,
}: {
  fullscreen: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogIconButton
      ariaLabel={
        fullscreen
          ? t(($) => {
              return $.artifacts.actions.exitFullscreen;
            })
          : t(($) => {
              return $.artifacts.actions.enterFullscreen;
            })
      }
      onClick={onClick}
    >
      {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
    </DialogIconButton>
  );
}

function artifactDialogFilename(preview: AttachmentLightboxState): string {
  return "filename" in preview && preview.filename
    ? preview.filename
    : attachmentFilenameFromUrl(preview.url);
}

type ArtifactDialogItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

function artifactDialogKindLabel(
  preview: AttachmentLightboxState,
  artifact: AttachmentArtifactMetadata | undefined,
): string {
  if (artifact) {
    return artifactTitleSubtitle(preview.kind, artifact, {
      showSize: preview.showSizeInSubtitle ?? true,
    });
  }
  return artifactFallbackSubtitle(
    preview.kind,
    artifactDialogFilename(preview),
  );
}

function artifactDialogSyncTarget(
  artifact: AttachmentArtifactMetadata | undefined,
): ArtifactDownloadSyncTarget | undefined {
  if (!artifact) {
    return undefined;
  }
  return {
    accountReady: artifact.googleDriveAccountReady,
    agentId: artifact.agentId,
    disconnected: artifact.googleDriveDisconnected,
    recovery: artifact.googleDriveRecovery,
    fileId: artifact.fileId,
    filename: artifact.filename,
    onSyncSuccess:
      artifact.onSyncSuccess ??
      (() => {
        return undefined;
      }),
    runId: artifact.runId,
    synced: artifact.googleDriveSynced,
    threadId: artifact.threadId,
  };
}

function findArtifactDialogItemForUrl(
  runs: ChatThreadArtifactRun[],
  url: string,
): ArtifactDialogItem | undefined {
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

function artifactDialogMetadataFromItem(params: {
  agentId: string | null | undefined;
  item: ArtifactDialogItem;
  onSyncSuccess: () => void;
  threadId: string;
}): AttachmentArtifactMetadata {
  return {
    agentId: params.agentId,
    artifactKind: params.item.file.artifactKind,
    contentType: params.item.file.contentType,
    createdAt: params.item.file.createdAt,
    fileId: params.item.file.id,
    filename: params.item.file.filename,
    googleDriveAccountReady:
      params.item.file.googleDriveSync?.status !== "disconnected" &&
      params.item.file.googleDriveSync?.accountReady === true,
    googleDriveDisconnected:
      params.item.file.googleDriveSync?.status === "disconnected",
    googleDriveRecovery:
      params.item.file.googleDriveSync?.status === "disconnected"
        ? params.item.file.googleDriveSync.recovery
        : undefined,
    googleDriveSynced: params.item.file.googleDriveSync?.status === "synced",
    onSyncSuccess: params.onSyncSuccess,
    runId: params.item.runId,
    size: params.item.file.size,
    threadId: params.threadId,
  };
}

function ArtifactDialogLoadingBody() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

function ArtifactDialogUnavailableBody({
  label,
  onRetry,
}: {
  label: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <span>
        {t(
          ($) => {
            return $.artifacts.preview.unavailable;
          },
          { kind: label },
        )}
      </span>
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

function ArtifactDialogStage({
  children,
  centered = false,
  flush = false,
  gap = false,
  scrollable = true,
}: {
  children: ReactNode;
  centered?: boolean;
  flush?: boolean;
  gap?: boolean;
  scrollable?: boolean;
}) {
  return (
    <div
      className={`h-full min-h-0 bg-muted/30 ${flush ? "p-0" : "p-5"} ${
        scrollable ? "overflow-auto" : "overflow-hidden"
      }`}
      data-testid="artifact-dialog-stage"
    >
      <div
        className={`mx-auto flex w-full flex-col ${
          flush ? "max-w-none" : "max-w-[900px]"
        } ${scrollable ? "min-h-full" : "h-full min-h-0"} ${
          centered ? "items-center justify-center" : ""
        } ${gap ? "gap-3" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

function ArtifactDialogCard({
  children,
  fillHeight = false,
}: {
  children: ReactNode;
  fillHeight?: boolean;
}) {
  return (
    <div
      className={`flex w-full flex-1 flex-col overflow-hidden ${
        fillHeight
          ? "h-full min-h-0 bg-transparent"
          : "okou-chat-card min-h-[420px]"
      }`}
      data-testid="artifact-dialog-card"
    >
      {children}
    </div>
  );
}

function ArtifactDialogMarkdownBody({
  tree$,
}: {
  tree$: MarkdownPreviewTreeComputed;
}) {
  const { t } = useTranslation();
  const retry = useSet(retryRichMarkdown$);
  const loadable = useLoadable(tree$);
  if (loadable.state === "loading") {
    return (
      <ArtifactDialogStage>
        <ArtifactDialogCard>
          <ArtifactDialogLoadingBody />
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }
  if (loadable.state === "hasError") {
    return (
      <ArtifactDialogStage>
        <ArtifactDialogCard>
          <ArtifactDialogUnavailableBody
            label={t(($) => {
              return $.artifacts.kinds.markdown;
            })}
            onRetry={retry}
          />
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }
  return (
    <ArtifactDialogStage>
      <ArtifactDialogCard>
        <div className="h-full overflow-auto p-6">
          <MarkdownEventBody tree={loadable.data} mediaPreview={false} />
        </div>
      </ArtifactDialogCard>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogTextBody({
  kind,
  text$,
}: {
  kind: "text" | "json" | "csv";
  text$: TextPreviewComputed;
}) {
  const { t } = useTranslation();
  const kindLabel =
    kind === "json"
      ? t(($) => {
          return $.artifacts.kinds.json;
        })
      : kind === "csv"
        ? t(($) => {
            return $.artifacts.kinds.csv;
          })
        : t(($) => {
            return $.artifacts.kinds.text;
          });
  return (
    <TextPreviewLoader text$={text$}>
      {({ status, text }) => {
        if (status === "loading") {
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <ArtifactDialogLoadingBody />
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        if (status === "error") {
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <ArtifactDialogUnavailableBody label={kindLabel} />
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        if (kind === "csv") {
          const rows = parseCsvRows(text);
          return (
            <ArtifactDialogStage>
              <ArtifactDialogCard>
                <div className="h-full overflow-auto p-5">
                  {rows.length > 0 ? (
                    <CsvPreviewTable rows={rows} />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {t(
                        ($) => {
                          return $.artifacts.preview.unavailable;
                        },
                        {
                          kind: kindLabel,
                        },
                      )}
                    </div>
                  )}
                </div>
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }

        const formatted = formatPlainPreviewText(kind, text);
        const display =
          formatted.length > 16_000
            ? `${formatted.slice(0, 16_000)}\n\n…`
            : formatted;

        return (
          <ArtifactDialogStage>
            <ArtifactDialogCard>
              <pre className="m-0 h-full overflow-auto whitespace-pre-wrap break-words p-6 text-sm text-foreground">
                {display}
              </pre>
            </ArtifactDialogCard>
          </ArtifactDialogStage>
        );
      }}
    </TextPreviewLoader>
  );
}

function ArtifactDialogImageStage({
  filename,
  imageNavigation,
  preview,
  resourceUrl,
}: {
  filename: string;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: Extract<AttachmentLightboxState, { kind: "image" }>;
  resourceUrl: string | null;
}) {
  const { t } = useTranslation();
  // Marks live on the draft rather than in the file, so the viewer has to draw
  // them too — otherwise reopening an annotated image shows a clean picture.
  const annotation = preview.annotationTarget?.annotations ?? null;

  return (
    <ArtifactDialogStage flush scrollable={false}>
      <ArtifactDialogCard fillHeight>
        <div className="relative h-full min-h-0">
          {resourceUrl === null ? (
            <div
              role="status"
              aria-label={t(($) => {
                return $.artifacts.catalog.loading;
              })}
              className="flex h-full items-center justify-center text-muted-foreground"
            >
              <Loader2 className="animate-spin" aria-hidden />
            </div>
          ) : (
            <ZoomableArtifactImageCanvas
              key={resourceUrl}
              src={resourceUrl}
              alt={filename}
              signals={attachmentLightboxImageCanvasSignals}
              imageTestId="attachment-lightbox-image"
              contentClassName="p-6"
              imageClassName="rounded-lg shadow-sm"
              canvasTestId="artifact-dialog-image-stage"
              pendingContent={
                <div
                  role="status"
                  aria-label={t(($) => {
                    return $.artifacts.catalog.loading;
                  })}
                >
                  <Loader2 className="animate-spin" aria-hidden />
                </div>
              }
              overlay={
                annotation ? (
                  <AnnotationMarkLayer annotation={annotation} />
                ) : undefined
              }
            >
              {(controls) => {
                return (
                  <ArtifactImageZoomControls
                    controls={controls}
                    nativeTitle
                    testIdPrefix="artifact-dialog"
                  />
                );
              }}
            </ZoomableArtifactImageCanvas>
          )}
          <ArtifactImageNavigationControls
            navigation={imageNavigation}
            testIdPrefix="artifact-dialog"
          />
        </div>
      </ArtifactDialogCard>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogImageBody({
  filename,
  imageNavigation,
  preview,
}: {
  filename: string;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: Extract<AttachmentLightboxState, { kind: "image" }>;
}) {
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;
  return (
    <ArtifactDialogImageStage
      filename={filename}
      imageNavigation={imageNavigation}
      preview={preview}
      resourceUrl={resourceUrl}
    />
  );
}

function ArtifactDialogVideoBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;

  return (
    <ArtifactDialogStage centered>
      <div
        className="okou-chat-frame w-full overflow-hidden bg-black"
        data-testid="artifact-dialog-video-stage"
      >
        {resourceUrl !== null && (
          <video
            src={resourceUrl}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="block aspect-video w-full bg-black object-contain"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.videoLabel;
              },
              { filename },
            )}
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogAudioBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;

  return (
    <ArtifactDialogStage centered>
      <div className="okou-chat-card flex w-full max-w-[520px] flex-col items-center gap-4 p-6">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/50 text-muted-foreground">
          <FileMusic size={28} />
        </span>
        <p className="max-w-full truncate text-sm text-muted-foreground">
          {filename}
        </p>
        {resourceUrl !== null && (
          <audio
            src={resourceUrl}
            controls
            autoPlay
            preload="metadata"
            className="w-full"
            aria-label={t(
              ($) => {
                return $.artifacts.preview.audioLabel;
              },
              { filename },
            )}
            data-testid="artifact-dialog-audio"
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogDocumentFrameBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail so the
  // embedded preview shows just the page and toolbar by default.
  const src =
    resourceUrl !== null && preview.kind === "pdf"
      ? `${resourceUrl}#navpanes=0`
      : resourceUrl;

  return (
    <ArtifactDialogStage scrollable={false}>
      <div
        className="okou-chat-card flex h-full min-h-0 w-full flex-1 overflow-hidden"
        data-testid="artifact-dialog-document-frame"
      >
        {src !== null && (
          <iframe
            src={src}
            title={t(
              ($) => {
                return $.artifacts.preview.dialogLabel;
              },
              { filename },
            )}
            scrolling="yes"
            className="block h-full min-h-0 w-full border-0 bg-background"
          />
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogGenericFileBody({ filename }: { filename: string }) {
  const { t } = useTranslation();
  return (
    <ArtifactDialogStage centered>
      <div className="okou-chat-card flex w-full max-w-md flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
        <p className="text-sm">
          {t(($) => {
            return $.artifacts.preview.noInline;
          })}
        </p>
        <p className="text-xs">{filename}</p>
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogOfficeDocumentBody({
  filename,
  preview,
}: {
  filename: string;
  preview: Extract<AttachmentLightboxState, { kind: "file" }>;
}) {
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;
  const shareUrl = useLastResolved(preview.shareUrl$);
  return (
    <ArtifactDialogStage scrollable={false}>
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
        <OfficeDocumentPreview
          resourceUrl={
            shareUrl === undefined ? null : (shareUrl ?? resourceUrl)
          }
          filename={filename}
          focusKey={`${preview.url}:dialog`}
          focusOnMount={false}
          testId="artifact-dialog-body-office"
        />
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogBody({
  artifact,
  imageNavigation,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
}) {
  const filename = artifactDialogFilename(preview);

  if (preview.kind === "image") {
    return (
      <ArtifactDialogImageBody
        filename={filename}
        imageNavigation={imageNavigation}
        preview={preview}
      />
    );
  }

  if (preview.kind === "video") {
    return <ArtifactDialogVideoBody filename={filename} preview={preview} />;
  }

  if (preview.kind === "audio") {
    return <ArtifactDialogAudioBody filename={filename} preview={preview} />;
  }

  if (preview.kind === "file") {
    if (isOfficeFilePreview(filename)) {
      return (
        <ArtifactDialogOfficeDocumentBody
          filename={filename}
          preview={preview}
        />
      );
    }
    return <ArtifactDialogGenericFileBody filename={filename} />;
  }

  if (preview.kind === "markdown") {
    return <ArtifactDialogMarkdownBody tree$={preview.markdownTree$} />;
  }
  if (
    preview.kind === "text" ||
    preview.kind === "json" ||
    preview.kind === "csv"
  ) {
    return <ArtifactDialogTextBody kind={preview.kind} text$={preview.text$} />;
  }

  if (preview.kind === "html") {
    return (
      <ArtifactDialogHtmlBody
        artifact={artifact}
        filename={filename}
        preview={preview}
      />
    );
  }

  return (
    <ArtifactDialogDocumentFrameBody filename={filename} preview={preview} />
  );
}

function ArtifactDialogHtmlBody({
  artifact,
  filename,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const fullscreen = useGet(lightboxDialogFullscreen$);
  const src = useLastResolved(preview.resourceUrl$) ?? null;
  const isPresentationHtml = artifact?.artifactKind === "presentation-html";

  if (src === null) {
    return (
      <div
        className="h-full w-full bg-background"
        data-testid="artifact-dialog-site-frame"
      />
    );
  }

  const frame = (
    <AutoFocusedArtifactIframe
      focusKey={`${preview.url}:${fullscreen ? "fullscreen" : "dialog"}`}
      focusOnMount={!isPresentationHtml}
      src={src}
      title={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      sandbox="allow-same-origin allow-scripts"
      tabIndex={isPresentationHtml ? -1 : undefined}
      scrolling="yes"
      className="block h-full w-full border-0 bg-background"
      data-testid="artifact-dialog-body-html"
    />
  );

  return (
    <div
      className="h-full w-full bg-background"
      data-testid="artifact-dialog-site-frame"
    >
      {isPresentationHtml ? (
        <PresentationArtifactViewport>{frame}</PresentationArtifactViewport>
      ) : (
        frame
      )}
    </div>
  );
}

function ArtifactPreviewDialog({
  preview,
}: {
  preview: AttachmentLightboxState;
}) {
  const leftThread = useLastResolved(currentLeftThread$);
  const rightThread = useLastResolved(currentRightThread$);
  const previewThreadId =
    (preview.kind === "image" ? preview.threadId : undefined) ??
    preview.artifact?.threadId;
  const previewThread =
    leftThread?.threadId === previewThreadId
      ? leftThread
      : rightThread?.threadId === previewThreadId
        ? rightThread
        : undefined;

  if (previewThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={previewThread}
      />
    );
  }

  if (previewThreadId) {
    return (
      <ArtifactPreviewDialogContent
        artifact={preview.artifact}
        preview={preview}
      />
    );
  }

  if (leftThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={leftThread}
        fallbackThread={
          rightThread && rightThread.threadId !== leftThread.threadId
            ? rightThread
            : undefined
        }
      />
    );
  }

  if (rightThread) {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={rightThread}
      />
    );
  }

  return (
    <ArtifactPreviewDialogContent
      artifact={preview.artifact}
      preview={preview}
    />
  );
}

function ArtifactPreviewDialogThreadResolver({
  fallbackThread,
  preview,
  thread,
}: {
  fallbackThread?: ChatPanelSignals;
  preview: AttachmentLightboxState;
  thread: ChatPanelSignals;
}) {
  const loadable = useLastLoadable(thread.artifacts$);
  const agentId = thread.agentId;
  const eventGroups = useLastResolved(thread.eventImageGroups$, {
    equalityFn: equalEventImageGroups,
  });
  const navigateImageLightbox = useSet(navigateImageLightbox$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const item =
    loadable.state === "hasData"
      ? findArtifactDialogItemForUrl(loadable.data, preview.url)
      : undefined;
  const resolvedImageNavigation =
    preview.kind === "image"
      ? currentEventImageArtifactNavigation(
          loadable.state === "hasData" ? loadable.data : [],
          eventGroups ?? [],
          preview.url,
        )
      : {};
  const imageNavigation =
    resolvedImageNavigation.role === "assistant" || loadable.state === "hasData"
      ? resolvedImageNavigation
      : {};
  const openImageNavigationItem = (
    navigationItem: ImageArtifactNavigationItem,
  ) => {
    navigateImageLightbox({
      artifact: navigationItem.artifact
        ? artifactDialogMetadataFromItem({
            agentId,
            item: navigationItem.artifact,
            onSyncSuccess: () => {
              reloadArtifacts();
            },
            threadId: thread.threadId,
          })
        : undefined,
      filename: navigationItem.filename,
      preview: navigationItem.preview,
      threadId: thread.threadId,
      url: navigationItem.url,
    });
  };
  const imageNavigationAction = (
    navigationItem: ImageArtifactNavigationItem | undefined,
  ) => {
    if (!navigationItem) {
      return undefined;
    }
    return () => {
      openImageNavigationItem(navigationItem);
    };
  };

  if (item) {
    return (
      <ArtifactPreviewDialogContent
        artifact={artifactDialogMetadataFromItem({
          agentId,
          item,
          onSyncSuccess: () => {
            reloadArtifacts();
          },
          threadId: thread.threadId,
        })}
        imageNavigation={{
          onNext: imageNavigationAction(imageNavigation.next),
          onPrevious: imageNavigationAction(imageNavigation.previous),
        }}
        preview={preview}
      />
    );
  }

  if (fallbackThread && loadable.state === "hasData") {
    return (
      <ArtifactPreviewDialogThreadResolver
        preview={preview}
        thread={fallbackThread}
      />
    );
  }

  // The previewed image is not a run artifact (e.g. a human-uploaded image that
  // resolves from the user artifacts bucket). It still navigates among the other
  // images in its message.
  return (
    <ArtifactPreviewDialogContent
      artifact={preview.artifact}
      imageNavigation={{
        onNext: imageNavigationAction(imageNavigation.next),
        onPrevious: imageNavigationAction(imageNavigation.previous),
      }}
      preview={preview}
    />
  );
}

function useCloseArtifactPreview() {
  const rootSignal = useGet(rootSignal$);
  const closeArtifactCatalogPreview = useSet(closeArtifactCatalogPreview$);
  const dismissProgress = useSet(dismissConnectorConnectionProgress$);
  return () => {
    dismissProgress();
    closeArtifactCatalogPreview(rootSignal);
  };
}

function ArtifactPreviewCloseButton() {
  const { t } = useTranslation();
  const close = useCloseArtifactPreview();
  return (
    <DialogIconButton
      ariaLabel={t(($) => {
        return $.artifacts.actions.close;
      })}
      onClick={close}
    >
      <X size={18} />
    </DialogIconButton>
  );
}

function ArtifactPreviewDialogActions({
  artifact,
  fullscreen,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  fullscreen: boolean;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const closeLightboxWithDialogExit = useSet(closeLightboxWithDialogExit$);
  const openArtifactSidebarPreview = useSet(openThreadArtifactSplitView$);
  const toggleLightboxDialogFullscreen = useSet(
    toggleLightboxDialogFullscreen$,
  );
  const shareUrl = useLastResolved(preview.shareUrl$);
  const showShare = preview.shareAvailable !== false;
  const showSplitView = preview.splitViewAvailable !== false;
  const closeLightboxImmediately = useSet(closeLightboxImmediately$);
  const annotationTarget =
    preview.kind === "image" ? preview.annotationTarget : undefined;
  const openInSplitView = () => {
    openArtifactSidebarPreview(attachmentSidebarRef(preview));
    closeLightboxWithDialogExit(rootSignal);
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      {annotationTarget && (
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          data-testid="artifact-dialog-annotate"
          aria-label={t(($) => {
            return $.artifacts.annotation.open;
          })}
          title={t(($) => {
            return $.artifacts.annotation.open;
          })}
          onClick={() => {
            // The editor owns the whole surface while it is open, so the
            // read-only viewer steps aside — instantly, or the two dialogs
            // cross-fade and the modal appears to jump.
            annotationTarget.open();
            closeLightboxImmediately();
          }}
        >
          <Pencil size={18} />
        </Button>
      )}
      {showShare && (
        <ArtifactShareButton
          shareUrl={shareUrl}
          ariaLabel={t(($) => {
            return $.artifacts.actions.share;
          })}
          iconSize={18}
          url={preview.url}
        />
      )}
      <ArtifactDownloadMenu
        key={`${preview.url}:${artifact?.filename ?? artifactDialogFilename(preview)}`}
        ariaLabel={t(($) => {
          return $.artifacts.actions.downloadOptions;
        })}
        artifactKind={artifact?.artifactKind}
        filename={artifact?.filename ?? artifactDialogFilename(preview)}
        iconSize={18}
        syncTarget={artifactDialogSyncTarget(artifact)}
        url={preview.url}
      />
      <ArtifactActionSeparator />
      {showSplitView && (
        <ArtifactDialogSplitViewButton onClick={openInSplitView} />
      )}
      <ArtifactDialogFullscreenButton
        fullscreen={fullscreen}
        onClick={() => {
          toggleLightboxDialogFullscreen();
        }}
      />
      <ArtifactPreviewCloseButton />
    </div>
  );
}

function ArtifactPreviewDialogContent({
  artifact,
  imageNavigation,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const dialogMountRef = useSet(lightboxDialogMountRef$);
  const dialogElement = useSet(lightboxDialogElement$);
  const completeDialogExit = useSet(completeLightboxDialogExit$);
  const registerConnectionDialog = useSet(registerConnectorConnectionDialog$);
  const connectionProgressActive = useGet(connectorConnectionProgressActive$);
  const closeWithAnimation = useCloseArtifactPreview();
  const filename = artifact?.filename ?? artifactDialogFilename(preview);
  const subtitle = artifactDialogKindLabel(preview, artifact);
  const visible = useGet(lightboxDialogVisible$);
  const fullscreen = useGet(lightboxDialogFullscreen$);

  return (
    <Dialog
      open={visible}
      onOpenChangeComplete={completeDialogExit}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && visible) {
          closeWithAnimation();
        }
      }}
    >
      <DialogContent
        ref={dialogMountRef}
        initialFocus={dialogElement}
        showCloseButton={false}
        overlayClassName="okou-pwa-fixed-cover bg-gray-900/45 dark:bg-gray-900/45"
        maxWidth={1440}
        height={1000}
        surface="canvas"
        mode={fullscreen ? "fullscreen" : "windowed"}
        contentClassName="flex flex-col gap-0 overflow-hidden bg-background p-0"
        aria-label={t(
          ($) => {
            return $.artifacts.preview.dialogLabel;
          },
          { filename },
        )}
        data-testid="attachment-lightbox"
      >
        {/* An immersive overlay: arrow keys always navigate, regardless of focus. */}
        <ArtifactImageNavigationKeydown
          capture
          considerFocus={false}
          navigation={
            !connectionProgressActive && preview.kind === "image"
              ? imageNavigation
              : undefined
          }
        />
        <div
          ref={registerConnectionDialog}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground"
          data-testid="attachment-lightbox-panel"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{filename}</div>
              <div className="truncate text-xs text-muted-foreground">
                {subtitle}
              </div>
            </div>
            {connectionProgressActive ? (
              <ArtifactPreviewCloseButton />
            ) : (
              <ArtifactPreviewDialogActions
                artifact={artifact}
                fullscreen={fullscreen}
                preview={preview}
              />
            )}
          </div>
          <DialogBody className="overflow-hidden bg-background">
            {connectionProgressActive ? (
              <div className="flex h-full items-center justify-center p-6">
                <ConnectorConnectionStatus />
              </div>
            ) : (
              <ArtifactDialogBody
                artifact={artifact}
                imageNavigation={imageNavigation}
                preview={preview}
              />
            )}
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AttachmentLightbox() {
  const preview = useGet(lightboxUrl$);

  if (!preview) {
    return null;
  }

  return <ArtifactPreviewDialog preview={preview} />;
}

// ---------------------------------------------------------------------------
// FileAttachmentChip — compact chip shown inside sent message bubbles
// ---------------------------------------------------------------------------

// Shared visual shape for file attachment chips. Keeps a fixed h-7 (28px)
// height regardless of upload state, with the filename always visible and
// truncated with an ellipsis past max-w-[240px].
const FILE_CHIP_CLASSES =
  "inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border border-foreground/15 bg-background/80 px-1.5 transition-colors";

function FileChipBody({
  filename,
  contentType,
  testId,
}: {
  filename: string;
  contentType?: string;
  testId: string;
}) {
  return (
    <>
      <FilePreviewIcon
        filename={filename}
        contentType={contentType}
        size="sm"
        className="shrink-0"
        testId={testId}
      />
      <span className="min-w-0 truncate text-xs font-medium">{filename}</span>
    </>
  );
}

export function FileAttachmentChip({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  const { t } = useTranslation();
  const downloadAttachment = useSet(downloadAttachment$);
  const openFileLightbox = useSet(openFileLightbox$);
  const pageSignal = useGet(pageSignal$);
  const previewOfficeDocument = isOfficeFilePreview(filename);
  return (
    <button
      type="button"
      onClick={() => {
        if (previewOfficeDocument) {
          openFileLightbox({ filename, url });
          return;
        }
        detach(
          downloadAttachment({ filename, url }, pageSignal),
          Reason.DomCallback,
          "attachment download",
        );
      }}
      title={filename}
      aria-label={
        previewOfficeDocument
          ? t(
              ($) => {
                return $.chat.attachments.previewFile;
              },
              { filename },
            )
          : t(
              ($) => {
                return $.artifacts.attachments.download;
              },
              { filename },
            )
      }
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentType}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

export function PreviewableFileAttachmentChip({
  filename,
  kind,
  shareAvailable,
  splitViewAvailable,
  text$,
  url,
}: {
  filename: string;
  kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html";
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  text$?: TextPreviewComputed;
  url: string;
}) {
  const { t } = useTranslation();
  const openDocumentLightbox = useSet(openDocumentLightbox$);
  const kindLabel =
    kind === "markdown"
      ? t(($) => {
          return $.artifacts.preview.openKinds.markdown;
        })
      : kind === "text"
        ? t(($) => {
            return $.artifacts.preview.openKinds.text;
          })
        : kind === "json"
          ? t(($) => {
              return $.artifacts.preview.openKinds.json;
            })
          : kind === "csv"
            ? t(($) => {
                return $.artifacts.preview.openKinds.csv;
              })
            : kind === "pdf"
              ? t(($) => {
                  return $.artifacts.preview.openKinds.pdf;
                })
              : t(($) => {
                  return $.artifacts.preview.openKinds.html;
                });

  return (
    <button
      type="button"
      onClick={() => {
        openDocumentLightbox({
          kind,
          url,
          filename,
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
          ...(text$ ? { text$ } : {}),
        });
      }}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: kindLabel,
          filename,
        },
      )}
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentTypeForDocumentAttachmentPreviewKind(kind)}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

export function PreviewableAudioAttachmentChip({
  contentType,
  filename,
  shareAvailable,
  splitViewAvailable,
  url,
}: {
  contentType?: string;
  filename: string;
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  url: string;
}) {
  const { t } = useTranslation();
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openAudioLightbox({
          url,
          filename,
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
        });
      }}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: t(($) => {
            return $.artifacts.preview.openKinds.audio;
          }),
          filename,
        },
      )}
      className={`${FILE_CHIP_CLASSES} hover:bg-state-hover`}
    >
      <FileChipBody
        filename={filename}
        contentType={contentType}
        testId="attachment-chip-file-icon"
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChip — chip shown in the composer before the message is sent
// ---------------------------------------------------------------------------

/**
 * Composer attachments use the same presigned thumbnail as sent messages.
 * The preview also supplies the original credential to the lightbox. Kept in
 * its own component so the surrounding button stays one DOM node across the
 * pending-to-uploaded transition. The canonical URL identifies the load state.
 */
function ComposerImagePreviewImage({
  preview,
  load,
  loaded,
  url,
}: {
  preview: AttachmentPreviewSignals;
  load: ImageLoadSignals;
  loaded: boolean;
  url: string;
}) {
  const markLoaded = useSet(load.loaded$);
  const markFailed = useSet(load.failed$);
  const resolvedUrl = useLastResolved(preview.thumbnailUrl$) ?? null;

  if (resolvedUrl === null) {
    return null;
  }

  return (
    <img
      key={url}
      src={resolvedUrl}
      alt=""
      loading="lazy"
      onLoad={markLoaded}
      onError={markFailed}
      className={`h-full w-full object-cover ${loaded ? "" : "opacity-0"}`}
    />
  );
}

function ComposerImagePreviewButton({
  preview,
  filename,
  load,
  markCount,
  openImageLightbox,
  url,
}: {
  preview: AttachmentPreviewSignals | null;
  filename: string;
  load: ImageLoadSignals;
  markCount: number;
  openImageLightbox: (url: string, preview: AttachmentPreviewSignals) => void;
  url: string | undefined;
}) {
  const { t } = useTranslation();
  const currentImageStatus = useGet(load.status$);

  if (!url || !preview) {
    return (
      <button
        type="button"
        disabled
        aria-label={t(
          ($) => {
            return $.artifacts.attachments.openImagePreview;
          },
          {
            filename,
          },
        )}
        title={filename}
        className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
      >
        <Image size={20} className="text-muted-foreground m-auto h-full" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        openImageLightbox(url, preview);
      }}
      aria-label={t(
        ($) => {
          return $.artifacts.attachments.openImagePreview;
        },
        {
          filename,
        },
      )}
      title={filename}
      className="group/image-preview relative h-9 w-9 overflow-hidden rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
    >
      {currentImageStatus !== "loaded" && (
        <span
          data-testid="composer-image-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-muted/70 text-muted-foreground"
        >
          {currentImageStatus === "loading" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Image size={16} />
          )}
        </span>
      )}
      <ComposerImagePreviewImage
        preview={preview}
        load={load}
        loaded={currentImageStatus === "loaded"}
        url={url}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/image-preview:bg-black/30">
        <Image
          size={18}
          className="text-white opacity-0 drop-shadow transition-opacity group-hover/image-preview:opacity-100"
        />
      </span>
      {markCount > 0 && (
        <span
          data-testid="composer-attachment-mark-count"
          style={{ background: DEFAULT_ANNOTATION_INK }}
          className="absolute -bottom-0.5 -left-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border-[1.5px] border-background px-1 text-[9px] font-bold leading-none text-white"
        >
          {markCount}
        </span>
      )}
    </button>
  );
}

function AnnotationUploadRetry({
  attachment,
  onAnnotationChange,
}: {
  readonly attachment: ChatAttachment;
  readonly onAnnotationChange: () => void;
}) {
  const { t } = useTranslation();
  const status = useGet(attachment.annotationUploadStatus$);
  const retry = useSet(attachment.retryAnnotationUpload$);
  const pageSignal = useGet(pageSignal$);
  if (status !== "failed") {
    return null;
  }
  return (
    <IconTooltipButton
      type="button"
      className="absolute -top-1 -left-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
      aria-label={t(
        ($) => {
          return $.chat.attachments.uploadFailedRetry;
        },
        { filename: attachment.filename },
      )}
      onClick={() => {
        detach(
          withCleanup(retry(pageSignal), onAnnotationChange),
          Reason.DomCallback,
        );
      }}
    >
      <RotateCcw size={9} />
    </IconTooltipButton>
  );
}

function AttachmentChip({
  attachment,
  annotationSignals,
  onAnnotationChange,
  onRemove,
}: {
  attachment: ChatAttachment;
  annotationSignals: ImageAnnotationSignals;
  onAnnotationChange: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const infoLoadable = useLoadable(attachment.fileInfo$);
  const preview = useLastResolved(attachment.preview$) ?? null;
  const uploading = useGet(attachment.uploadPending$);
  const url =
    infoLoadable.state === "hasData" && infoLoadable.data
      ? canonicalUserMessageFileUrl(infoLoadable.data.id)
      : undefined;
  const openImageLightbox = useSet(openImageLightbox$);
  const openAnnotationEditor = useSet(annotationSignals.openAnnotationEditor$);
  const confirmAnnotations = useSet(attachment.confirmAnnotations$);
  const annotations = useGet(attachment.annotations$);
  const annotationEnabled = useGet(composerImageAnnotationEnabled$);
  const isImage = attachment.contentType.startsWith("image/");
  return (
    <div
      className="relative inline-flex items-center"
      title={attachment.filename}
    >
      {isImage ? (
        <ComposerImagePreviewButton
          preview={preview}
          filename={attachment.filename}
          load={attachment.imageLoad}
          markCount={annotationMarkCount(annotations)}
          openImageLightbox={(previewUrl, imagePreview) => {
            // A pending upload is not an artifact yet, so checking it must not
            // take over an open artifact sidebar.
            openImageLightbox({
              url: previewUrl,
              filename: attachment.filename,
              preview: imagePreview,
              splitViewAvailable: false,
              ...(annotationEnabled && !uploading
                ? {
                    annotationTarget: {
                      annotations,
                      open: () => {
                        openAnnotationEditor({
                          key: attachment.key,
                          filename: attachment.filename,
                          url: previewUrl,
                          annotations,
                          commit: async (next, signal) => {
                            // Persist once, after the annotated copy exists or
                            // has definitively failed. Saving while the upload
                            // was still in flight wrote a draft carrying marks
                            // with no copy for them to render into, and a draft
                            // in that shape restores as `failed` — a failure
                            // the user is shown for something that was merely
                            // unfinished. The chip already reflects the marks
                            // from `annotations$`, which this sets
                            // synchronously, so nothing visible waits on the
                            // save.
                            await withCleanup(
                              confirmAnnotations(next, signal),
                              onAnnotationChange,
                            );
                          },
                        });
                      },
                    },
                  }
                : {}),
            });
          }}
          url={url}
        />
      ) : (
        <span className={FILE_CHIP_CLASSES}>
          <FileChipBody
            filename={attachment.filename}
            contentType={attachment.contentType}
            testId="composer-attachment-file-icon"
          />
        </span>
      )}
      {uploading && (
        <span className="absolute -top-1 -left-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
          <Loader2 size={10} className="animate-spin text-muted-foreground" />
        </span>
      )}
      <AnnotationUploadRetry
        attachment={attachment}
        onAnnotationChange={onAnnotationChange}
      />
      <IconTooltipButton
        type="button"
        onClick={onRemove}
        className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
        aria-label={
          uploading
            ? t(
                ($) => {
                  return $.artifacts.attachments.cancelUpload;
                },
                {
                  filename: attachment.filename,
                },
              )
            : t(
                ($) => {
                  return $.artifacts.attachments.remove;
                },
                {
                  filename: attachment.filename,
                },
              )
        }
      >
        <X size={9} />
      </IconTooltipButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChips — wrapper that renders a list of AttachmentChip items
// ---------------------------------------------------------------------------

export function AttachmentChips({
  attachments,
  annotationSignals,
  onAnnotationChange,
  onRemove,
}: {
  attachments: ChatAttachment[];
  annotationSignals: ImageAnnotationSignals;
  onAnnotationChange: () => void;
  onRemove: (attachment: ChatAttachment) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((a) => {
        return (
          <AttachmentChip
            onAnnotationChange={onAnnotationChange}
            key={a.key}
            attachment={a}
            annotationSignals={annotationSignals}
            onRemove={() => {
              return onRemove(a);
            }}
          />
        );
      })}
    </div>
  );
}
