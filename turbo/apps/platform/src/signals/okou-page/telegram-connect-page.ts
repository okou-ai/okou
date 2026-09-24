import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { TelegramConnectPage } from "../../views/okou-page/telegram-connect-page.tsx";
import { pollTelegramConnectDomainStatus$ } from "./telegram-connect-signals.ts";

export const setupTelegramConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(TelegramConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.telegram.connectTitle;
      }),
    );
    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(pollTelegramConnectDomainStatus$, signal),
    ]);
  },
);
