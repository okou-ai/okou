import { command } from "ccstate";
import { isTextPreviewKind } from "../text-preview.ts";

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
    const display =
      signals.kind === "file" ? await get(signals.descriptor$) : signals;
    current.throwIfAborted();
    const { kind, filename, contentType } = display;
    const input = {
      threadId,
      filename,
      contentType,
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
          {
            ...input,
            kind,
            text$: isTextPreviewKind(kind) ? signals.text$ : undefined,
          },
          signal,
        );
      }
    }
  },
);
