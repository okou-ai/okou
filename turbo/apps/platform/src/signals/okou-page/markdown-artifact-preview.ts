import { command } from "ccstate";

import type { MarkdownCardRef } from "../chat-page/markdown-card-ref.ts";
import {
  openAudioLightbox$,
  openDocumentLightbox$,
  openFileLightbox$,
  openImageLightbox$,
  openVideoLightbox$,
} from "./attachment-chips.ts";

/** Links use the same preview commands and resource state as artifact cards. */
export const openMarkdownArtifact$ = command(
  async (
    { get, set },
    card: Extract<MarkdownCardRef, { kind: "artifact" }>,
    signal: AbortSignal,
  ) => {
    const { signals, threadId } = card;
    const current = signals.artifactReads
      ? set(signals.artifactReads.beginOpen$, signal)
      : signal;
    const { url } = signals;
    // A reference may omit its extension. The detail discriminant selects the reader.
    const [read] =
      signals.kind === "file" && signals.artifactReads
        ? await Promise.allSettled([get(signals.artifactReads.detail$)])
        : [];
    current.throwIfAborted();
    const result = read?.status === "fulfilled" ? read.value : null;
    const type = result?.preview.kind;
    const kind =
      type === "website" || type === "presentation-html"
        ? "html"
        : (type ?? signals.kind);
    const input = {
      threadId,
      filename: result?.filename ?? signals.filename,
      contentType: result?.contentType ?? signals.contentType,
      url,
      preview: signals,
    };
    switch (kind) {
      case "image": {
        return set(
          openImageLightbox$,
          { ...input, sourceEventId: card.eventId },
          signal,
        );
      }
      case "video": {
        return set(openVideoLightbox$, input, signal);
      }
      case "audio": {
        return set(openAudioLightbox$, input, signal);
      }
      case "file": {
        return set(openFileLightbox$, input, signal);
      }
      default: {
        return set(
          openDocumentLightbox$,
          { ...input, kind, text$: signals.text$ },
          signal,
        );
      }
    }
  },
);
