import { computed, type Computed } from "ccstate";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../text-preview.ts";
import {
  createAttachmentPreviewSignals,
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
  readonly text$?: TextPreviewComputed;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
>;

export function createArtifactSignals(
  descriptor: ArtifactDescriptor,
): ArtifactSignals {
  const preview = createAttachmentPreviewSignals(descriptor.url, {
    contentType: descriptor.contentType,
  });
  const previewImageLoad = createImageLoadSignals();
  const previewImageUrl$ = computed(async (get) => {
    if (descriptor.kind !== "html" && descriptor.kind !== "video") {
      return undefined;
    }
    const url = (await get(preview.presignedToken$))?.previewImageUrl;
    return url
      ? await get(createAttachmentPreviewSignals(url).thumbnailUrl$)
      : undefined;
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

export function createArtifactCardSignalsRegistry(): ArtifactCardSignalsRegistry {
  return createCardSignalsRegistry((descriptor: ArtifactDescriptor) => {
    return publicAttachmentUrl(descriptor.url);
  }, createArtifactSignals);
}
