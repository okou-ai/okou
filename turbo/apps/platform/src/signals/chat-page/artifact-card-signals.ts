import type { ChatThreadArtifactRun } from "@okouai/api-contracts/contracts/chat-threads";
import type { HostedArtifactKind } from "@okouai/api-contracts/contracts/host";
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
  readonly artifactKind$: Computed<Promise<HostedArtifactKind | undefined>>;
  /** Load state of the card's presented image (the image itself, or a poster). */
  readonly previewImageLoad: ImageLoadSignals;
  readonly previewImageUrl$: Computed<Promise<string | undefined>>;
  readonly text$?: TextPreviewComputed;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
>;

function artifactMetadataUrl(url: string): string {
  const parsed = new URL(publicAttachmentUrl(url), location.origin);
  parsed.hash = "";
  return parsed.href;
}

export function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  artifacts$?: Computed<Promise<ChatThreadArtifactRun[]>>,
): ArtifactSignals {
  const preview = createAttachmentPreviewSignals(descriptor.url, {
    contentType: descriptor.contentType,
  });
  const artifactKind$ = computed(
    async (get): Promise<HostedArtifactKind | undefined> => {
      if (descriptor.kind !== "html" || artifacts$ === undefined) {
        return undefined;
      }
      const runs = await get(artifacts$);
      const url = artifactMetadataUrl(descriptor.url);
      for (const run of runs) {
        const file = run.files.find((candidate) => {
          return (
            artifactMetadataUrl(candidate.url) === url ||
            (candidate.aliasUrl !== undefined &&
              artifactMetadataUrl(candidate.aliasUrl) === url)
          );
        });
        if (file) {
          return file.artifactKind;
        }
      }
      return undefined;
    },
  );
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
    artifactKind$,
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
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>,
): ArtifactCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: ArtifactDescriptor) => {
      return publicAttachmentUrl(descriptor.url);
    },
    (descriptor) => {
      return createArtifactSignals(descriptor, artifacts$);
    },
  );
}
