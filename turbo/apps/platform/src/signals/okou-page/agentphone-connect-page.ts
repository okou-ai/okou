import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { AgentPhoneConnectPage } from "../../views/okou-page/agentphone-connect-page.tsx";
import { reloadAgentPhoneConnectStatus$ } from "./agentphone-connect-signals.ts";
import {
  reloadAgentPhoneLinkStatus$,
  watchAgentPhoneConnection$,
} from "./agentphone.ts";

export const setupAgentPhoneConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(reloadAgentPhoneConnectStatus$);
    set(reloadAgentPhoneLinkStatus$);
    set(updatePage$, createElement(AgentPhoneConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.documentTitle;
      }),
    );
    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(watchAgentPhoneConnection$, signal),
    ]);
  },
);
