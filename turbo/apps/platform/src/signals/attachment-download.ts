import { command } from "ccstate";
import { artifactDownloadsContract } from "@okouai/api-contracts/client/artifact-downloads";
import { hostContract } from "@okouai/api-contracts/client/host";
import { isHostedSiteDocument } from "@okouai/api-contracts/validators/host";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../lib/accept.ts";
import { writeHostedPublicationZip } from "../lib/hosted-publication-zip.ts";
import {
  downloadAttachmentUrl,
  triggerBlobDownload,
} from "../views/okou-page/attachment-url.ts";
import { i18n } from "../i18n/index.ts";
import { apiClient$ } from "./api-client.ts";
import {
  classifyChatAttachment,
  isHostedSiteUrl,
} from "./chat-page/parse-body-blocks.ts";
import { attachmentDownloadSource$ } from "./attachment-download-source.ts";
import { logger } from "./log.ts";
import { settle } from "./utils.ts";

const log = logger("okou-attachment-download");

type AttachmentDownload = {
  readonly filename: string;
  readonly url: string;
};

function hostedPublicationUrl(url: string): URL | null {
  if (!isHostedSiteUrl(url)) {
    return null;
  }
  const parsed = new URL(url);
  // Match hosted navigation, including extensionless SPA routes. Direct asset
  // links still download one file; the manifest disambiguates extensionless files.
  const documentPath =
    /\.html?$/iu.test(parsed.pathname) ||
    (!/\.[A-Za-z0-9]+$/u.test(parsed.pathname) &&
      !parsed.pathname.startsWith("/assets/"));
  if (parsed.username || parsed.password || parsed.port || !documentPath) {
    return null;
  }
  return parsed;
}

/**
 * List the publication an artifact reference or public site URL points at.
 *
 * `401`, `403` and `404` are the documented misses for this viewer: a reference that
 * does not name hosted content, and a publication whose files this viewer may
 * not clone even though it may open the artifact (including anonymous viewers).
 * These leave the artifact on
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
    siteUrl: URL | null,
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse | null> => {
    const reference = parseArtifactReference(attachment.url, location.origin);
    const response = reference
      ? await accept(
          get(apiClient$)(artifactDownloadsContract).files({
            params: { reference: `${reference.hash}${reference.extension}` },
            fetchOptions: { signal },
          }),
          [200, 401, 403, 404],
          signal,
          { showErrorToast: false },
        )
      : siteUrl
        ? await accept(
            get(apiClient$)(hostContract).files({
              params: { publicSlug: siteUrl.hostname.split(".")[0] },
              // The hostname selects published bytes, not an owner's private draft.
              query: { hostname: siteUrl.hostname },
              fetchOptions: { signal },
            }),
            [200, 401, 403, 404],
            signal,
            // This path owns one downloadFailed toast for every way it can fail.
            { showErrorToast: false },
          )
        : null;
    signal.throwIfAborted();
    return response?.status === 200 ? response.body : null;
  },
);

/**
 * Read the publication from the host that already serves it to this viewer.
 * Those responses carry the delivery host's cross-origin grant, while the
 * manifest's storage URLs are signed for server-side reads only. Revocable
 * Site download URLs are browser-readable and authorize each member separately.
 */
async function writePublicationArchive(
  site: HostedSiteFilesResponse,
  resourceUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  const chunks: Uint8Array[] = [];
  const complete = await writeHostedPublicationZip(
    {
      members: site.files.map((file) => {
        const url = new URL(file.downloadUrl);
        const grant =
          isHostedSiteUrl(file.downloadUrl) &&
          /^\/\.okou\/download\/[a-f0-9]{48}$/u.test(url.pathname);
        return { ...file, ...(grant ? { deliveryUrl: file.downloadUrl } : {}) };
      }),
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
    signal,
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
      readonly siteUrl: URL | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const attempt = await settle(
      (async (): Promise<boolean | null> => {
        const site = await set(
          hostedPublication$,
          args.attachment,
          args.siteUrl,
          signal,
        );
        if (!site || site.files.length < 2) {
          return null;
        }
        // Hosted delivery decodes paths and removes empty segments, so /image/
        // and /%69mage can both name an extensionless non-HTML member.
        const requestedPath = args.siteUrl
          ? `/${decodeURIComponent(args.siteUrl.pathname).split("/").filter(Boolean).join("/")}`
          : null;
        const requestedFile = site.files.find((file) => {
          return file.path === requestedPath;
        });
        if (requestedFile && !isHostedSiteDocument(requestedFile)) {
          return null;
        }
        const publicationUrl = site.artifactUrl
          ? hostedPublicationUrl(site.artifactUrl)
          : null;
        // Pin public aliases to the listed deployment. Private references and
        // shared aliases retain their authorized delivery URL.
        const resourceUrl =
          args.siteUrl &&
          publicationUrl?.hostname.startsWith(`dpl-${site.deploymentId}.`)
            ? publicationUrl.href
            : args.resourceUrl;
        return await writePublicationArchive(site, resourceUrl, signal);
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
 * Authorize each download independently of its preview. Signed attachments
 * use browser delivery; unmanaged URLs retain the CORS-readable blob path.
 */
export const downloadAttachment$ = command(
  async (
    { set },
    attachment: AttachmentDownload,
    signal: AbortSignal,
  ): Promise<void> => {
    const source = await set(attachmentDownloadSource$, attachment.url, signal);
    const { resourceUrl, hosted } = source;
    const siteUrl =
      hostedPublicationUrl(attachment.url) ?? hostedPublicationUrl(resourceUrl);
    if (
      (hosted || siteUrl) &&
      (await set(
        downloadHostedPublication$,
        { attachment, resourceUrl, siteUrl },
        signal,
      ))
    ) {
      return;
    }
    await downloadAttachmentUrl(
      source.kind === "managed" ? source.downloadUrl : resourceUrl,
      signal,
      attachment.filename,
      source.kind === "managed" ||
        classifyChatAttachment({
          filename: attachment.filename,
          url: resourceUrl,
        }) === "file"
        ? "native"
        : "blob",
    );
  },
);
