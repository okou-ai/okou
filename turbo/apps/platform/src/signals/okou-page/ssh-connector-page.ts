import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { SshConnectorPage } from "../../views/okou-page/ssh-connector-page.tsx";
import { refreshSsh$, openSshDialog$, sshConnections$ } from "../ssh.ts";
import { searchParams$, replaceSearchParams$ } from "../route.ts";
import { settle } from "../utils.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupSshConnectorPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(get(searchParams$));
    const add = params.get("add") === "1";
    if (params.has("add")) {
      params.delete("add");
      set(replaceSearchParams$, params);
    }
    set(refreshSsh$);
    set(updatePage$, createElement(SshConnectorPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.ssh.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    if (add) {
      // The rendered page owns load errors; failure must not open a credential form.
      const hosts = await settle(get(sshConnections$), signal);
      signal.throwIfAborted();
      if (hosts.ok && hosts.value?.length === 0) {
        await set(openSshDialog$, "create", null, signal);
      }
    }
  },
);
