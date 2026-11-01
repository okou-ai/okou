import { ArtifactDeleteButton } from "./artifact-deletion.tsx";
import { closeArtifactCatalogPreview$ } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import {
  ArtifactPreviewCloseButton,
  ArtifactPreviewDialogFrame,
  DialogIconButton,
} from "./artifact-preview-dialog-frame.tsx";
import type { ReactNode } from "react";
import { ApiError } from "../../lib/api-error.ts";
import {
  hostedSiteRecoveryTarget,
  hostedSiteRecoveryReason,
} from "../../lib/hosted-site-access.ts";
import { HostedSiteAccessCard } from "../hosted-site-authorization/hosted-site-access-page.tsx";
import { ArtifactAccessCard } from "../components/artifact-access-card.tsx";
import { Button, DialogBody, cn } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Columns2,
  Download,
  FileMusic,
  Image,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
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
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import type {
  TextPreviewComputed,
  TextPreviewContent,
} from "../../signals/text-preview.ts";
import { JsonPreview } from "../components/json-preview.tsx";
import type { MarkdownPreviewTreeComputed } from "../../signals/markdown-preview-tree.ts";
import { ArtifactMarkdownDocument } from "../components/artifact-markdown-document.tsx";
import {
  attachmentSidebarRef,
  attachmentLightboxImageCanvasSignals,
  lightboxUrl$,
  closeLightboxImmediately$,
  closeLightboxWithDialogExit$,
  lightboxDialogFullscreen$,
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
import { ArtifactImageNavigationRegion } from "./artifact-image-navigation-region.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import {
  artifactPreviewUrlsMatch,
  attachmentFilenameFromUrl,
} from "./attachment-url.ts";
import type { ComposerAttachmentAnnotationActions } from "../../signals/okou-page/composer-business-actions.ts";
import { AnnotationMarkLayer } from "./image-annotation-marks.tsx";
import {
  annotationMarkCount,
  DEFAULT_ANNOTATION_INK,
  type ImageAnnotationSignals,
} from "../../signals/okou-page/image-annotation.ts";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
  ArtifactImageZoomControls,
  ArtifactShareButton,
  type ArtifactDownloadSyncTarget,
  type ArtifactImageNavigationActions,
} from "./artifact-actions.tsx";
import {
  artifactFallbackSubtitle,
  artifactSupportsFullscreen,
  artifactTitleLink,
  artifactTitleSubtitle,
} from "./artifact-display.ts";
import { ArtifactTitle } from "./artifact-title.tsx";
import {
  currentEventImageArtifactNavigation,
  equalEventImageGroups,
  type ImageArtifactNavigationItem,
} from "./artifact-image-navigation.ts";
import { ZoomableArtifactImageCanvas } from "./zoomable-image-canvas.tsx";
import type { ZoomableImageCanvasSignals } from "../../signals/zoomable-image-canvas.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { hostedArtifactReferrerPolicy } from "../../lib/platform-host.ts";
import { PresentationArtifactViewport } from "./presentation-artifact-viewport.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { OfficeDocumentPreview } from "./office-document-preview.tsx";
import { isOfficeFilePreview } from "./office-file-preview.ts";

type TextPreviewLoadState =
  | {
      readonly status: "loaded";
      readonly text: string;
      readonly preview: TextPreviewContent;
    }
  | {
      readonly status: "loading" | "error";
      readonly text: "";
      readonly preview: null;
    };

type DocumentAttachmentPreviewKind =
  "markdown" | "text" | "json" | "csv" | "html" | "pdf";

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
    return children({
      status: "loaded",
      text: loadable.data.text,
      preview: loadable.data,
    });
  }
  if (loadable.state === "hasError") {
    return children({ status: "error", text: "", preview: null });
  }
  return children({ status: "loading", text: "", preview: null });
}

/** Null keeps source visible when CSV cannot form a faithful, bounded table. */
export function parseCsvPreviewRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  const finishCell = () => {
    row.push(cell);
    cell = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (text.charAt(index + 1) === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
    } else if (character === ",") {
      finishCell();
    } else if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && text.charAt(index + 1) === "\n") {
        index++;
      }
    } else if (closedQuote) {
      return null;
    } else if (character === '"') {
      if (cell !== "") {
        return null;
      }
      quoted = true;
    } else {
      cell += character;
    }
  }
  if (quoted) {
    return null;
  }
  if (cell !== "" || closedQuote || row.length > 0) {
    finishRow();
  }
  const [header] = rows;
  if (
    header &&
    (rows.length * header.length > 10_000 ||
      rows.some((record) => {
        return record.length !== header.length;
      }))
  ) {
    return null;
  }
  return rows;
}

/** CSV may repeat header labels, cell values and entire records. */
function keyedCsvItems<T>(items: readonly T[], identity: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((value) => {
    const content = identity(value);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { key: JSON.stringify([content, occurrence]), value };
  });
}

export function CsvPreviewTable({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows;
  const columns = keyedCsvItems(header, (value) => {
    return value;
  });
  const records = keyedCsvItems(body, (value) => {
    return JSON.stringify(value);
  });

  return (
    <div className="overflow-auto rounded-lg border border-foreground/10">
      <table className="min-w-full divide-y divide-foreground/10 text-sm">
        <thead className="bg-muted/40">
          <tr>
            {columns.map((column) => {
              return (
                <th
                  key={column.key}
                  className="whitespace-pre-wrap px-3 py-2 text-left font-medium text-foreground"
                >
                  {column.value}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-foreground/10 bg-background">
          {records.map((record) => {
            return (
              <tr key={record.key}>
                {keyedCsvItems(record.value, (value) => {
                  return value;
                }).map((cell) => {
                  return (
                    <td
                      key={cell.key}
                      className="whitespace-pre-wrap px-3 py-2 text-foreground"
                    >
                      {cell.value}
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
  if (!artifact?.artifactId) {
    return undefined;
  }
  return {
    accountReady: artifact.googleDriveAccountReady,
    agentId: artifact.agentId,
    disconnected: artifact.googleDriveDisconnected,
    recovery: artifact.googleDriveRecovery,
    artifactId: artifact.artifactId,
    connectionId: artifact.googleDriveConnectionId,
    filename: artifact.filename,
    onSyncSuccess: artifact.onSyncSuccess,
    synced: artifact.googleDriveSynced,
    mimeType: artifact.googleDriveMimeType,
    originalUploaded: artifact.googleDriveOriginalUploaded,
    webViewLink: artifact.googleDriveWebViewLink,
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
  threadId: string;
}): AttachmentArtifactMetadata {
  const connectionId = params.item.file.googleDriveConnectionId;
  return {
    agentId: params.agentId,
    ...(params.item.file.artifactId
      ? { artifactId: params.item.file.artifactId }
      : {}),
    ...(connectionId ? { googleDriveConnectionId: connectionId } : {}),
    aliasUrl: params.item.file.aliasUrl,
    title: params.item.file.title,
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
    googleDriveOriginalUploaded:
      params.item.file.googleDriveSync?.status === "synced"
        ? params.item.file.googleDriveSync.originalUploaded
        : undefined,
    googleDriveMimeType:
      params.item.file.googleDriveSync?.status === "synced"
        ? params.item.file.googleDriveSync.mimeType
        : undefined,
    googleDriveWebViewLink:
      params.item.file.googleDriveSync?.status === "synced"
        ? params.item.file.googleDriveSync.webViewLink
        : undefined,
    runId: params.item.runId,
    size: params.item.file.size,
    threadId: params.threadId,
  };
}

function ArtifactDialogLoadingBody() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

function ArtifactDialogUnavailableBody({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <span>
        {t(
          ($) => {
            return $.artifacts.preview.unavailable;
          },
          { kind: label },
        )}
      </span>
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
        fillHeight ? "h-full min-h-0 bg-transparent" : "min-h-[420px]"
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
          />
        </ArtifactDialogCard>
      </ArtifactDialogStage>
    );
  }
  return (
    <ArtifactDialogStage>
      <ArtifactDialogCard>
        <ArtifactMarkdownDocument tree={loadable.data} />
      </ArtifactDialogCard>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogTextBody({
  kind,
  text$,
  maxCharacters,
}: {
  kind: "text" | "json" | "csv";
  text$: TextPreviewComputed;
  maxCharacters: number;
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
      {({ status, text, preview }) => {
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

        if (kind === "json" && preview) {
          return (
            <ArtifactDialogStage scrollable={false}>
              <ArtifactDialogCard fillHeight>
                <JsonPreview preview={preview} />
              </ArtifactDialogCard>
            </ArtifactDialogStage>
          );
        }
        const rows = kind === "csv" ? parseCsvPreviewRows(text) : null;
        if (rows) {
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

        const formatted = text;
        const display =
          formatted.length > maxCharacters
            ? `${formatted.slice(0, maxCharacters)}\n\n…`
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

function ArtifactDialogImageBody({
  filename,
  fullscreen,
  imageCanvasSignals,
  imageNavigation,
  preview,
}: {
  filename: string;
  fullscreen: boolean;
  imageCanvasSignals: ZoomableImageCanvasSignals;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: Extract<AttachmentLightboxState, { kind: "image" }>;
}) {
  const { t } = useTranslation();
  const resource = useLoadable(preview.resourceUrl$);
  const resourceUrl = resource.state === "hasData" ? resource.data : null;
  // Marks live on the draft rather than in the file, so the viewer has to draw
  // them too — otherwise reopening an annotated image shows a clean picture.
  const annotation = preview.annotationTarget?.annotations ?? null;

  return (
    <ArtifactDialogStage flush scrollable={false}>
      <ArtifactDialogCard fillHeight>
        <ArtifactImageNavigationRegion
          signals={imageCanvasSignals}
          filename={filename}
          navigation={imageNavigation}
          testIdPrefix="artifact-dialog"
        >
          {resource.state === "hasError" ? (
            <ArtifactDialogResourceError
              preview={preview}
              error={resource.error}
            />
          ) : resourceUrl === null ? (
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
              signals={imageCanvasSignals}
              expanded={fullscreen}
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
                    showTooltip={false}
                    placement={fullscreen ? "bottom" : "top"}
                    testIdPrefix="artifact-dialog"
                  />
                );
              }}
            </ZoomableArtifactImageCanvas>
          )}
        </ArtifactImageNavigationRegion>
      </ArtifactDialogCard>
    </ArtifactDialogStage>
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

  // Video is the canvas, not reading content. Let it use the whole preview
  // surface in both windowed and fullscreen modes while preserving its ratio.
  return (
    <ArtifactDialogStage flush scrollable={false}>
      <div
        className="h-full min-h-0 w-full overflow-hidden bg-black"
        data-testid="artifact-dialog-video-stage"
      >
        {resourceUrl !== null && (
          <video
            src={resourceUrl}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="block h-full w-full bg-black object-contain"
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
      <div className="flex w-full max-w-[520px] flex-col items-center gap-4 p-6">
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
  fullscreen,
  preview,
}: {
  filename: string;
  fullscreen: boolean;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;
  // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail so the
  // embedded preview shows just the page and toolbar by default.
  const src =
    resourceUrl !== null && preview.kind === "pdf" && !resourceUrl.includes("#")
      ? `${resourceUrl}#navpanes=0`
      : resourceUrl;

  return (
    <ArtifactDialogStage flush={fullscreen} scrollable={false}>
      <div
        className="flex h-full min-h-0 w-full flex-1 overflow-hidden"
        data-testid="artifact-dialog-document-frame"
      >
        {src === null && <ArtifactDialogLoadingBody />}
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

// No preview is a terminal screen, so it has to carry the one action that
// still works on the file: taking it away.
function ArtifactDialogGenericFileBody({
  filename,
  preview,
}: {
  filename: string;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [downloadLoadable, downloadAttachment] =
    useLoadableSet(downloadAttachment$);
  const downloading = downloadLoadable.state === "loading";
  return (
    <ArtifactDialogStage centered>
      <div className="flex w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <FilePreviewIcon filename={filename} size="lg" />
        <div className="flex flex-col gap-1">
          <p className="break-all text-sm font-medium text-foreground">
            {filename}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(($) => {
              return $.artifacts.preview.noInline;
            })}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={downloading}
          aria-busy={downloading}
          onClick={() => {
            detach(
              downloadAttachment({ filename, url: preview.url }, pageSignal),
              Reason.DomCallback,
              "artifact download",
            );
          }}
        >
          {downloading ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Download size={14} aria-hidden />
          )}
          {t(($) => {
            return $.artifacts.actions.download;
          })}
        </Button>
        {downloadLoadable.state === "hasError" && (
          <p role="alert" className="text-xs text-destructive">
            {t(($) => {
              return $.artifacts.toasts.downloadFailed;
            })}
          </p>
        )}
      </div>
    </ArtifactDialogStage>
  );
}

function ArtifactDialogOfficeDocumentBody({
  filename,
  fullscreen,
  preview,
}: {
  filename: string;
  fullscreen: boolean;
  preview: Extract<AttachmentLightboxState, { kind: "file" }>;
}) {
  const resourceUrl = useLastResolved(preview.resourceUrl$) ?? null;
  const shareUrl = useLastResolved(preview.shareUrl$);
  return (
    <ArtifactDialogStage flush={fullscreen} scrollable={false}>
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background",
          !fullscreen && "rounded-xl border border-border/70 shadow-sm",
        )}
      >
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

function ArtifactDialogResourceError({
  preview,
  error,
}: {
  preview: AttachmentLightboxState;
  error: unknown;
}) {
  const { t } = useTranslation();
  const target =
    preview.kind === "html" ? hostedSiteRecoveryTarget(preview.url) : null;
  if (target) {
    return (
      <HostedSiteAccessCard
        target={target}
        reason={hostedSiteRecoveryReason(error)}
      />
    );
  }
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
    return (
      <div className="h-full overflow-y-auto">
        <ArtifactAccessCard />
      </div>
    );
  }
  return (
    <ArtifactDialogStage centered>
      <p role="status" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      </p>
    </ArtifactDialogStage>
  );
}

interface ArtifactPreviewBodyProps {
  artifact: AttachmentArtifactMetadata | undefined;
  focusHtmlOnMount?: boolean;
  fullscreen: boolean;
  imageCanvasSignals: ZoomableImageCanvasSignals;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
  textMaxCharacters?: number;
}

export function ArtifactPreviewBody(props: ArtifactPreviewBodyProps) {
  return (
    <ArtifactPreviewResourceBoundary preview={props.preview}>
      <ArtifactPreviewContent {...props} />
    </ArtifactPreviewResourceBoundary>
  );
}

function ArtifactPreviewResourceBoundary({
  children,
  preview,
}: {
  children: ReactNode;
  preview: AttachmentLightboxState;
}) {
  const resource = useLoadable(preview.resourceUrl$);

  // Images keep their navigation region mounted across loading and errors.
  if (resource.state === "hasError" && preview.kind !== "image") {
    return (
      <ArtifactDialogResourceError preview={preview} error={resource.error} />
    );
  }

  return children;
}

function ArtifactPreviewContent({
  artifact,
  focusHtmlOnMount = true,
  fullscreen,
  imageCanvasSignals,
  imageNavigation,
  preview,
  textMaxCharacters = 16_000,
}: ArtifactPreviewBodyProps) {
  const filename = artifactDialogFilename(preview);

  if (preview.kind === "image") {
    return (
      <ArtifactDialogImageBody
        filename={filename}
        fullscreen={fullscreen}
        imageCanvasSignals={imageCanvasSignals}
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
          fullscreen={fullscreen}
          preview={preview}
        />
      );
    }
    return (
      <ArtifactDialogGenericFileBody filename={filename} preview={preview} />
    );
  }

  if (preview.kind === "markdown") {
    return <ArtifactDialogMarkdownBody tree$={preview.markdownTree$} />;
  }
  if (
    preview.kind === "text" ||
    preview.kind === "json" ||
    preview.kind === "csv"
  ) {
    return (
      <ArtifactDialogTextBody
        kind={preview.kind}
        text$={preview.text$}
        maxCharacters={textMaxCharacters}
      />
    );
  }

  if (preview.kind === "html") {
    return (
      <ArtifactDialogHtmlBody
        artifact={artifact}
        focusOnMount={focusHtmlOnMount}
        filename={filename}
        fullscreen={fullscreen}
        preview={preview}
      />
    );
  }

  return (
    <ArtifactDialogDocumentFrameBody
      filename={filename}
      fullscreen={fullscreen}
      preview={preview}
    />
  );
}

function ArtifactDialogHtmlBody({
  artifact,
  focusOnMount,
  filename,
  fullscreen,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  focusOnMount: boolean;
  filename: string;
  fullscreen: boolean;
  preview: AttachmentLightboxState;
}) {
  const { t } = useTranslation();
  const resource = useLastLoadable(preview.resourceUrl$);
  const src = resource.state === "hasData" ? resource.data : null;
  const isPresentationHtml = artifact?.artifactKind === "presentation-html";
  if (src === null) {
    // A blank panel is indistinguishable from an artifact that rendered
    // nothing, so the unresolved frame shows the same spinner every other
    // preview uses while it waits.
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-background"
        data-testid="artifact-dialog-site-frame"
      >
        <ArtifactDialogLoadingBody />
      </div>
    );
  }

  const frame = (
    <AutoFocusedArtifactIframe
      focusKey={`${preview.url}:${fullscreen ? "fullscreen" : "dialog"}`}
      focusOnMount={focusOnMount && !isPresentationHtml}
      src={src}
      title={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      sandbox="allow-same-origin allow-scripts"
      referrerPolicy={hostedArtifactReferrerPolicy(src)}
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
            threadId: thread.threadId,
          })
        : undefined,
      filename: navigationItem.filename,
      preview: navigationItem.preview,
      // Navigation never leaves the event group it started in, so a user
      // message's images stay attachments as the viewer steps through them.
      shareAvailable: imageNavigation.role !== "user",
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
  const closeDeletedPreview = useSet(closeArtifactCatalogPreview$);
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
          artifactShareIdentity$={preview.artifactShareIdentity$}
          surface="dialog"
          shareUrl={shareUrl}
          ariaLabel={t(($) => {
            return $.artifacts.actions.share;
          })}
          iconSize={18}
          url={preview.url}
        />
      )}
      <ArtifactDownloadMenu
        surface="dialog"
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
      <ArtifactDeleteButton
        artifactId={preview.catalogArtifactId ?? artifact?.artifactId}
        surface="dialog"
        iconSize={18}
        onDeleted={() => {
          closeDeletedPreview(rootSignal);
        }}
      />
      <ArtifactActionSeparator />
      {showSplitView && (
        <ArtifactDialogSplitViewButton onClick={openInSplitView} />
      )}
      {artifactSupportsFullscreen(preview.kind) && (
        <ArtifactDialogFullscreenButton
          fullscreen={fullscreen}
          onClick={() => {
            toggleLightboxDialogFullscreen();
          }}
        />
      )}
      <ArtifactPreviewCloseButton />
    </div>
  );
}

function ArtifactPreviewDialogHeaderActions({
  artifact,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  preview: AttachmentLightboxState;
}) {
  const fullscreen = useGet(lightboxDialogFullscreen$);

  return (
    <ArtifactPreviewDialogActions
      artifact={artifact}
      fullscreen={fullscreen}
      preview={preview}
    />
  );
}

function ArtifactPreviewDialogBody({
  artifact,
  imageNavigation,
  preview,
}: {
  artifact: AttachmentArtifactMetadata | undefined;
  imageNavigation?: ArtifactImageNavigationActions;
  preview: AttachmentLightboxState;
}) {
  const fullscreen = useGet(lightboxDialogFullscreen$);

  return (
    <ArtifactPreviewBody
      artifact={artifact}
      fullscreen={fullscreen}
      imageCanvasSignals={attachmentLightboxImageCanvasSignals}
      imageNavigation={imageNavigation}
      preview={preview}
    />
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
  const filename = artifact?.filename ?? artifactDialogFilename(preview);
  const title = artifact?.title ?? filename;
  const subtitle = artifactDialogKindLabel(preview, artifact);
  const titleLink = artifact ? artifactTitleLink(preview.kind, artifact) : null;

  return (
    <ArtifactPreviewDialogFrame
      ariaLabel={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename: title },
      )}
      kind={preview.kind}
    >
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-foreground"
        data-testid="attachment-lightbox-panel"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              <ArtifactTitle title={title} link={titleLink} />
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {subtitle}
            </div>
          </div>
          <ArtifactPreviewDialogHeaderActions
            artifact={artifact}
            preview={preview}
          />
        </div>
        <DialogBody className="overflow-hidden bg-background">
          <ArtifactPreviewDialogBody
            artifact={artifact}
            imageNavigation={imageNavigation}
            preview={preview}
          />
        </DialogBody>
      </div>
    </ArtifactPreviewDialogFrame>
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
  threadId,
  contentType,
  filename,
  preview,
  shareAvailable,
  url,
}: {
  contentType?: string;
  filename: string;
  preview?: AttachmentPreviewSignals;
  shareAvailable?: boolean;
  url: string;
  threadId?: string;
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
          openFileLightbox({
            threadId,
            filename,
            url,
            ...(preview ? { preview } : {}),
            ...(shareAvailable === undefined ? {} : { shareAvailable }),
          });
          return;
        }
        detach(
          downloadAttachment({ filename, url }, pageSignal),
          Reason.DomCallback,
          "attachment download",
        );
      }}
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
  threadId,
  filename,
  kind,
  preview,
  shareAvailable,
  splitViewAvailable,
  text$,
  url,
}: {
  filename: string;
  kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html";
  preview?: AttachmentPreviewSignals;
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  text$?: TextPreviewComputed;
  url: string;
  threadId?: string;
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
          threadId,
          kind,
          url,
          filename,
          ...(preview ? { preview } : {}),
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
          ...(text$ ? { text$ } : {}),
        });
      }}
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
  threadId,
  contentType,
  filename,
  preview,
  shareAvailable,
  splitViewAvailable,
  url,
}: {
  contentType?: string;
  filename: string;
  preview?: AttachmentPreviewSignals;
  shareAvailable?: boolean;
  splitViewAvailable?: boolean;
  url: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (
    <button
      type="button"
      onClick={() => {
        openAudioLightbox({
          threadId,
          url,
          filename,
          ...(preview ? { preview } : {}),
          ...(shareAvailable === undefined ? {} : { shareAvailable }),
          ...(splitViewAvailable === undefined ? {} : { splitViewAvailable }),
        });
      }}
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
          className="text-white opacity-0 drop-shadow group-hover/image-preview:opacity-100"
        />
      </span>
      {markCount > 0 && (
        <span
          data-testid="composer-attachment-mark-count"
          style={{ background: DEFAULT_ANNOTATION_INK }}
          className="absolute -bottom-0.5 -left-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border-(length:--border-width-emphasis) border-background px-1 text-[9px] font-bold leading-none text-white"
        >
          {markCount}
        </span>
      )}
    </button>
  );
}

function AttachmentChip({
  attachment,
  annotationSignals,
  annotationActions,
  onRemove,
}: {
  attachment: ChatAttachment;
  annotationSignals: ImageAnnotationSignals;
  annotationActions: ComposerAttachmentAnnotationActions;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const infoLoadable = useLoadable(attachment.fileInfo$);
  const preview = useLastResolved(attachment.preview$) ?? null;
  const uploading = infoLoadable.state === "loading";
  const url =
    infoLoadable.state === "hasData" && infoLoadable.data
      ? canonicalUserMessageFileUrl(infoLoadable.data.id)
      : undefined;
  const openImageLightbox = useSet(openImageLightbox$);
  const openAnnotationEditor = useSet(annotationSignals.openAnnotationEditor$);
  const confirmAnnotations = useSet(
    annotationActions.confirmAttachmentAnnotations$,
  );
  const annotations = useGet(attachment.annotations$);
  const isImage = attachment.contentType.startsWith("image/");
  if (
    infoLoadable.state === "hasError" ||
    (infoLoadable.state === "hasData" && infoLoadable.data === null)
  ) {
    return null;
  }
  return (
    <div className="relative inline-flex items-center">
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
              // An attachment is the user's own input, not a published
              // artifact, so it carries no sharing controls.
              shareAvailable: false,
              splitViewAvailable: false,
              ...(!uploading
                ? {
                    annotationTarget: {
                      annotations,
                      open: () => {
                        openAnnotationEditor({
                          key: attachment.key,
                          filename: attachment.filename,
                          url: previewUrl,
                          preview: imagePreview,
                          annotations,
                          commit: (next, signal) => {
                            return confirmAnnotations(attachment, next, signal);
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
  annotationActions,
  onRemove,
}: {
  attachments: ChatAttachment[];
  annotationSignals: ImageAnnotationSignals;
  annotationActions: ComposerAttachmentAnnotationActions;
  onRemove: (attachment: ChatAttachment) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3 empty:hidden">
      {attachments.map((a) => {
        return (
          <AttachmentChip
            annotationActions={annotationActions}
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
