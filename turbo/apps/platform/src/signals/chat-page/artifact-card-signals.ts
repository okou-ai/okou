import type {
  createMessageArtifactDetails,
  MessageArtifactReads,
} from "./chat-artifact-preview.ts";
import { command, computed, type Command, type Computed } from "ccstate";
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
  shouldRefreshArtifactPreview,
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
  readonly artifactReads?: MessageArtifactReads;
  readonly descriptor$: Computed<Promise<ArtifactDescriptor>>;
  /** Load state of the card's presented image (the image itself, or a poster). */
  readonly previewImageLoad: ImageLoadSignals;
  readonly previewImageUrl$: Computed<Promise<string | undefined>>;
  readonly text$?: TextPreviewComputed;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
> & {
  readonly refresh$: Command<void, []>;
};

export function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  artifactReads?: MessageArtifactReads,
): ArtifactSignals {
  const preview = createAttachmentPreviewSignals(descriptor.url, {
    contentType: descriptor.contentType,
    refreshOnArtifactChange: shouldRefreshArtifactPreview(descriptor.kind),
  });
  const descriptor$ = computed(async (get): Promise<ArtifactDescriptor> => {
    if (descriptor.kind !== "file" || !artifactReads) {
      return descriptor;
    }
    const [read] = await Promise.allSettled([get(artifactReads.detail$)]);
    const detail = read.status === "fulfilled" ? read.value : null;
    if (!detail) {
      return descriptor;
    }
    const kind = detail.preview.kind;
    return {
      ...descriptor,
      filename: detail.filename,
      contentType: detail.contentType,
      kind: kind === "website" || kind === "presentation-html" ? "html" : kind,
    };
  });
  const previewImageLoad = createImageLoadSignals();
  const previewImageUrl$ = computed(async (get) => {
    const { kind } =
      descriptor.kind === "file" ? await get(descriptor$) : descriptor;
    if (kind !== "html" && kind !== "video") {
      return undefined;
    }
    let url = (await get(preview.presignedToken$))?.previewImageUrl;
    if (!url && artifactReads) {
      const result = await get(artifactReads.detail$);
      const metadata = result?.preview;
      if (metadata?.kind === "video") {
        url = metadata.posterUrl;
      } else if (metadata && "coverUrl" in metadata) {
        url = metadata.coverUrl;
      }
    }
    return url
      ? await get(createAttachmentPreviewSignals(url).thumbnailUrl$)
      : undefined;
  });
  return {
    ...descriptor,
    descriptor$,
    artifactReads,
    previewImageLoad,
    previewImageUrl$,
    ...preview,
    ...(isTextPreviewKind(descriptor.kind) || descriptor.kind === "file"
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
  details: ReturnType<typeof createMessageArtifactDetails>,
): ArtifactCardSignalsRegistry {
  const registry = createCardSignalsRegistry(
    (entry: {
      descriptor: ArtifactDescriptor;
      reads: MessageArtifactReads;
    }) => {
      return publicAttachmentUrl(entry.descriptor.url);
    },
    ({ descriptor, reads }) => {
      return createArtifactSignals(descriptor, reads);
    },
  );
  return {
    ...registry,
    register$: command(({ set }, descriptor) => {
      return set(registry.register$, {
        descriptor,
        reads: set(details.register$, descriptor.url),
      });
    }),
    refresh$: command(({ get, set }) => {
      for (const artifact of get(registry.values$)) {
        set(artifact.refreshOnArtifactChange$);
      }
    }),
  };
}
