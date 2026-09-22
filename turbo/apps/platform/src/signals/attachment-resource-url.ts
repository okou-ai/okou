import { command, computed, state, type Command, type Computed } from "ccstate";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { resolveArtifactImageTransformOrigin } from "../lib/platform-host.ts";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import type { ArtifactShareTarget } from "@okouai/api-contracts/contracts/artifact-shares";
import { accept } from "../lib/accept.ts";
import { resolveApiBase } from "./api-base.ts";
import { apiClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/web/download-file";

export function artifactReferenceLookupKey(url: string): string {
  const reference = parseArtifactReference(url, location.origin);
  return reference ? `artifact:${reference.hash}${reference.extension}` : url;
}

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

export interface ArtifactShareIdentity {
  readonly target: ArtifactShareTarget;
  readonly sharedThreadSnapshot?: true;
}

interface AttachmentPresignedToken {
  /** The temporary URL that authorizes this browser to load the resource. */
  readonly token: string;
  readonly expiresAt: string;
  readonly contentType?: string;
  /** Stable reference to the independent screenshot or video poster. */
  readonly previewImageUrl?: string;
  /** Signed bytes served as an attachment, distinct from a hosted preview. */
  readonly downloadUrl?: string;
  /** Stable resource identity returned while resolving an artifact reference. */
  readonly artifactShareIdentity?: ArtifactShareIdentity;
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
      contentType: response.body.contentType,
      previewImageUrl: response.body.previewImageUrl,
      downloadUrl: response.body.downloadUrl,
      artifactShareIdentity: {
        target: response.body.target,
        ...(response.body.sharedThreadSnapshot
          ? { sharedThreadSnapshot: true as const }
          : {}),
      },
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
  if (isAuthenticatedAttachmentUrl(url)) {
    return createWebFilePresignedToken$(url);
  }
  return computed(() => {
    return Promise.resolve(null);
  });
}

interface AttachmentPreviewOptions {
  readonly contentType?: string;
  readonly resolvedToken?: AttachmentPresignedToken;
  readonly thumbnailSize?: {
    readonly width: number;
    readonly height?: number;
  };
}

/** Resolve the authenticated resource once for its owning preview. */
export function createAttachmentPreviewSignals(
  inputUrl: string,
  options: AttachmentPreviewOptions = {},
) {
  const {
    contentType,
    resolvedToken,
    thumbnailSize = { width: 800, height: 720 },
  } = options;
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
    const token = await get(presignedToken$);
    return token === null ? url : token.publicUrl;
  });
  const artifactShareIdentity$ = computed(async (get) => {
    return (await get(presignedToken$))?.artifactShareIdentity ?? null;
  });
  const thumbnailUrl$ = computed(async (get) => {
    const token = await get(presignedToken$);
    return r2ImageTransformUrl(
      await get(resourceUrl$),
      { ...thumbnailSize, contentType: contentType ?? token?.contentType },
      resolveArtifactImageTransformOrigin(),
    );
  });
  return {
    linkUrl$: resourceUrl$,
    presignedToken$,
    resourceUrl$,
    shareUrl$,
    artifactShareIdentity$,
    thumbnailUrl$,
  };
}

export type AttachmentPreviewSignals = ReturnType<
  typeof createAttachmentPreviewSignals
>;

interface AttachmentPreviewSource {
  readonly url: string;
  readonly preview?: AttachmentPreviewSignals;
}

/**
 * Keep one resource-resolution graph with the surface that owns a preview.
 * Callers pass that graph through cards, dialogs, and sidebars; only a caller
 * without an owner yet creates it here.
 */
export function attachmentPreviewSignalsFor(
  source: AttachmentPreviewSource,
): AttachmentPreviewSignals {
  return source.preview ?? createAttachmentPreviewSignals(source.url);
}

interface AttachmentPreviewRegistry {
  /** Get or create the one preview graph owned for a canonical resource URL. */
  readonly register$: Command<
    AttachmentPreviewSignals,
    [AttachmentPreviewSource]
  >;
}

/** A lifecycle-scoped registry for owners that retain multiple previews. */
export function createAttachmentPreviewRegistry(): AttachmentPreviewRegistry {
  const internalPreviewsByUrl$ = state<
    ReadonlyMap<string, AttachmentPreviewSignals>
  >(new Map());
  const register$ = command(
    (
      { get, set },
      source: AttachmentPreviewSource,
    ): AttachmentPreviewSignals => {
      const url = publicAttachmentUrl(source.url);
      const previews = get(internalPreviewsByUrl$);
      const existing = previews.get(url);
      if (existing) {
        return existing;
      }
      const preview = attachmentPreviewSignalsFor({
        url,
        ...(source.preview ? { preview: source.preview } : {}),
      });
      const next = new Map(previews);
      next.set(url, preview);
      set(internalPreviewsByUrl$, next);
      return preview;
    },
  );
  return { register$ };
}

/**
 * The one preview graph an owner holds for the resource it currently shows.
 *
 * {@link createAttachmentPreviewRegistry} writes to the Store, so an owner that
 * only learns its URL while a `computed` runs cannot register there. Resolving
 * inside that `computed` instead rebuilds the graph on every evaluation: a
 * reloaded list reports the same preview image, signs it again, and hands the
 * browser a new URL for bytes it already loaded. The slot keeps the resolved
 * graph with its owner, so the same URL reuses it and only a different URL
 * replaces it. It lives and dies with the owner that created it.
 */
export function createAttachmentPreviewSlot(
  options: AttachmentPreviewOptions = {},
): (url: string) => AttachmentPreviewSignals {
  let resolved: {
    readonly url: string;
    readonly preview: AttachmentPreviewSignals;
  } | null = null;
  return (inputUrl: string): AttachmentPreviewSignals => {
    const url = publicAttachmentUrl(inputUrl);
    if (resolved?.url !== url) {
      resolved = { url, preview: createAttachmentPreviewSignals(url, options) };
    }
    return resolved.preview;
  };
}

export function createAttachmentResourceUrl$(url: string) {
  return createAttachmentPreviewSignals(url).resourceUrl$;
}
