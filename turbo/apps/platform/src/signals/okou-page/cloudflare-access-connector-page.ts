import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { CloudflareAccessConnectorPage } from "../../views/okou-page/cloudflare-access-connector-page.tsx";
import {
  cloudflareAccessConfigs$,
  openCloudflareAccessDialog$,
  refreshCloudflareAccess$,
} from "../cloudflare-access.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { settle } from "../utils.ts";

export const setupCloudflareAccessConnectorPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(get(searchParams$));
    const add = params.get("add") === "1";
    if (params.has("add")) {
      params.delete("add");
      set(replaceSearchParams$, params);
    }
    set(refreshCloudflareAccess$);
    set(updatePage$, createElement(CloudflareAccessConnectorPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.cloudflareAccess.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    if (add) {
      const configs = await settle(get(cloudflareAccessConfigs$), signal);
      signal.throwIfAborted();
      if (configs.ok && configs.value?.length === 0) {
        await set(openCloudflareAccessDialog$, "create", null, signal);
      }
    }
  },
);
