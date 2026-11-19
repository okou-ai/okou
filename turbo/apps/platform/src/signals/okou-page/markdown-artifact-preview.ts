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
    { set },
    card: Extract<MarkdownCardRef, { kind: "artifact" }>,
    target: "lightbox" | undefined,
    signal: AbortSignal,
  ) => {
    const { signals, threadId } = card;
    const { filename, url, kind } = signals;
    switch (kind) {
      case "image": {
        await set(
          openImageLightbox$,
          { threadId, url, filename, preview: signals },
          target,
          signal,
        );
        return;
      }
      case "video": {
        await set(
          openVideoLightbox$,
          { threadId, filename, url, preview: signals },
          target,
          signal,
        );
        return;
      }
      case "audio": {
        await set(
          openAudioLightbox$,
          { threadId, filename, url, preview: signals },
          target,
          signal,
        );
        return;
      }
      case "file": {
        await set(
          openFileLightbox$,
          { threadId, filename, url, preview: signals },
          target,
          signal,
        );
        return;
      }
      default: {
        await set(
          openDocumentLightbox$,
          {
            threadId,
            filename,
            url,
            kind,
            preview: signals,
            text$: signals.text$,
          },
          target,
          signal,
        );
      }
    }
  },
);
