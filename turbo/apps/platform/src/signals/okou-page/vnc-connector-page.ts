import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { VncConnectorPage } from "../../views/okou-page/vnc-connector-page.tsx";
import { refreshVnc$, openVncDialog$, vncConnections$ } from "../vnc.ts";
import { searchParams$, replaceSearchParams$ } from "../route.ts";
import { settle } from "../utils.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupVncConnectorPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(get(searchParams$));
    const add = params.get("add") === "1";
    if (params.has("add")) {
      params.delete("add");
      set(replaceSearchParams$, params);
    }
    set(refreshVnc$);
    set(updatePage$, createElement(VncConnectorPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.vnc.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    if (add) {
      const hosts = await settle(get(vncConnections$), signal);
      signal.throwIfAborted();
      if (hosts.ok && hosts.value?.length === 0) {
        await set(openVncDialog$, "create", null, signal);
      }
    }
  },
);
