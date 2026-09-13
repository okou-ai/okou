import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Element, Root } from "hast";
import type { AttachmentPreviewSignals } from "../../signals/attachment-resource-url.ts";
import type { UserMessageRenderDocument } from "../../signals/chat-page/chat-event.ts";

import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import { artifactPreviewUrlsMatch } from "./attachment-url.ts";
import { userMessageFileAttachments } from "../../signals/chat-page/user-message-files.ts";

export type ImageArtifactNavigationItem = {
  readonly url: string;
  readonly filename: string;
  readonly preview?: AttachmentPreviewSignals;
  /**
   * Present when the image is a run artifact (agent-generated / hosted): carries
   * the artifact file and its run so the lightbox keeps full download/share/sync
   * metadata. Absent for human-uploaded images, which resolve from the user
   * artifacts bucket and are not part of the thread's run artifacts.
   */
  readonly artifact?: {
    readonly file: ChatThreadArtifactFile;
    readonly runId: string;
  };
};

type ImageArtifactNavigation = {
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

type EventImage = {
  readonly url: string;
  readonly filename: string;
  readonly preview?: AttachmentPreviewSignals;
};

type ArtifactImageMetadata = {
  readonly file: ChatThreadArtifactFile;
  readonly runId: string;
};

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
  const add = (
    url: string,
    filename: string,
    preview?: AttachmentPreviewSignals,
  ): void => {
    if (!seen.has(url)) {
      seen.add(url);
      images.push({ url, filename, preview });
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
function visitTreeImages(
  root: Root,
  add: (
    url: string,
    filename: string,
    preview?: AttachmentPreviewSignals,
  ) => void,
): void {
  const visit = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const card = child.data?.card;
      if (card !== undefined) {
        if (card.kind === "artifact" && card.signals.kind === "image") {
          add(card.signals.url, card.signals.filename, card.signals);
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

function eventHasImageUrl(
  event: EventImageSource,
  currentUrl: string,
): boolean {
  return eventImages(event).some((image) => {
    return artifactPreviewUrlsMatch(image.url, currentUrl);
  });
}

function scopedEventImages(events: readonly EventImageSource[]): EventImage[] {
  const images: EventImage[] = [];
  for (const event of events) {
    for (const image of eventImages(event)) {
      if (
        images.some((candidate) => {
          return artifactPreviewUrlsMatch(candidate.url, image.url);
        })
      ) {
        continue;
      }
      images.push(image);
    }
  }
  return images;
}

type EventImageScope = {
  readonly images: readonly EventImage[];
  readonly role: EventImageGroup["role"];
};

function imageScopes(groups: readonly EventImageGroup[]): EventImageScope[] {
  return groups.flatMap((group) => {
    const images = scopedEventImages(group.events);
    return images.length > 0 ? [{ images, role: group.role }] : [];
  });
}

export function equalEventImageGroups(
  previous: readonly EventImageGroup[],
  next: readonly EventImageGroup[],
): boolean {
  if (previous === next) {
    return true;
  }
  const previousScopes = imageScopes(previous);
  const nextScopes = imageScopes(next);
  return (
    previousScopes.length === nextScopes.length &&
    previousScopes.every((scope, scopeIndex) => {
      const nextScope = nextScopes[scopeIndex];
      return (
        nextScope !== undefined &&
        scope.role === nextScope.role &&
        scope.images.length === nextScope.images.length &&
        scope.images.every((image, imageIndex) => {
          const nextImage = nextScope.images[imageIndex];
          return (
            nextImage !== undefined &&
            image.url === nextImage.url &&
            image.filename === nextImage.filename &&
            image.preview === nextImage.preview
          );
        })
      );
    })
  );
}

function artifactMetadataForUrl(
  artifacts: readonly ArtifactImageMetadata[],
  url: string,
): ArtifactImageMetadata | undefined {
  return artifacts.find((artifact) => {
    return artifactPreviewUrlsMatch(artifact.file.url, url);
  });
}

/**
 * Navigate image previews within the displayed image scope for `currentUrl`.
 * The rendered chat event group is the scope boundary, so agent and human
 * events use the same rule: extract the images visible in the group that
 * contains the current image. Run artifacts only enrich metadata when
 * available; generated/hosted artifacts that live in the run but are not shown
 * in rendered events are excluded.
 */
export function currentEventImageArtifactNavigation(
  runs: readonly ChatThreadArtifactRun[],
  groups: readonly EventImageGroup[],
  currentUrl: string,
): ImageArtifactNavigation {
  const group = groups.find((candidateGroup) => {
    return candidateGroup.events.some((event) => {
      return eventHasImageUrl(event, currentUrl);
    });
  });

  if (!group) {
    return {};
  }

  const artifacts: ArtifactImageMetadata[] = [];
  for (const run of runs) {
    for (const file of run.files) {
      artifacts.push({ file, runId: run.runId });
    }
  }

  const images: ImageArtifactNavigationItem[] = scopedEventImages(
    group.events,
  ).map((image) => {
    const artifact = artifactMetadataForUrl(artifacts, image.url);
    if (artifact) {
      return {
        url: image.url,
        preview: image.preview,
        filename: artifact.file.filename,
        artifact,
      };
    }
    return image;
  });
  const currentIndex = images.findIndex((item) => {
    return artifactPreviewUrlsMatch(item.url, currentUrl);
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

/** Whether an editable control (where arrow keys move a cursor/selection) is focused. */
function isEditableElementFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  return (
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "SELECT" ||
    active.isContentEditable
  );
}

/**
 * Whether an arrow-key event should be ignored for image navigation.
 *
 * Modifier/hotkey combinations are always ignored. The focus guard — skip
 * navigation while an editable control (input/textarea/select/contenteditable)
 * is focused, so arrow keys keep moving the caret — is only applied when
 * `considerFocus` is true. Callers pass `considerFocus: false` for immersive
 * surfaces (the lightbox modal and the fullscreen sidebar) where arrow keys
 * should always navigate regardless of focus.
 */
export function shouldIgnoreImageArtifactNavigationKey(
  event: KeyboardEvent,
  options: { considerFocus: boolean } = { considerFocus: true },
): boolean {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return true;
  }

  if (!options.considerFocus) {
    return false;
  }

  return isEditableElementFocused();
}
