import { command, state } from "ccstate";
import { onRef } from "../utils.ts";

interface MountedRail {
  readonly track: HTMLElement;
  readonly root: HTMLElement;
  readonly identity: object;
  readonly contentRevision: string;
}

// Physical scrollports, not business rail names, isolate composers and dialogs.
// The registry belongs to each Store; immutable entries retain a mount identity
// so even a late cleanup cannot unregister a replacement owner of that element.
const mountedRails$ = state<ReadonlyMap<HTMLElement, MountedRail>>(new Map());

function publishRailOffset(element: HTMLElement, root: HTMLElement): void {
  root.style.setProperty(
    "--rail-scroll-offset",
    `${String(element.scrollLeft)}px`,
  );
}

const refreshRailContent$ = command(({ get }, element: HTMLElement) => {
  const rail = get(mountedRails$).get(element);
  if (!rail) {
    return;
  }
  // The max-content track includes its own padding, even when it fits or the
  // viewport is temporarily zero-width. The viewport has no horizontal padding
  // or border, so its client box matches the root's query-container width.
  const width = rail.track.scrollWidth;
  rail.root.style.setProperty("--rail-content-width", `${String(width)}px`);
  // The committed extent can clamp/resnap the browser's position. Publish that
  // actual position now as well; do not wait for a later native scroll event.
  publishRailOffset(element, rail.root);
});

/**
 * Receipts an explicit content request after its DOM commit. Unrelated renders
 * and duplicate acknowledgements do not read geometry. The revision describes
 * actual rendered content, never a pending catalog request, so retained data
 * cannot acknowledge a response that has not been rendered yet.
 */
export const commitRailContent$ = command(
  ({ get, set }, element: HTMLElement, contentRevision: string) => {
    const rails = get(mountedRails$);
    const rail = rails.get(element);
    if (
      !rail ||
      element.dataset.railContentRevision !== contentRevision ||
      rail.contentRevision === contentRevision
    ) {
      return;
    }
    set(
      mountedRails$,
      new Map(rails).set(element, { ...rail, contentRevision }),
    );
    set(refreshRailContent$, element);
  },
);

/** Owns native events and the mount's initial content measurement. */
export const bindRail$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    const contentRevision = element.dataset.railContentRevision;
    const root = element.closest<HTMLElement>("[data-rail-root]");
    const track = element.querySelector<HTMLElement>("[data-rail-track]");
    if (contentRevision === undefined || !root || !track) {
      throw new Error("A rail requires a content revision, root and track");
    }
    const identity = {};
    set(
      mountedRails$,
      new Map(get(mountedRails$)).set(element, {
        track,
        root,
        identity,
        contentRevision,
      }),
    );
    element.addEventListener(
      "scroll",
      () => {
        publishRailOffset(element, root);
      },
      { passive: true, signal },
    );
    // Explicit external metric boundaries: fonts can change auto-width labels;
    // browser viewport/zoom changes can change used rem/gap rounding even on a
    // fixed-frame track. Read only content extent, never the viewport width.
    // Local sidebar transitions need neither this event nor frame sampling.
    const refreshExternalMetrics = () => {
      set(refreshRailContent$, element);
    };
    for (const event of ["loadingdone", "loadingerror"] as const) {
      element.ownerDocument.fonts.addEventListener(
        event,
        refreshExternalMetrics,
        { signal },
      );
    }
    element.ownerDocument.defaultView?.addEventListener(
      "resize",
      refreshExternalMetrics,
      { signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        const rails = get(mountedRails$);
        if (rails.get(element)?.identity === identity) {
          const remaining = new Map(rails);
          remaining.delete(element);
          set(mountedRails$, remaining);
        }
      },
      { once: true },
    );
    set(refreshRailContent$, element);
  }),
);

/** A page retains 64px of overlap, using the viewport at click time. */
const RAIL_PAGE_OVERLAP = 64;

export function pageRail(element: HTMLElement, side: "back" | "forward"): void {
  const step = Math.max(element.clientWidth - RAIL_PAGE_OVERLAP, 1);
  element.scrollBy({ left: side === "back" ? -step : step });
}
