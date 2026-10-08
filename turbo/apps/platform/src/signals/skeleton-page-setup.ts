import { command } from "ccstate";
import { createElement } from "react";
import { DefaultErrorFallback } from "../views/default-error-boundary.tsx";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";

// Never hides the bootstrap skeleton, so the page is only the skeleton.
export const setupSkeletonPage$ = command(({ set }) => {
  set(updatePage$, null);
});

export const setupErrorPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(DefaultErrorFallback));
  await set(hideAppSkeleton$, signal);
});
