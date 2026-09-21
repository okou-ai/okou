import { command } from "ccstate";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { writeHostedPublicationZip } from "../lib/hosted-publication-zip.ts";
import {
  downloadAttachmentUrl,
  triggerBlobDownload,
} from "../views/okou-page/attachment-url.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { logger } from "./log.ts";
import { settle } from "./utils.ts";

const log = logger("okou-attachment-download");

type AttachmentDownload = {
  readonly filename: string;
  readonly url: string;
};

/**
 * List the publication an artifact reference points at.
 *
 * `403` and `404` are the documented misses for this viewer: a reference that
 * does not name hosted content, and a publication whose files this viewer may
 * not clone even though it may open the artifact. Both leave the artifact on
 * the single-resource download path. The same `404` covers an API deployed
 * before the additive `files` route (#35220); see the PR's `Fallbacks` section.
 * Every other status is a failed required operation and propagates, because
 * delivering the entry document alone would silently misrepresent the
 * publication.
 */
const hostedPublication$ = command(
  async (
    { get },
    attachment: AttachmentDownload,
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse | null> => {
    const reference = parseArtifactReference(attachment.url, location.origin);
    if (!reference) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(artifactDownloadsContract).files({
        params: { reference: `${reference.hash}${reference.extension}` },
        fetchOptions: { signal },
      }),
      [200, 403, 404],
      signal,
      // This path owns one `downloadFailed` toast for every way it can fail.
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    return response.status === 200 ? response.body : null;
  },
);

/**
 * Read the publication from the host that already serves it to this viewer.
 * Those responses carry the delivery host's cross-origin grant, while the
 * manifest's storage URLs are signed for server-side reads only.
 */
async function writePublicationArchive(
  site: HostedSiteFilesResponse,
  resourceUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  const chunks: Uint8Array[] = [];
  const complete = await writeHostedPublicationZip(
    {
      members: site.files,
      baseUrl: resourceUrl,
      write: (chunk) => {
        chunks.push(chunk);
      },
    },
    signal,
  );
  if (!complete) {
    return false;
  }
  triggerBlobDownload(
    new Blob(chunks as BlobPart[], { type: "application/zip" }),
    `${site.publicSlug}.zip`,
  );
  return true;
}

/**
 * A hosted publication is a directory, so its entry document alone would leave
 * the stylesheets, scripts, images and sibling pages it references behind. A
 * publication of more than one file downloads as a zip of all of them; a
 * self-contained page stays the page itself.
 *
 * Returns false only when this artifact is not a publication to archive, which
 * hands it to the single-resource download. Once the archive is owed, every
 * way it can fail — an unreadable member, a listing this viewer should have
 * been able to read, a network or CORS failure — reports `downloadFailed`
 * rather than quietly delivering the entry document this change exists to stop
 * delivering.
 */
const downloadHostedPublication$ = command(
  async (
    { set },
    args: {
      readonly attachment: AttachmentDownload;
      readonly resourceUrl: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const attempt = await settle(
      (async (): Promise<boolean | null> => {
        const site = await set(hostedPublication$, args.attachment, signal);
        if (!site || site.files.length < 2) {
          return null;
        }
        return await writePublicationArchive(site, args.resourceUrl, signal);
      })(),
      signal,
    );
    if (attempt.ok && attempt.value === null) {
      return false;
    }
    if (!attempt.ok) {
      log.warn(
        "downloadHostedPublication: publication unavailable",
        attempt.error,
      );
    }
    if (!attempt.ok || !attempt.value) {
      toast.error(
        i18n.t(($) => {
          return $.artifacts.toasts.downloadFailed;
        }),
      );
    }
    return true;
  },
);

/**
 * Resolve private uploaded files through the authenticated signing endpoint
 * before fetching their bytes. Public artifact URLs pass through unchanged.
 */
export const downloadAttachment$ = command(
  async (
    { get, set },
    attachment: AttachmentDownload,
    signal: AbortSignal,
  ): Promise<void> => {
    const preview = createAttachmentPreviewSignals(attachment.url);
    const [resourceUrl, shareUrl, identity] = await Promise.all([
      get(preview.resourceUrl$),
      get(preview.shareUrl$),
      get(preview.artifactShareIdentity$),
    ]);
    signal.throwIfAborted();
    if (
      identity?.target.kind === "html" &&
      (await set(
        downloadHostedPublication$,
        { attachment, resourceUrl },
        signal,
      ))
    ) {
      return;
    }
    await downloadAttachmentUrl(
      resourceUrl,
      signal,
      attachment.filename,
      classifyChatAttachment({
        filename: attachment.filename,
        url: resourceUrl,
      }) === "file"
        ? "native"
        : "blob",
      shareUrl === null ? "default" : "reload",
    );
  },
);
