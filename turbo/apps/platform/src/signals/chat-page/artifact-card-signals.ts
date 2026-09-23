import { computed, type Computed } from "ccstate";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "../text-preview.ts";
import {
  artifactReferenceLookupKey,
  createAttachmentPreviewSignals,
  createAttachmentPreviewSlot,
  isAuthenticatedAttachmentUrl,
  type AttachmentPreviewSignals,
} from "../attachment-resource-url.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { publicAttachmentUrl } from "../../views/okou-page/attachment-url.ts";

export type ArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html"
  | "file";

export interface ArtifactDescriptor {
  readonly filename: string;
  readonly url: string;
  readonly contentType?: string;
  readonly kind: ArtifactKind;
}

export interface ArtifactSignals
  extends ArtifactDescriptor, AttachmentPreviewSignals {
  /** Load state of the card's presented image (the image itself, or a poster). */
  readonly previewImageLoad: ImageLoadSignals;
  readonly previewImageUrl$: Computed<Promise<string | undefined>>;
  readonly text$?: Computed<Promise<string>>;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
>;

export function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
  previewRefreshRevision$?: Computed<number>,
  previewCatalogReady$?: Computed<boolean>,
): ArtifactSignals {
  const preview = createAttachmentPreviewSignals(descriptor.url, {
    contentType: descriptor.contentType,
  });
  const previewImageLoad = createImageLoadSignals();
  // Keep the resolved poster graph with the card. Catalog and file-level
  // refreshes that report the same image reuse its credentials instead of
  // replacing the URL the browser already loaded.
  const previewImageSlot = createAttachmentPreviewSlot();
  let refreshedPreview:
    | {
        readonly revision: number;
        readonly signals: AttachmentPreviewSignals;
      }
    | undefined;
  const previewImageUrl$ = computed(async (get) => {
    if (descriptor.kind !== "html" && descriptor.kind !== "video") {
      return undefined;
    }
    if (isAuthenticatedAttachmentUrl(descriptor.url)) {
      const token = await get(preview.presignedToken$);
      let url = token?.previewImageUrl;
      // A current API returns null when no poster exists. Only an older API
      // omits the field, and its catalog fallback must wait for thread create.
      if (
        url === undefined &&
        (!previewCatalogReady$ || get(previewCatalogReady$))
      ) {
        const previewImageUrlsByUrl = await get(previewImageUrlsByUrl$);
        url = previewImageUrlsByUrl.get(
          artifactReferenceLookupKey(descriptor.url),
        );
      }
      let revision = 0;
      if (!url && previewRefreshRevision$) {
        revision = get(previewRefreshRevision$);
      }
      if (!url && revision > 0) {
        if (refreshedPreview?.revision !== revision) {
          refreshedPreview = {
            revision,
            signals: createAttachmentPreviewSignals(descriptor.url, {
              contentType: descriptor.contentType,
            }),
          };
        }
        url = (await get(refreshedPreview.signals.presignedToken$))
          ?.previewImageUrl;
      }
      return url ? await get(previewImageSlot(url).thumbnailUrl$) : undefined;
    }
    const previewImageUrlsByUrl = await get(previewImageUrlsByUrl$);
    const url =
      previewImageUrlsByUrl.get(artifactReferenceLookupKey(descriptor.url)) ??
      (await get(preview.presignedToken$))?.previewImageUrl;
    return url ? await get(previewImageSlot(url).thumbnailUrl$) : undefined;
  });
  return {
    ...descriptor,
    previewImageLoad,
    previewImageUrl$,
    ...preview,
    ...(isTextPreviewKind(descriptor.kind)
      ? {
          text$: createTextPreviewComputed(
            descriptor.url,
            preview.resourceUrl$,
          ),
        }
      : {}),
  };
}

export function createArtifactCardSignalsRegistry(
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
  previewRefreshRevision$?: Computed<number>,
  previewCatalogReady$?: Computed<boolean>,
): ArtifactCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: ArtifactDescriptor) => {
      return publicAttachmentUrl(descriptor.url);
    },
    (descriptor) => {
      return createArtifactSignals(
        descriptor,
        previewImageUrlsByUrl$,
        previewRefreshRevision$,
        previewCatalogReady$,
      );
    },
  );
}
