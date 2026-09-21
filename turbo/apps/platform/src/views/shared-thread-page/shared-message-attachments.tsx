import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { resolveArtifactImageTransformOrigin } from "../../lib/platform-host.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { shouldUseNativeAnchorNavigation } from "../okou-page/attachment-preview.tsx";
import { FilePreviewIcon } from "../okou-page/file-preview-icon.tsx";
import type { SharedDisplayAttachment } from "./shared-thread-page.tsx";
import { SharedThreadArtifactCard } from "../components/rich-markdown.tsx";

function SharedImageAttachment({
  attachment,
}: {
  readonly attachment: SharedDisplayAttachment;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLoadable(attachment.artifact.resourceUrl$);
  return resourceUrl.state === "hasData" ? (
    <img
      src={r2ImageTransformUrl(
        resourceUrl.data,
        { width: 480, height: 320, contentType: attachment.contentType },
        resolveArtifactImageTransformOrigin(),
      )}
      alt={attachment.filename}
      loading="lazy"
      className="h-40 max-w-full object-contain"
    />
  ) : (
    <span className="flex h-40 w-60 max-w-full items-center justify-center px-3 text-xs text-muted-foreground">
      {resourceUrl.state === "hasError" ? (
        <span role="status">
          {t(($) => {
            return $.artifacts.access.title;
          })}
        </span>
      ) : (
        <span className="h-full w-full animate-pulse bg-muted/30" />
      )}
    </span>
  );
}

/**
 * A prompt attachment the page presents itself. It keeps its own destination
 * for the click that asks for a tab, the way every other preview here does.
 */
function SharedAttachmentLink({
  attachment,
}: {
  readonly attachment: SharedDisplayAttachment;
}) {
  const openPreview = useSet(attachment.artifact.openPreview$);
  const pageSignal = useGet(pageSignal$);
  const isImage = /^image\/(?:png|jpeg|gif|webp|avif|heic|bmp)$/iu.test(
    attachment.contentType,
  );
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      title={attachment.filename}
      aria-label={attachment.filename}
      onClick={(event) => {
        if (shouldUseNativeAnchorNavigation(event)) {
          return;
        }
        event.preventDefault();
        openPreview(attachment.filename, pageSignal);
      }}
      className={
        isImage
          ? "block max-w-full overflow-hidden rounded-md border border-foreground/15 bg-background/80"
          : "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-foreground/15 bg-background/80 px-1.5 transition-colors hover:bg-state-hover"
      }
    >
      {isImage ? (
        <SharedImageAttachment attachment={attachment} />
      ) : (
        <>
          <FilePreviewIcon
            filename={attachment.filename}
            contentType={attachment.contentType}
            size="sm"
            className="shrink-0"
          />
          <span className="min-w-0 max-w-60 truncate text-xs font-medium">
            {attachment.filename}
          </span>
        </>
      )}
    </a>
  );
}

export function SharedMessageAttachments({
  attachments,
}: {
  readonly attachments: readonly SharedDisplayAttachment[];
}) {
  const files = new Map(
    attachments.map((attachment) => {
      return [attachment.url, attachment];
    }),
  );
  return (
    <div className="flex flex-wrap gap-2">
      {[...files.values()].map((attachment) => {
        // A site and a video carry their own card; every other attachment
        // stays the thumbnail or chip the prompt showed.
        return attachment.artifact.kind === "html" ||
          attachment.artifact.kind === "video" ? (
          <SharedThreadArtifactCard
            key={attachment.url}
            signals={attachment.artifact}
            label={attachment.filename}
            compact
          />
        ) : (
          <SharedAttachmentLink key={attachment.url} attachment={attachment} />
        );
      })}
    </div>
  );
}
