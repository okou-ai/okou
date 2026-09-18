import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { resolveArtifactImageTransformOrigin } from "../../lib/platform-host.ts";
import { FilePreviewIcon } from "../okou-page/file-preview-icon.tsx";
import type { SharedDisplayAttachment } from "./shared-thread-page.tsx";

function SharedImageAttachment({
  attachment,
}: {
  readonly attachment: SharedDisplayAttachment;
}) {
  const { t } = useTranslation();
  const resourceUrl = useLoadable(attachment.preview.resourceUrl$);
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
        const isImage = /^image\/(?:png|jpeg|gif|webp|avif|heic|bmp)$/iu.test(
          attachment.contentType,
        );
        return (
          <a
            key={attachment.url}
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            title={attachment.filename}
            aria-label={attachment.filename}
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
      })}
    </div>
  );
}
