import { command } from "ccstate";
import { createElement } from "react";
import { EmailConnectPage } from "../../views/okou-page/email-connect-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { i18n } from "../../i18n/index.ts";
import { resetEmailConnection$, watchEmailConnection$ } from "./email.ts";

export const setupEmailConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetEmailConnection$);
    set(updatePage$, createElement(EmailConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.email.title;
      }),
    );
    set(watchEmailConnection$, signal);
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
