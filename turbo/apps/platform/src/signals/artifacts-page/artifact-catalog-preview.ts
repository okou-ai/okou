import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";

import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../chat-page/parse-body-blocks.ts";

interface ArtifactDetailPreview {
  readonly kind: BodyPreviewKind;
  readonly url: string;
  readonly filename: string;
}

/** One preview descriptor shared by the catalog dialog and thread sidebar. */
export function artifactDetailPreview(
  detail: ArtifactDetail,
): ArtifactDetailPreview {
  if (detail.kind === "shared-thread") {
    return {
      kind: "html",
      url: new URL(
        `/share/threads/${encodeURIComponent(detail.sharedThread.id)}`,
        window.location.origin,
      ).toString(),
      filename: detail.title,
    };
  }
  if (detail.kind === "hosted-site" || detail.kind === "presentation") {
    return {
      kind: "html",
      url: detail.site.url,
      filename: detail.title,
    };
  }
  return {
    kind: classifyChatAttachment({
      filename: detail.file.filename,
      url: detail.file.url,
      contentType: detail.file.contentType,
    }),
    url: publicAttachmentUrl(detail.file.url),
    filename: detail.file.filename,
  };
}
