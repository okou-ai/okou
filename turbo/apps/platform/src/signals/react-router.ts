import { command, computed, state } from "ccstate";
import type { ReactNode } from "react";

type PageLayout = "sidebar" | "standalone" | "none";

const internalLayout$ = state<PageLayout>("none");
const internalPage$ = state<ReactNode | undefined>(undefined);

export const pageLayout$ = computed((get) => {
  return get(internalLayout$);
});

export const page$ = computed((get) => {
  return get(internalPage$);
});

export const updatePage$ = command(
  ({ set }, page: ReactNode, layout: PageLayout = "none") => {
    set(internalLayout$, layout);
    set(internalPage$, page);
  },
);
