import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import type { Element, Root } from "hast";
import type { AttachmentPreviewSignals } from "../../signals/attachment-resource-url.ts";
import type { UserMessageRenderDocument } from "../../signals/chat-page/chat-event.ts";

import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import { messageArtifactKey } from "./attachment-url.ts";
import { userMessageFileAttachments } from "../../signals/chat-page/user-message-files.ts";

export type ImageArtifactNavigationItem = {
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly preview?: AttachmentPreviewSignals;
};

export type ImageArtifactNavigation = {
  readonly next?: ImageArtifactNavigationItem;
  readonly previous?: ImageArtifactNavigationItem;
  readonly role?: EventImageGroup["role"];
};

/**
 * Minimal shape of a chat event needed to scope image navigation. Images in an
 * event come from canonical user-message file parts and from its rendered
 * markdown tree: artifact card slots, plain images, and image links.
 */
type EventImageSource = {
  readonly userMessage?: UserMessageDocument;
  readonly userMessageRenderDocument?: UserMessageRenderDocument;
  readonly tree?: Root;
};

type EventImageGroup = {
  readonly role: "user" | "assistant";
  readonly events: readonly EventImageSource[];
};

function isImageDescriptor(descriptor: {
  contentType: string;
  filename: string;
  url: string;
}): boolean {
  return (
    classifyChatAttachment({
      contentType: descriptor.contentType,
      filename: descriptor.filename,
      url: descriptor.url,
    }) === "image"
  );
}

type EventImage = ImageArtifactNavigationItem & {
  readonly descriptor$?: ArtifactSignals["descriptor$"];
};
type AddImage = (
  url: string,
  filename: string,
  preview?: AttachmentPreviewSignals,
  descriptor$?: ArtifactSignals["descriptor$"],
) => void;

// Matches markdown images `![alt](url)` and links `[label](url)`, capturing the
// optional image marker, label/alt text, and url while allowing escaped label
// characters. Agent-generated images can render as markdown image lines or
// media links rather than dedicated preview blocks.
function filenameFromImageUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  return path.split("/").pop() || "image";
}

function isMarkdownImageLinkUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) &&
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:\?|#|$)/i.test(url)
  );
}

function filenameFromMarkdownLink(label: string, url: string): string {
  const text = label.trim();
  if (text.length > 0 && !/^https?:\/\//i.test(text)) {
    return text;
  }
  return filenameFromImageUrl(url);
}

/** Ordered, de-duplicated images (url + filename) shown in a single event. */
function eventImages(event: EventImageSource): EventImage[] {
  const images: EventImage[] = [];
  const seen = new Set<string>();
  const add: AddImage = (url, filename, preview, descriptor$) => {
    if (!seen.has(url)) {
      seen.add(url);
      images.push({ url, filename, preview, descriptor$ });
    }
  };

  for (const file of event.userMessage
    ? userMessageFileAttachments(event.userMessage)
    : []) {
    if (isImageDescriptor(file)) {
      const rendered = event.userMessageRenderDocument?.parts.find((part) => {
        return part.type === "file" && part.signals.url === file.url;
      });
      add(
        file.url,
        file.filename,
        rendered?.type === "file" ? rendered.signals : undefined,
      );
    }
  }
  if (event.tree) {
    visitTreeImages(event.tree, add);
  }
  return images;
}

function nodeText(node: Element): string {
  return node.children
    .map((child) => {
      if (child.type === "text") {
        return child.value;
      }
      return child.type === "element" ? nodeText(child) : "";
    })
    .join("");
}

/** Walks a rendered body for its images: card slots, `<img>`, image links. */
function visitTreeImages(root: Root, add: AddImage): void {
  const visit = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const card = child.data?.card;
      if (card !== undefined) {
        if (card.kind !== "artifact") {
          continue;
        }
        const { url, filename, kind } = card.signals;
        if (kind === "image") {
          add(url, filename, card.signals);
        } else if (kind === "file" && card.signals.artifactReads) {
          add(url, filename, card.signals, card.signals.descriptor$);
        }
        continue;
      }
      if (child.tagName === "img") {
        const src = child.properties.src;
        const alt = child.properties.alt;
        if (typeof src === "string") {
          add(
            src,
            (typeof alt === "string" && alt) || filenameFromImageUrl(src),
          );
        }
        continue;
      }
      if (child.tagName === "a") {
        const href = child.properties.href;
        if (typeof href === "string" && isMarkdownImageLinkUrl(href)) {
          add(href, filenameFromMarkdownLink(nodeText(child), href));
        }
        continue;
      }
      visit(child);
    }
  };
  visit(root);
}

export function eventImageCandidates(events: readonly EventImageSource[]) {
  const candidates = new Map<string, EventImage>();
  for (const event of events) {
    for (const image of eventImages(event)) {
      const id = messageArtifactKey(image.url);
      if (!candidates.has(id)) {
        candidates.set(id, image);
      }
    }
  }
  return [...candidates.values()];
}

/** The clicked occurrence supplies its group even when two messages link to the same image. */
export function currentEventImageArtifactNavigation(
  group: EventImageGroup,
  currentUrl: string,
  images: readonly ImageArtifactNavigationItem[],
): ImageArtifactNavigation {
  const currentId = messageArtifactKey(currentUrl);
  const currentIndex = images.findIndex((item) => {
    return messageArtifactKey(item.url) === currentId;
  });

  if (currentIndex === -1) {
    return {};
  }

  return {
    previous: currentIndex > 0 ? images[currentIndex - 1] : undefined,
    next:
      currentIndex < images.length - 1 ? images[currentIndex + 1] : undefined,
    role: group.role,
  };
}
