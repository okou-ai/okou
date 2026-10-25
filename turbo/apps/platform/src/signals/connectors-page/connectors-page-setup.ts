import {
  resetRemoteSetup$,
  startComputerSetup$,
  remoteSetup$,
  openRemoteLogin$,
} from "../remote-control-setup.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ConnectorsPage } from "../../views/okou-page/connectors-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { resetConnectorAccountDialogs$ } from "../okou-page/settings/connector-account-dialogs.ts";
import { refreshSsh$ } from "../ssh.ts";
import { closeVncDialog$, invalidateVnc$ } from "../vnc.ts";
import { setupRemoteNetworkEditor$ } from "../remote-network-page-setup.ts";
import { setRemoteControlView$ } from "../okou-page/settings/remote-control-directory.ts";
import { subscribeBuiltinConnectorChanges$ } from "../external/connectors.ts";
import { searchParams$ } from "../route.ts";

export const setupConnectorsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(subscribeBuiltinConnectorChanges$, signal);
    set(resetConnectorAccountDialogs$);
    set(resetRemoteSetup$);
    set(refreshSsh$);
    set(closeVncDialog$);
    set(invalidateVnc$);
    set(setRemoteControlView$, "connections");
    const params = get(searchParams$);
    if (
      params.get("setup") === "computer" &&
      params.get("scope") === "private-network"
    ) {
      set(startComputerSetup$);
    }
    if (get(remoteSetup$)?.step === "login") {
      await set(openRemoteLogin$, signal);
      signal.throwIfAborted();
    }
    const networkInitialization = set(setupRemoteNetworkEditor$, signal);
    set(updatePage$, createElement(ConnectorsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.catalog.title;
      }),
    );
    await networkInitialization;
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);
  },
);
