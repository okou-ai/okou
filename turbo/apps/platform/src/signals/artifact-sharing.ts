import { command, computed, state } from "ccstate";
import {
  artifactReferencePath,
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { accept } from "../lib/accept.ts";
import { copyAttachmentLinkToClipboard } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { resolveApiBase } from "./api-base.ts";
import { isAuthenticatedAttachmentUrl } from "./attachment-resource-url.ts";
import { resetSignal, withCleanup } from "./utils.ts";

function artifactSharingTarget(url: string): ArtifactShareTarget | null {
  const id = privateHostedDeploymentId(url, resolveApiBase());
  if (id) return { kind: "html", id };
  if (!isAuthenticatedAttachmentUrl(url)) return null;
  const fileId = new URL(url).searchParams.get("file_id");
  return fileId ? { kind: "file", id: fileId } : null;
}

export function isShareableArtifactReference(url: string): boolean {
  return (
    parseArtifactReference(url, location.origin) !== null ||
    artifactSharingTarget(url) !== null
  );
}

interface ShareRequest {
  readonly key: string;
  readonly url: string;
  readonly copyUrl?: string;
}
const request$ = state<ShareRequest | null>(null);
const reload$ = state(0);
const resetShareSignal$ = resetSignal();

export const artifactShareRequest$ = computed((get) => {
  return get(request$);
});

export const artifactShareDetails$ = computed(async (get) => {
  const request = get(request$);
  get(reload$);
  if (!request) return null;
  const client = get(apiClient$);
  const reference = parseArtifactReference(request.url, location.origin);
  const target = reference
    ? (
        await accept(
          client(artifactReferencesContract).resolve({
            params: { reference: `${reference.hash}${reference.extension}` },
            fetchOptions: { cache: "no-store" },
          }),
          [200],
        )
      ).body.target
    : artifactSharingTarget(request.url);
  if (!target) return null;
  // The owner-only status endpoint is the authority. A successful resolve grants
  // viewing, while 404 here means this viewer cannot manage the share.
  const result = await accept(
    client(artifactSharesContract).status({ body: target }),
    [200, 404],
  );
  const status = result.status === 200 ? result.body : null;
  const copyUrl = new URL(
    status
      ? reference
        ? request.url
        : artifactReferencePath(target.id)
      : (request.copyUrl ?? request.url),
    location.origin,
  );
  if (status) copyUrl.hash = reference?.fragment ?? "";
  const audience =
    status?.selectedTarget && status.selectedTarget.id !== target.id
      ? "private"
      : status?.audience;
  return { request, target, status, audience, copyUrl: copyUrl.href };
});

export const closeArtifactShare$ = command(({ set }) => {
  set(resetShareSignal$);
});

export const openArtifactShare$ = command(
  async ({ get, set }, request: ShareRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    const operation = set(resetShareSignal$, signal);
    operation.addEventListener(
      "abort",
      () => {
        return set(request$, null);
      },
      {
        once: true,
      },
    );
    set(request$, request);
    const details = await get(artifactShareDetails$);
    signal.throwIfAborted();
    operation.throwIfAborted();
    if (details && !details.status) {
      await copyAttachmentLinkToClipboard(
        details.copyUrl,
        undefined,
        operation,
      );
      signal.throwIfAborted();
      set(closeArtifactShare$);
    }
  },
);

export const refreshArtifactShare$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reload$, (value) => {
      return value + 1;
    });
    await get(artifactShareDetails$);
    signal.throwIfAborted();
  },
);

export const changeArtifactAudience$ = command(
  async (
    { get, set },
    audience: ArtifactShareStatus["audience"],
    signal: AbortSignal,
  ) => {
    const details = await get(artifactShareDetails$);
    signal.throwIfAborted();
    if (!details?.status || get(request$) !== details.request) return;
    if (
      details.audience === audience &&
      (audience === "private" ||
        details.status.selectedVersion === details.status.candidateVersion)
    )
      return;
    await withCleanup(
      accept(
        get(apiClient$)(artifactSharesContract).update({
          body: { target: details.target, audience },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      () => {
        return set(reload$, (value) => {
          return value + 1;
        });
      },
    );
    signal.throwIfAborted();
    await get(artifactShareDetails$);
    signal.throwIfAborted();
  },
);

export const copyArtifactShare$ = command(
  async ({ get }, signal: AbortSignal) => {
    const details = await get(artifactShareDetails$);
    signal.throwIfAborted();
    if (details?.status && get(request$) === details.request) {
      await copyAttachmentLinkToClipboard(details.copyUrl, undefined, signal);
    }
  },
);
