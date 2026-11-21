import { command } from "ccstate";
import { updateDocumentTitle$ } from "../document-title.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import { i18n } from "../../i18n/index.ts";

const resetDocumentTitle$ = command(({ set }) => {
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.chat.documentTitle;
    }),
  );
});

export const syncMissingPrimaryThread$ = command(({ set }): void => {
  set(resetDocumentTitle$);
});

/** Keep the document title aligned with the thread. */
export const syncPrimaryThread$ = command(
  ({ set }, meta: ThreadMeta, signal: AbortSignal): void => {
    signal.throwIfAborted();

    set(
      updateDocumentTitle$,
      meta.title ??
        i18n.t(($) => {
          return $.chat.newChat;
        }),
    );
  },
);
