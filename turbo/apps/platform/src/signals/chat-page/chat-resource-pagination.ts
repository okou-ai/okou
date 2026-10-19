import { command, computed, state, type Command } from "ccstate";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";

/** The visible end of an expanded resource list owns its next-page request. */
export function createResourcePagination(
  more$: Command<Promise<void>, [AbortSignal]>,
) {
  const request$ = state<Promise<void>>(Promise.resolve());
  const resetLoad$ = resetSignal();
  const load$ = command(({ set }, signal: AbortSignal) => {
    // Retrying a failed page belongs to the same list lifetime as its observer.
    const request = set(more$, set(resetLoad$, signal));
    set(request$, request);
    return request;
  });
  const endOnRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const root = element.closest<HTMLElement>("[data-resource-scroll]");
      const observer = new IntersectionObserver(
        onDomEventFn(async (entries: IntersectionObserverEntry[]) => {
          if (
            signal.aborted ||
            !entries.some((entry) => {
              return entry.isIntersecting;
            })
          ) {
            return;
          }
          // A new cursor mounts a new sentinel. Never retry a failed page in a loop.
          observer.disconnect();
          await set(load$, signal);
        }),
        { root, rootMargin: "0px 0px 80px 0px" },
      );
      signal.addEventListener(
        "abort",
        () => {
          observer.disconnect();
          set(resetLoad$);
        },
        {
          once: true,
        },
      );
      observer.observe(element);
    }),
  );
  return {
    load$,
    endOnRef$,
    request$: computed((get) => {
      return get(request$);
    }),
  };
}

export type ResourcePagination = ReturnType<typeof createResourcePagination>;
