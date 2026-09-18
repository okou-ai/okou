import { command } from "ccstate";
import type { Element, Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

import type { AttachmentPreviewSignals } from "../attachment-resource-url.ts";
import type {
  ArtifactCardSignalsRegistry,
  ArtifactDescriptor,
} from "./artifact-card-signals.ts";
import {
  classifyChatAttachment,
  isPreviewableChatUrl,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";

declare module "hast" {
  interface Data {
    /** A video's poster resolves separately from its playback source. */
    videoPosterPreview?: AttachmentPreviewSignals;
  }
}

function artifactDescriptor(url: unknown): ArtifactDescriptor | undefined {
  if (typeof url !== "string" || !isPreviewableChatUrl(url)) {
    return undefined;
  }
  const attachment = previewAttachmentFromUrl(url);
  return { ...attachment, kind: classifyChatAttachment(attachment) };
}

function markdownArtifact(node: Element): ArtifactDescriptor | undefined {
  const url =
    node.tagName === "a"
      ? node.properties.href
      : node.tagName === "img"
        ? node.properties.src
        : undefined;
  return artifactDescriptor(url);
}

/** Resource identity is shared; each occurrence keeps its Markdown tag and label. */
export const embedMarkdownArtifacts$ = command(
  (
    { set },
    tree: Root,
    registry: ArtifactCardSignalsRegistry,
    threadId: string,
  ) => {
    visit(tree, "element", (node) => {
      if (node.data?.card) {
        return SKIP;
      }
      if (node.tagName === "video") {
        const poster = artifactDescriptor(node.properties.poster);
        if (poster) {
          node.data = {
            ...node.data,
            videoPosterPreview: set(registry.register$, poster),
          };
        }
      }
      const descriptor = markdownArtifact(node);
      if (descriptor) {
        node.data = {
          ...node.data,
          card: {
            kind: "artifact",
            signals: set(registry.register$, descriptor),
            threadId,
          },
        };
      }
      return undefined;
    });
  },
);
