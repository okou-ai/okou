import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Eye, FileMusic, Play, Video } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { TextPreviewComputed } from "../../signals/text-preview.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import {
  lightboxUrl$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openVideoLightbox$,
} from "../../signals/okou-page/attachment-chips.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "./file-preview-icon.tsx";
import { publicAttachmentUrl } from "./attachment-url";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
  previewImageUrl?: string;
  previewImagePending?: boolean;
}

type DocumentPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html";

function contentTypeForDocumentPreviewKind(kind: DocumentPreviewKind): string {
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  return "text/html";
}

function shouldUseNativeAnchorNavigation(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

type TextPreviewProps = {
  filename: string;
  url: string;
  kind: "text" | "json";
  text$?: TextPreviewComputed;
};

const MEDIA_PREVIEW_CARD_CLASS =
  "inline-flex w-[min(100%,400px)] overflow-hidden rounded-lg border border-foreground/10 bg-background text-left align-top text-foreground no-underline transition-all duration-200";
const MEDIA_PREVIEW_CARD_HOVER_CLASS =
  "hover:scale-[1.015] hover:border-foreground/20";

function TextPreview({ filename, kind, text$, url }: TextPreviewProps) {
  return (
    <AttachmentAnchorChip
      filename={filename}
      url={url}
      kind={kind}
      text$={text$}
    />
  );
}

type AttachmentAnchorChipKind =
  | "text"
  | "json"
  | "markdown"
  | "csv"
  | "pdf"
  | "html";

function documentPreviewAccentClass(kind: AttachmentAnchorChipKind) {
  if (kind === "markdown") {
    return "from-emerald-500/15 via-lime-500/10 to-background";
  }
  if (kind === "csv") {
    return "from-teal-500/15 via-emerald-500/10 to-background";
  }
  if (kind === "pdf") {
    return "from-rose-500/15 via-orange-500/10 to-background";
  }
  return "from-slate-500/15 via-cyan-500/10 to-background";
}

function AttachmentCardArtwork({
  accentClass,
  actionIcon,
  actionLabel,
  contentType,
  filename,
  iconTestId,
}: {
  accentClass: string;
  actionIcon: ReactNode;
  actionLabel: string;
  contentType?: string;
  filename: string;
  iconTestId: string;
}) {
  return (
    <div
      className={`relative flex aspect-[4/3] w-[144px] items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br sm:w-[168px] ${accentClass}`}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
      <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover/doc-preview:scale-105">
        <FilePreviewIcon
          filename={filename}
          contentType={contentType}
          testId={iconTestId}
        />
      </div>
      <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 group-hover/doc-preview:opacity-100">
        {actionIcon}
        {actionLabel}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/55 via-black/15 to-transparent px-2.5 py-2.5 text-white opacity-0 group-hover/doc-preview:opacity-100">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{filename}</div>
        </div>
      </div>
    </div>
  );
}

function AttachmentAnchorChip({
  filename,
  url,
  kind,
  text$,
}: {
  filename: string;
  url: string;
  kind: AttachmentAnchorChipKind;
  text$?: TextPreviewComputed;
}) {
  const { t } = useTranslation();
  const publicUrl = publicAttachmentUrl(url);
  const openDocument = useSet(openDocumentLightbox$);
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
    <a
      href={publicUrl}
      data-testid={`attachment-preview-${kind}`}
      onClick={(event) => {
        if (shouldUseNativeAnchorNavigation(event)) {
          return;
        }
        event.preventDefault();
        event.currentTarget.blur();
        openDocument({
          kind,
          url,
          filename,
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
      title={filename}
      className="group/doc-preview inline-flex w-fit self-start align-top text-left no-underline"
    >
      <AttachmentCardArtwork
        accentClass={documentPreviewAccentClass(kind)}
        actionIcon={<Eye size={10} />}
        actionLabel={t(($) => {
          return $.artifacts.preview.badge;
        })}
        contentType={contentTypeForDocumentPreviewKind(kind)}
        filename={filename}
        iconTestId={`attachment-preview-${kind}-icon`}
      />
    </a>
  );
}

function titleCaseSiteSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function fallbackHtmlPreviewTitle(
  filename: string,
  url: string,
): string {
  if (filename !== url) {
    return filename;
  }
  if (!URL.canParse(url)) {
    return filename;
  }
  const hostname = new URL(url).hostname;
  const subdomain = hostname.split(".")[0];
  if (!subdomain) {
    return filename;
  }
  const slug = subdomain.replace(/-[a-f0-9]{8}$/i, "");
  return titleCaseSiteSlug(slug) || filename;
}

/**
 * The site card's frame. A public conversation renders the same card from
 * Markdown without any artifact signals behind it, so the shell takes a plain
 * destination and its framed content.
 */
export function SitePreviewCard({
  ariaLabel,
  children,
  href,
  onClick,
  openInNewTab = false,
  testId,
  title,
}: {
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly href: string;
  readonly onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  readonly openInNewTab?: boolean;
  readonly testId: string;
  readonly title: string;
}) {
  return (
    <a
      href={href}
      data-testid={testId}
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      {...(openInNewTab
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className={`group/site-preview flex-col ${MEDIA_PREVIEW_CARD_CLASS} ${MEDIA_PREVIEW_CARD_HOVER_CLASS}`}
    >
      <div className="flex min-h-10 items-center border-b border-border/60 bg-background/95 px-3 py-2">
        {/* The card is a card, not a link: Markdown's anchor color reaches the
            title through the enclosing <a> unless the title states its own. */}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
      </div>
      <div className="relative aspect-[16/10] overflow-hidden bg-muted/30">
        {children}
      </div>
    </a>
  );
}

/** The site itself, scaled down to fill a card's frame. */
export function SitePreviewViewport({
  src,
  title,
}: {
  readonly src: string | undefined;
  readonly title: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="attachment-preview-html-viewport"
      className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-[0.25]"
    >
      <iframe
        src={src}
        title={t(
          ($) => {
            return $.artifacts.preview.siteLabel;
          },
          { title },
        )}
        sandbox="allow-same-origin allow-scripts"
        tabIndex={-1}
        loading="lazy"
        scrolling="no"
        className="pointer-events-none h-full w-full bg-background"
      />
    </div>
  );
}

function HtmlSitePreviewCard({
  resourceUrl$,
  filename,
  previewImageLoad,
  previewImagePending,
  previewImageUrl,
  url,
}: {
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  filename: string;
  previewImageLoad?: ImageLoadSignals;
  previewImagePending?: boolean;
  previewImageUrl?: string;
  url: string;
}) {
  const { t } = useTranslation();
  const publicUrl = publicAttachmentUrl(url);
  const openDocument = useSet(openDocumentLightbox$);
  const title = fallbackHtmlPreviewTitle(filename, url);

  return (
    <SitePreviewCard
      href={publicUrl}
      testId="attachment-preview-html"
      onClick={(event) => {
        if (shouldUseNativeAnchorNavigation(event)) {
          return;
        }
        event.preventDefault();
        event.currentTarget.blur();
        openDocument({ kind: "html", url, filename });
      }}
      ariaLabel={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: t(($) => {
            return $.artifacts.preview.openKinds.html;
          }),
          filename,
        },
      )}
      title={title}
    >
      {previewImageUrl && previewImageLoad ? (
        <ArtifactThumbnailImage
          src={previewImageUrl}
          load={previewImageLoad}
          testId="attachment-preview-thumbnail"
          className="absolute inset-0 h-full w-full object-cover"
          fallback={
            <HtmlSitePreviewViewport
              resourceUrl$={resourceUrl$}
              title={title}
            />
          }
        />
      ) : previewImagePending ? (
        <span
          className="absolute inset-0 bg-muted/30"
          data-testid="attachment-preview-thumbnail-pending"
        />
      ) : (
        <HtmlSitePreviewViewport resourceUrl$={resourceUrl$} title={title} />
      )}
    </SitePreviewCard>
  );
}

function HtmlSitePreviewViewport({
  resourceUrl$,
  title,
}: {
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  title: string;
}) {
  const resourceUrl = useLastResolved(resourceUrl$);
  return <SitePreviewViewport src={resourceUrl} title={title} />;
}

function DocumentThumbnailPreview({
  resourceUrl$,
  filename,
  kind,
  previewImageLoad,
  previewImagePending,
  previewImageUrl,
  text$,
  url,
}: {
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  filename: string;
  kind: "markdown" | "csv" | "pdf" | "html";
  previewImageLoad?: ImageLoadSignals;
  previewImagePending?: boolean;
  previewImageUrl?: string;
  text$?: TextPreviewComputed;
  url: string;
}) {
  if (kind === "html") {
    return (
      <HtmlSitePreviewCard
        resourceUrl$={resourceUrl$}
        filename={filename}
        previewImageLoad={previewImageLoad}
        previewImagePending={previewImagePending}
        previewImageUrl={previewImageUrl}
        url={url}
      />
    );
  }

  return (
    <AttachmentAnchorChip
      filename={filename}
      url={url}
      kind={kind}
      text$={text$}
    />
  );
}

function FileThumbnailPreview({
  onPreview,
  filename,
  contentType,
}: {
  onPreview: () => void;
  filename: string;
  contentType?: string;
}) {
  const { t } = useTranslation();
  const accentClass = getFilePreviewAccentClass(filename, contentType);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.blur();
        onPreview();
      }}
      title={filename}
      data-testid="attachment-preview-file"
      aria-label={t(
        ($) => {
          return $.chat.attachments.previewFile;
        },
        { filename },
      )}
      className="group/doc-preview inline-flex w-fit self-start align-top text-left"
    >
      <AttachmentCardArtwork
        accentClass={accentClass}
        actionIcon={<Eye size={10} />}
        actionLabel={t(($) => {
          return $.artifacts.preview.badge;
        })}
        contentType={contentType}
        filename={filename}
        iconTestId="attachment-preview-file-icon"
      />
    </button>
  );
}

function AudioPreview({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  const { t } = useTranslation();
  const openAudioLightbox = useSet(openAudioLightbox$);
  const lightboxOpen = useGet(lightboxUrl$) !== null;
  const accentClass = getFilePreviewAccentClass(
    filename,
    contentType ?? "audio/mpeg",
  );

  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.blur();
        openAudioLightbox({ url, filename });
      }}
      disabled={lightboxOpen}
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
      data-testid="attachment-preview-audio"
      className={`${lightboxOpen ? "" : "group/doc-preview"} inline-flex w-fit self-start align-top text-left disabled:pointer-events-none`}
    >
      <AttachmentCardArtwork
        accentClass={accentClass}
        actionIcon={<FileMusic size={10} />}
        actionLabel={t(($) => {
          return $.artifacts.preview.badge;
        })}
        contentType={contentType ?? "audio/mpeg"}
        filename={filename}
        iconTestId="attachment-preview-audio-icon"
      />
    </button>
  );
}

function VideoThumbnailPreview({
  contentType,
  filename,
  url,
}: {
  contentType?: string;
  filename: string;
  url: string;
}) {
  const { t } = useTranslation();
  const openVideoLightbox = useSet(openVideoLightbox$);
  const lightboxOpen = useGet(lightboxUrl$) !== null;
  const videoUrl = publicAttachmentUrl(url);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.blur();
        openVideoLightbox({ url, filename });
      }}
      disabled={lightboxOpen}
      title={filename}
      aria-label={t(
        ($) => {
          return $.artifacts.preview.openKind;
        },
        {
          kind: t(($) => {
            return $.artifacts.preview.openKinds.video;
          }),
          filename,
        },
      )}
      data-testid="attachment-preview-video"
      className={`${
        lightboxOpen
          ? ""
          : `group/video-preview ${MEDIA_PREVIEW_CARD_HOVER_CLASS}`
      } ${MEDIA_PREVIEW_CARD_CLASS} self-start disabled:pointer-events-none`}
    >
      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-black">
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-stone-900 text-white">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
            <FilePreviewIcon
              filename={filename}
              contentType={contentType ?? "video/mp4"}
              testId="attachment-preview-video-icon"
            />
          </span>
        </div>
        <video
          src={videoUrl}
          preload="metadata"
          muted
          playsInline
          aria-hidden="true"
          className="relative z-10 block h-full w-full bg-transparent object-cover opacity-90"
        />
        <div className="absolute inset-0 z-20 bg-black/15 transition-colors group-hover/video-preview:bg-black/35" />
        <span className="absolute inset-0 z-30 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-preview:scale-105">
            <Play size={20} />
          </span>
        </span>
        <div className="absolute right-2 top-2 z-30 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 group-hover/video-preview:opacity-100">
          <Video size={10} />
          {t(($) => {
            return $.artifacts.preview.badge;
          })}
        </div>
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 via-black/20 to-transparent px-2.5 py-2.5 text-white opacity-0 group-hover/video-preview:opacity-100">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{filename}</div>
          </div>
        </div>
      </div>
    </button>
  );
}

export function AttachmentPreview({
  resourceUrl$,
  attachment,
  onPreviewFile,
  previewImageLoad,
  text$,
}: {
  resourceUrl$: ArtifactSignals["resourceUrl$"];
  attachment: ChatAttachmentDescriptor;
  onPreviewFile: () => void;
  previewImageLoad?: ImageLoadSignals;
  text$?: TextPreviewComputed;
}) {
  const kind = classifyChatAttachment(attachment);

  switch (kind) {
    case "markdown": {
      return (
        <DocumentThumbnailPreview
          resourceUrl$={resourceUrl$}
          filename={attachment.filename}
          url={attachment.url}
          kind="markdown"
          text$={text$}
        />
      );
    }
    case "text": {
      return (
        <TextPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="text"
          text$={text$}
        />
      );
    }
    case "json": {
      return (
        <TextPreview
          filename={attachment.filename}
          url={attachment.url}
          kind="json"
          text$={text$}
        />
      );
    }
    case "csv": {
      return (
        <DocumentThumbnailPreview
          resourceUrl$={resourceUrl$}
          filename={attachment.filename}
          url={attachment.url}
          kind="csv"
          text$={text$}
        />
      );
    }
    case "pdf": {
      return (
        <DocumentThumbnailPreview
          resourceUrl$={resourceUrl$}
          filename={attachment.filename}
          url={attachment.url}
          kind="pdf"
        />
      );
    }
    case "html": {
      return (
        <DocumentThumbnailPreview
          resourceUrl$={resourceUrl$}
          filename={attachment.filename}
          previewImageLoad={previewImageLoad}
          previewImagePending={attachment.previewImagePending}
          previewImageUrl={attachment.previewImageUrl}
          url={attachment.url}
          kind="html"
        />
      );
    }
    case "audio": {
      return (
        <AudioPreview
          contentType={attachment.contentType}
          filename={attachment.filename}
          url={attachment.url}
        />
      );
    }
    case "video": {
      return (
        <VideoThumbnailPreview
          contentType={attachment.contentType}
          filename={attachment.filename}
          url={attachment.url}
        />
      );
    }
    case "file": {
      return (
        <FileThumbnailPreview
          filename={attachment.filename}
          contentType={attachment.contentType}
          onPreview={onPreviewFile}
        />
      );
    }
    default: {
      return null;
    }
  }
}
