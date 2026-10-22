import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { PermissionBatchPage } from "../../views/permission-allow/permission-batch-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { permissionBatchPageSignals$ } from "./permission-batch-page-signals.ts";

export const setupPermissionBatchPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await get(permissionBatchPageSignals$);
    signal.throwIfAborted();
    set(updatePage$, createElement(PermissionBatchPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.permissions.permissions;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
