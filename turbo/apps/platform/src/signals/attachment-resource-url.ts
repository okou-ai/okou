import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
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
import { now } from "../lib/time.ts";
import { authenticatedWebFile } from "../lib/message-url.ts";
import { apiClient$ } from "./api-client.ts";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "./hosted-site-url-changes.ts";

export interface ArtifactShareIdentity {
  readonly artifactId?: string;
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
  refreshVersion$: State<number>,
): Computed<Promise<AttachmentPresignedToken | null>> {
  return computed(async (get) => {
    get(refreshVersion$);
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
        ...(response.body.artifactId
          ? { artifactId: response.body.artifactId }
          : {}),
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
  fileId: string,
  refreshVersion$: State<number>,
): Computed<Promise<AttachmentPresignedToken | null>> {
  return computed(async (get) => {
    get(refreshVersion$);
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

function isEditableHostedSiteUrl(source: URL): boolean {
  const domain = resolveEditableHostedSiteDomain();
  const label = source.hostname.endsWith(`.${domain}`)
    ? source.hostname.slice(0, -domain.length - 1)
    : "";
  return /^[a-z0-9][a-z0-9-]*$/u.test(label) && !/^(?:pv|ps|sh)-/u.test(label);
}

function createAttachmentPresignedToken$(
  url: string,
  refreshVersion$: State<number>,
): Computed<Promise<AttachmentPresignedToken | null>> {
  const reference = parseArtifactReference(url, location.origin);
  if (reference) {
    return createArtifactReferencePresignedToken$(reference, refreshVersion$);
  }
  const file = authenticatedWebFile(url);
  if (file) {
    return createWebFilePresignedToken$(file.id, refreshVersion$);
  }
  if (URL.canParse(url)) {
    const source = new URL(url);
    if (isEditableHostedSiteUrl(source)) {
      const currentSource$ = computed((get) => {
        return currentHostedSiteUrl(url, get(hostedSiteUrlChanges$));
      });
      return computed(async (get) => {
        get(refreshVersion$);
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

/** File previews retain their selected version when the catalog changes. */
export function shouldRefreshArtifactPreview(kind: string): boolean {
  return !["markdown", "text", "json", "csv", "pdf", "file"].includes(kind);
}

interface AttachmentPreviewOptions {
  readonly contentType?: string;
  readonly resolvedToken?: AttachmentPresignedToken;
  readonly refreshOnArtifactChange?: boolean;
  readonly thumbnailSize?: {
    readonly width: number;
    readonly height?: number;
  };
}

/** Share resource resolution until its owning preview is refreshed. */
export function createAttachmentPreviewSignals(
  inputUrl: string,
  options: AttachmentPreviewOptions = {},
) {
  const {
    contentType,
    resolvedToken,
    refreshOnArtifactChange = true,
    thumbnailSize = { width: 800, height: 720 },
  } = options;
  const url = publicAttachmentUrl(inputUrl);
  const refreshVersion$ = state(0);
  const refresh$ = command(({ set }) => {
    set(refreshVersion$, (version) => {
      return version + 1;
    });
  });
  const refreshOnArtifactChange$ = command(({ set }) => {
    if (refreshOnArtifactChange) {
      set(refresh$);
    }
  });
  const presignedToken$ = resolvedToken
    ? computed(() => {
        return Promise.resolve(resolvedToken);
      })
    : createAttachmentPresignedToken$(url, refreshVersion$);
  const refreshOnOpen$ = command(
    async (
      { get, set },
      content$: Computed<Promise<unknown>> | undefined,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (refreshOnArtifactChange) {
        return;
      }
      const [resolution] = await Promise.allSettled([get(presignedToken$)]);
      signal.throwIfAborted();
      const expiresAt =
        resolution.status === "fulfilled" ? resolution.value?.expiresAt : null;
      // Preserve successful previews; deliberate reopening can retry failures.
      if (
        resolution.status === "rejected" ||
        (expiresAt !== null &&
          expiresAt !== undefined &&
          Date.parse(expiresAt) <= now())
      ) {
        set(refresh$);
        return;
      }
      if (content$) {
        const [content] = await Promise.allSettled([get(content$)]);
        signal.throwIfAborted();
        if (content.status === "rejected") {
          set(refresh$);
        }
      }
    },
  );
  const resourceUrl$ = computed(async (get) => {
    get(refreshVersion$);
    return currentHostedSiteUrl(
      (await get(presignedToken$))?.token ?? url,
      get(hostedSiteUrlChanges$),
    );
  });
  const shareUrl$ = computed(async (get) => {
    // A canonical share address does not depend on a temporary preview grant.
    if (
      !resolvedToken &&
      URL.canParse(url) &&
      isEditableHostedSiteUrl(new URL(url))
    ) {
      return currentHostedSiteUrl(url, get(hostedSiteUrlChanges$));
    }
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
  const imageUrl$ = computed(async (get) => {
    const source = await get(resourceUrl$);
    const token = await get(presignedToken$);
    const type = (contentType ?? token?.contentType)
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    const genericType =
      !type || type === "application/octet-stream" || type === "image/*";
    const isHeic =
      type === "image/heic" ||
      (genericType &&
        URL.canParse(source) &&
        /\.heic$/iu.test(new URL(source).pathname));
    // Convert HEIC for browsers without a native decoder, at its original
    // dimensions rather than the thumbnail size. Downloads keep resourceUrl$.
    return isHeic
      ? r2ImageTransformUrl(
          source,
          { contentType: "image/heic" },
          resolveArtifactImageTransformOrigin(),
        )
      : source;
  });
  return {
    refresh$,
    refreshOnArtifactChange$,
    refreshOnOpen$,
    linkUrl$: resourceUrl$,
    presignedToken$,
    resourceUrl$,
    imageUrl$,
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
  readonly contentType?: string;
  readonly refreshOnArtifactChange?: boolean;
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
  return (
    source.preview ??
    createAttachmentPreviewSignals(source.url, {
      contentType: source.contentType,
      refreshOnArtifactChange: source.refreshOnArtifactChange,
    })
  );
}

interface AttachmentPreviewRegistry {
  /** Refresh mutable previews without reloading retained file versions. */
  readonly refresh$: Command<void, []>;
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
        contentType: source.contentType,
        refreshOnArtifactChange: source.refreshOnArtifactChange,
        ...(source.preview ? { preview: source.preview } : {}),
      });
      const next = new Map(previews);
      next.set(url, preview);
      set(internalPreviewsByUrl$, next);
      return preview;
    },
  );
  const refresh$ = command(({ get, set }) => {
    for (const preview of get(internalPreviewsByUrl$).values()) {
      set(preview.refreshOnArtifactChange$);
    }
  });
  return { register$, refresh$ };
}

export function createAttachmentResourceUrl$(url: string) {
  return createAttachmentPreviewSignals(url).resourceUrl$;
}
