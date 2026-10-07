import { command, computed, state } from "ccstate";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import type { PwaPageTransitionDirection } from "./okou-page/pwa-page-transition.ts";

type PageLayout = "sidebar" | "standalone" | "none";

const internalLayout$ = state<PageLayout>("none");
const internalPage$ = state<ReactNode | undefined>(undefined);
const nextPageTransition$ = state<PwaPageTransitionDirection>("none");

export const pageLayout$ = computed((get) => {
  return get(internalLayout$);
});

export const page$ = computed((get) => {
  return get(internalPage$);
});

/** Set by a navigation; the page that navigation renders slides with it. */
export const setNextPageTransition$ = command(
  ({ set }, direction: PwaPageTransitionDirection) => {
    set(nextPageTransition$, direction);
  },
);

export const updatePage$ = command(
  ({ get, set }, page: ReactNode, layout: PageLayout = "none") => {
    const direction = get(nextPageTransition$);
    set(nextPageTransition$, "none");
    const commit = () => {
      set(internalLayout$, layout);
      set(internalPage$, page);
    };
    if (direction === "none") {
      commit();
      return;
    }
    // Like React Router's flushSync mode: the page swap is the transition's
    // update, rendered synchronously so the browser captures the new page.
    document.startViewTransition({
      update: () => {
        flushSync(commit);
      },
      types: [direction],
    });
  },
);
