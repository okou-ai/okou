import { command } from "ccstate";
import { createElement } from "react";
import { HalloweenOperationsPage } from "../../views/halloween/halloween-operations.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { initializeHalloweenOperations$ } from "./halloween-operations.ts";

export const setupHalloweenOperationsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updateDocumentTitle$, "Halloween participant review");
    set(updatePage$, createElement(HalloweenOperationsPage), "standalone");
    await set(hideAppSkeleton$, signal);
    await set(initializeHalloweenOperations$, signal);
  },
);
