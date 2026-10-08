import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { MailDraftPage } from "../../views/mail-draft/mail-draft-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { mailDraftPageSignals$ } from "./mail-draft-page-state.ts";

export const setupMailDraftPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const signals = get(mailDraftPageSignals$);
    set(
      updatePage$,
      createElement(MailDraftPage, { key: signals?.mailDraftId, signals }),
      "standalone",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.mail.email;
      }),
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
