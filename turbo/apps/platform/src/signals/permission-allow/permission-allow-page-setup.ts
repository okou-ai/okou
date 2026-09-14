import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { PermissionAllowPage } from "../../views/permission-allow/permission-allow-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupPermissionAllowPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(PermissionAllowPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.permissions.permissions;
      }),
    );

    await set(hideAppSkeleton$, signal);
  },
);
