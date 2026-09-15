import { command } from "ccstate";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { resolveApiBase } from "./api-base.ts";
import { isAuthenticatedAttachmentUrl } from "./attachment-resource-url.ts";
import { pageVersion$ } from "./page-signal.ts";
import { onRejection } from "./utils.ts";

interface ArtifactShareSelection {
  readonly url: string;
  readonly audience: Exclude<ArtifactShareStatus["audience"], "private">;
}

function artifactSharingTarget(url: string): ArtifactShareTarget | null {
  const id = privateHostedDeploymentId(url, resolveApiBase());
  if (id) {
    return { kind: "html", id };
  }
  if (!isAuthenticatedAttachmentUrl(url)) {
    return null;
  }
  const fileId = new URL(url).searchParams.get("file_id");
  return fileId ? { kind: "file", id: fileId } : null;
}

export function isShareableArtifactReference(url: string): boolean {
  return (
    parseArtifactReference(url, location.origin) !== null ||
    artifactSharingTarget(url) !== null
  );
}

const resolveSharingTarget$ = command(
  async ({ get }, url: string, signal: AbortSignal) => {
    const reference = parseArtifactReference(url, location.origin);
    if (!reference) {
      return artifactSharingTarget(url);
    }
    const response = await accept(
      get(apiClient$)(artifactReferencesContract).resolve({
        params: { reference: `${reference.hash}${reference.extension}` },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200],
      signal,
    );
    return response.body.target;
  },
);

const artifactShareUrl$ = command(
  async ({ get, set }, args: ArtifactShareSelection, signal: AbortSignal) => {
    signal.throwIfAborted();
    const pageVersion = get(pageVersion$);
    const target = await set(resolveSharingTarget$, args.url, signal);
    if (!target) {
      return null;
    }
    const { body: status } = await accept(
      get(apiClient$)(artifactSharesContract).status({
        body: target,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    if (get(pageVersion$) !== pageVersion) {
      return null;
    }
    if (
      status.url &&
      status.audience === args.audience &&
      status.selectedTarget &&
      status.selectedVersion === status.candidateVersion &&
      // A current API explicitly reports null until the owner allocates the
      // short organization link or named site URL. Older APIs omit the field.
      // #32492 retires the absent-field reader after old APIs leave serving
      // and rollback; the legacy response stays until the App floor advances.
      !(
        (args.audience === "organization" || target.kind === "html") &&
        status.shortUrl === null
      )
    ) {
      return status.shortUrl ?? status.url;
    }
    const response = await accept(
      get(apiClient$)(artifactSharesContract).update({
        body: { target, audience: args.audience },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (get(pageVersion$) !== pageVersion) {
      return null;
    }
    return response.body.shortUrl ?? response.body.url;
  },
);

export const shareArtifact$ = command(
  async ({ set }, selection: ArtifactShareSelection, signal: AbortSignal) => {
    signal.throwIfAborted();
    const toastId = toast.loading(
      i18n.t(($) => {
        return $.artifacts.toasts.sharing;
      }),
    );
    const dismissLoadingToast = () => {
      toast.dismiss(toastId);
      signal.removeEventListener("abort", dismissLoadingToast);
    };
    signal.addEventListener("abort", dismissLoadingToast, { once: true });
    const shareUrl = await onRejection(
      set(artifactShareUrl$, selection, signal),
      dismissLoadingToast,
    );
    signal.throwIfAborted();
    if (!shareUrl) {
      dismissLoadingToast();
      return;
    }
    await onRejection(
      copyAttachmentLinkToClipboard(shareUrl, toastId, signal),
      dismissLoadingToast,
    );
    signal.throwIfAborted();
    signal.removeEventListener("abort", dismissLoadingToast);
  },
);
