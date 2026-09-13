import { computed, type Computed } from "ccstate";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { resolveArtifactImageTransformOrigin } from "../lib/platform-host.ts";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { accept } from "../lib/accept.ts";
import { resolveApiBase } from "./api-base.ts";
import { apiClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/web/download-file";

export function isAuthenticatedAttachmentUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.origin === new URL(resolveApiBase()).origin &&
    parsed.pathname === AUTHENTICATED_FILE_PATH
  );
}

interface AttachmentPresignedToken {
  /** The temporary URL that authorizes this browser to load the resource. */
  readonly token: string;
  readonly expiresAt: string;
  /**
   * Stable URL that another viewer can open. A signature cannot be converted
   * into one, so null means that the attachment remains private.
   */
  readonly publicUrl: string | null;
}

interface ArtifactReference {
  readonly hash: string;
  readonly extension: string;
  readonly fragment: string;
}

function withFragment(url: string, fragment: string): string {
  const parsed = new URL(url);
  parsed.hash = fragment;
  return parsed.href;
}

function createArtifactReferencePresignedToken$(
  reference: ArtifactReference,
): Computed<Promise<AttachmentPresignedToken | null>> {
  return computed(async (get) => {
    const response = await accept(
      get(apiClient$)(artifactReferencesContract).resolve({
        params: { reference: `${reference.hash}${reference.extension}` },
        fetchOptions: { cache: "no-store" },
      }),
      [200],
    );
    return {
      token: withFragment(response.body.url, reference.fragment),
      expiresAt: response.body.expiresAt,
      publicUrl: null,
    };
  });
}

function createPrivateHostedPresignedToken$(
  url: string,
  deploymentId: string,
): Computed<Promise<AttachmentPresignedToken | null>> {
  return computed(async (get) => {
    const response = await accept(
      get(apiClient$)(hostContract).privatePreview({
        params: { deploymentId },
      }),
      [200],
    );
    return {
      token: withFragment(response.body.url, new URL(url).hash),
      expiresAt: response.body.expiresAt,
      publicUrl: null,
    };
  });
}

function createWebFilePresignedToken$(
  url: string,
): Computed<Promise<AttachmentPresignedToken | null>> {
  return computed(async (get) => {
    const sourceUrl = new URL(url);
    const fileId = sourceUrl.searchParams.get("file_id");
    if (!fileId) {
      throw new Error("Authenticated attachment URL is missing file_id");
    }
    const client = get(apiClient$)(webFilesContract);
    const response = await accept(
      client.fileUrl({
        query: { file_id: fileId },
      }),
      [200],
    );
    return {
      token: response.body.url,
      expiresAt: response.body.expiresAt,
      publicUrl: response.body.publicUrl,
    };
  });
}

function createAttachmentPresignedToken$(
  url: string,
): Computed<Promise<AttachmentPresignedToken | null>> {
  const reference = parseArtifactReference(url, location.origin);
  if (reference) {
    return createArtifactReferencePresignedToken$(reference);
  }
  const deploymentId = privateHostedDeploymentId(url, resolveApiBase());
  if (deploymentId) {
    return createPrivateHostedPresignedToken$(url, deploymentId);
  }
  if (isAuthenticatedAttachmentUrl(url)) {
    return createWebFilePresignedToken$(url);
  }
  return computed(() => {
    return Promise.resolve(null);
  });
}

/**
 * Persisted chat attachments live behind an authenticated API route, and a bare
 * `src` attribute cannot carry an Authorization header. Exchange the canonical
 * API URL for a temporary token after the API has checked ownership. Public
 * addresses need no token and pass through unchanged.
 */
export function createAttachmentPreviewSignals(
  inputUrl: string,
  resolvedToken?: AttachmentPresignedToken,
) {
  const url = publicAttachmentUrl(inputUrl);
  const presignedToken$ = resolvedToken
    ? computed(() => {
        return Promise.resolve(resolvedToken);
      })
    : createAttachmentPresignedToken$(url);
  const resourceUrl$ = computed(async (get) => {
    return (await get(presignedToken$))?.token ?? url;
  });
  const shareUrl$ = computed(async (get) => {
    const presigned = await get(presignedToken$);
    return presigned === null ? url : presigned.publicUrl;
  });
  const thumbnailUrl$ = computed(async (get) => {
    return r2ImageTransformUrl(
      await get(resourceUrl$),
      { width: 800, height: 720 },
      resolveArtifactImageTransformOrigin(),
    );
  });
  return {
    presignedToken$,
    resourceUrl$,
    shareUrl$,
    thumbnailUrl$,
  };
}

export type AttachmentPreviewSignals = ReturnType<
  typeof createAttachmentPreviewSignals
>;

export function createAttachmentResourceUrl$(url: string) {
  return createAttachmentPreviewSignals(url).resourceUrl$;
}
