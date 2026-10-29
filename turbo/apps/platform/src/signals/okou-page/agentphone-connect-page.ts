import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { AgentPhoneConnectPage } from "../../views/okou-page/agentphone-connect-page.tsx";
import {
  reloadAgentPhoneConnectStatus$,
  isWhatsappConnectPage$,
} from "./agentphone-connect-signals.ts";
import {
  reloadAgentPhoneLinkStatus$,
  watchAgentPhoneConnection$,
} from "./agentphone.ts";

import {
  reloadWhatsappLinkStatus$,
  watchWhatsappConnection$,
} from "./whatsapp.ts";

export const setupAgentPhoneConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const whatsapp = get(isWhatsappConnectPage$);
    set(reloadAgentPhoneConnectStatus$);
    set(whatsapp ? reloadWhatsappLinkStatus$ : reloadAgentPhoneLinkStatus$);
    set(updatePage$, createElement(AgentPhoneConnectPage));
    set(
      updateDocumentTitle$,
      whatsapp
        ? i18n.t(($) => {
            return $.works.whatsapp.connect;
          })
        : i18n.t(($) => {
            return $.connectors.providerConnect.agentphone.documentTitle;
          }),
    );
    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(
        whatsapp ? watchWhatsappConnection$ : watchAgentPhoneConnection$,
        signal,
      ),
    ]);
  },
);
