import { command } from "ccstate";
import type { Element, Root } from "hast";

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
    eventId: string,
  ) => {
    const visitNode = (node: Root | Element, insideLink: boolean): void => {
      for (const child of node.children) {
        if (child.type !== "element" || child.data?.card) {
          continue;
        }
        if (child.tagName === "video") {
          const poster = artifactDescriptor(child.properties.poster);
          if (poster) {
            child.data = {
              ...child.data,
              videoPosterPreview: set(registry.register$, poster),
            };
          }
        }
        const descriptor = markdownArtifact(child);
        if (descriptor) {
          child.data = {
            ...child.data,
            card: {
              kind: "artifact",
              signals: set(registry.register$, descriptor),
              threadId,
              eventId,
            },
            ...(child.tagName === "img" && insideLink
              ? { imageInsideLink: true }
              : undefined),
          };
        }
        visitNode(child, insideLink || child.tagName === "a");
      }
    };
    visitNode(tree, false);
  },
);
