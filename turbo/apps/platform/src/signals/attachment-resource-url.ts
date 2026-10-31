import { command, computed, state, type Command, type Computed } from "ccstate";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import {
  resolveArtifactImageTransformOrigin,
  resolveEditableHostedSiteDomain,
} from "../lib/platform-host.ts";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { hostContract } from "@okouai/api-contracts/client/host";
import { clerk$ } from "./auth.ts";
import { webFilesContract } from "@okouai/api-contracts/client/web-files";
import type { ArtifactShareTarget } from "@okouai/api-contracts/contracts/artifact-shares";
import { accept } from "../lib/accept.ts";
import { resolveApiBase } from "./api-base.ts";
import { apiClient$ } from "./api-client.ts";
import { hostedSiteVisibilityChanges$ } from "./hosted-site-visibility-changes.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "./hosted-site-url-changes.ts";

const AUTHENTICATED_FILE_PATH = "/api/web/file-url";

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
  readonly expiresAt: string | null;
  readonly contentType?: string;
  /** Independent screenshot or video poster, resolved separately from HTML. */
  readonly previewImageUrl?: string | null;
  /** Stable resource identity returned while resolving an artifact reference. */
  readonly artifactShareIdentity?: ArtifactShareIdentity;
  /**
   * Stable URL that another viewer can open. A signature cannot be converted
   * into one, so null means no independent sharing address was resolved.
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
        fetchOptions: { cache: "no-store" },
      }),
      [200],
    );
    return {
      token: response.body.url,
      expiresAt: response.body.expiresAt,
      previewImageUrl: response.body.previewImageUrl,
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
  if (URL.canParse(url)) {
    const source = new URL(url);
    const domain = resolveEditableHostedSiteDomain();
    const label = source.hostname.endsWith(`.${domain}`)
      ? source.hostname.slice(0, -domain.length - 1)
      : "";
    if (/^[a-z0-9][a-z0-9-]*$/u.test(label) && !/^(?:pv|ps|sh)-/u.test(label)) {
      const currentSource$ = computed((get) => {
        return currentHostedSiteUrl(url, get(hostedSiteUrlChanges$));
      });
      const revision$ = computed((get) => {
        return get(hostedSiteVisibilityChanges$)[source.origin] ?? null;
      });
      return computed(async (get) => {
        get(revision$);
        const currentSourceUrl = get(currentSource$);
        const currentSource = new URL(currentSourceUrl);
        if (!(await get(clerk$)).user) {
          return null;
        }
        const response = await accept(
          get(apiClient$)(hostContract).sitePreview({
            params: { publicSlug: currentSource.hostname.split(".")[0]! },
            query: { hostname: currentSource.hostname },
            fetchOptions: { cache: "no-store" },
          }),
          [200],
          undefined,
          { showErrorToast: false },
        );
        const resource = new URL(response.body.url);
        resource.pathname = currentSource.pathname;
        resource.search = currentSource.search;
        resource.hash = currentSource.hash;
        return {
          token:
            response.body.expiresAt === null ? currentSourceUrl : resource.href,
          expiresAt: response.body.expiresAt,
          previewImageUrl: response.body.previewImageUrl,
          publicUrl: currentSourceUrl,
        };
      });
    }
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
    return currentHostedSiteUrl(
      (await get(presignedToken$))?.token ?? url,
      get(hostedSiteUrlChanges$),
    );
  });
  const shareUrl$ = computed(async (get) => {
    const token = await get(presignedToken$);
    return token === null
      ? currentHostedSiteUrl(url, get(hostedSiteUrlChanges$))
      : token.publicUrl === null
        ? null
        : currentHostedSiteUrl(token.publicUrl, get(hostedSiteUrlChanges$));
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

export function createAttachmentResourceUrl$(url: string) {
  return createAttachmentPreviewSignals(url).resourceUrl$;
}
