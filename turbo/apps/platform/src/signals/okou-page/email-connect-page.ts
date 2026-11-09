import { command } from "ccstate";
import { createElement } from "react";
import { EmailConnectPage } from "../../views/okou-page/email-connect-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { i18n } from "../../i18n/index.ts";
import {
  resetEmailConnection$,
  watchEmailConnection$,
  connectEmailFromLink$,
} from "./email.ts";
import { detach, Reason } from "../utils.ts";

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
    const connection = set(connectEmailFromLink$, signal);
    if (connection) {
      // The route owns continuation; the request loadable presents its result.
      detach(
        connection,
        Reason.Daemon,
        "Connect the original email for this route",
      );
    }
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
  },
);
