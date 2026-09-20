import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { ExportPage } from "../../views/export-page/export-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { initializeUserExport$ } from "./export-page-signals.ts";

export const setupExportPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(initializeUserExport$, signal);
    set(updatePage$, createElement(ExportPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.settings.export.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
