import { command, computed, state } from "ccstate";
import type { ReactNode } from "react";
import { createDeferredPromise, onRef, type DeferredPromise } from "./utils.ts";

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

interface PendingPageCommit {
  readonly previousPage: ReactNode | undefined;
  readonly deferred: DeferredPromise<void>;
}

// A page transition waits for React to render the page that replaces the one
// on screen. Only the latest transition waits; a newer one releases it.
const pendingPageCommit$ = state<PendingPageCommit | undefined>(undefined);

export const releasePageCommit$ = command(({ get, set }) => {
  const pending = get(pendingPageCommit$);
  set(pendingPageCommit$, undefined);
  if (pending && !pending.deferred.settled()) {
    pending.deferred.resolve();
  }
});

export const waitNextPageCommit$ = command(
  ({ get, set }, signal: AbortSignal) => {
    set(releasePageCommit$);
    const deferred = createDeferredPromise<void>(signal);
    set(pendingPageCommit$, { previousPage: get(internalPage$), deferred });
    return deferred.promise;
  },
);

const acknowledgePageCommit$ = command(
  ({ get, set }, page: ReactNode | undefined) => {
    const pending = get(pendingPageCommit$);
    if (pending && page !== pending.previousPage) {
      set(releasePageCommit$);
    }
  },
);

// The element holding the page takes a new ref for every page, so React calls
// it once that page is committed to the DOM, without remounting the page.
export const pageCommitRef$ = computed((get) => {
  const page = get(internalPage$);
  return onRef(
    command(({ set }) => {
      set(acknowledgePageCommit$, page);
    }),
  );
});
