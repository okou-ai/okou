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
    target?: "lightbox",
  ) => {
    const { signals, threadId } = card;
    const { filename, url, kind } = signals;
    switch (kind) {
      case "image": {
        set(
          openImageLightbox$,
          { threadId, url, filename, preview: signals },
          target,
        );
        return;
      }
      case "video": {
        set(openVideoLightbox$, { filename, url }, target);
        return;
      }
      case "audio": {
        set(openAudioLightbox$, { filename, url }, target);
        return;
      }
      case "file": {
        set(openFileLightbox$, { filename, url }, target);
        return;
      }
      default: {
        set(
          openDocumentLightbox$,
          {
            filename,
            url,
            kind,
            text$: signals.text$,
          },
          target,
        );
      }
    }
  },
);
