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
  (
    { set },
    card: Extract<MarkdownCardRef, { kind: "artifact" }>,
    signal: AbortSignal,
  ) => {
    const { signals, threadId } = card;
    const { filename, url, kind } = signals;
    const input = { threadId, filename, url, preview: signals };
    switch (kind) {
      case "image": {
        return set(openImageLightbox$, input, signal);
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
