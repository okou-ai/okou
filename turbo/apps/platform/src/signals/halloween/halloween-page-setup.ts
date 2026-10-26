import { command } from "ccstate";
import { createElement } from "react";
import { HalloweenPage } from "../../views/halloween/halloween-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { initializeHalloween$ } from "./halloween.ts";
import { HalloweenOperationsPage } from "../../views/halloween/halloween-operations.tsx";
import { initializeHalloweenOperations$ } from "./halloween-operations.ts";

export const setupHalloweenOperationsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updateDocumentTitle$, "Halloween participant review");
    set(updatePage$, createElement(HalloweenOperationsPage), "standalone");
    await set(hideAppSkeleton$, signal);
    await set(initializeHalloweenOperations$, signal);
  },
);

export const setupHalloweenPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updateDocumentTitle$, "A treat from Okou · Halloween");
    set(updatePage$, createElement(HalloweenPage), "standalone");
    await set(hideAppSkeleton$, signal);
    await set(initializeHalloween$, signal);
  },
);
