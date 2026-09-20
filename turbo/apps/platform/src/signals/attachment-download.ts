import { command } from "ccstate";
import { zipSync } from "fflate";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { fetchResource } from "../lib/resource-fetch.ts";
import {
  downloadAttachmentUrl,
  triggerBlobDownload,
} from "../views/okou-page/attachment-url.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import { classifyChatAttachment } from "./chat-page/parse-body-blocks.ts";
import { createAttachmentPreviewSignals } from "./attachment-resource-url.ts";
import { tapError } from "./utils.ts";

type AttachmentDownload = {
  readonly filename: string;
  readonly url: string;
};

/**
 * List the publication an artifact reference points at. A reference that does
 * not resolve to hosted content, or a publication this viewer may not clone,
 * leaves the artifact on the single-resource download path, which reports its
 * own failure.
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
    const response = await tapError(
      accept(
        get(apiClient$)(artifactDownloadsContract).files({
          params: { reference: `${reference.hash}${reference.extension}` },
          fetchOptions: { signal },
        }),
        [200, 403, 404],
        signal,
        { showErrorToast: false },
      ),
    );
    signal.throwIfAborted();
    return response?.status === 200 ? response.body : null;
  },
);

/**
 * Read the publication from the host that already serves it to this viewer.
 * Those responses carry the delivery host's cross-origin grant, while the
 * manifest's storage URLs are signed for server-side reads only.
 */
async function hostedPublicationArchive(
  site: HostedSiteFilesResponse,
  resourceUrl: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of site.files) {
    const response = await tapError(
      fetchResource(
        new URL(file.path, resourceUrl),
        { cache: "reload", mode: "cors" },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!response?.ok) {
      return null;
    }
    const content = await response.arrayBuffer();
    signal.throwIfAborted();
    entries[file.path.replace(/^\/+/u, "")] = new Uint8Array(content);
  }
  return new Blob([zipSync(entries)], { type: "application/zip" });
}

/**
 * A hosted publication is a directory, so its entry document alone would leave
 * the stylesheets, scripts, images and sibling pages it references behind. A
 * publication of more than one file downloads as a zip of all of them; a
 * self-contained page stays the page itself.
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
    const site = await set(hostedPublication$, args.attachment, signal);
    if (!site || site.files.length < 2) {
      return false;
    }
    const archive = await hostedPublicationArchive(
      site,
      args.resourceUrl,
      signal,
    );
    if (!archive) {
      // This publication is known to have members that did not arrive, and its
      // entry document would misrepresent it, so report the failure instead.
      toast.error(
        i18n.t(($) => {
          return $.artifacts.toasts.downloadFailed;
        }),
      );
      return true;
    }
    triggerBlobDownload(archive, `${site.publicSlug}.zip`);
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
