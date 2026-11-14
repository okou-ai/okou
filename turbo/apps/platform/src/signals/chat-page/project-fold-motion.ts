import { command, computed, state, type Computed } from "ccstate";
import { animationFrame } from "signal-timers";
import { flushSync } from "react-dom";
import {
  collapseProject$,
  expandProject$,
} from "../projects/project-expansion.ts";
import { draggingProjectThread$ } from "../projects/project-thread-drag.ts";
import {
  createDeferredPromise,
  isAbortError,
  onRef,
  resetSignal,
  waitForToken,
} from "../utils.ts";
import type { SidebarChatThreadRow } from "./sidebar-chat-thread-scroll.ts";
import {
  getProjectFoldRange,
  type ProjectFoldGeometry,
} from "./project-fold-geometry.ts";

/** One viewport-owned presentation transaction, never a second logical list. */
export interface ProjectFoldMotion {
  readonly id: string;
  readonly projectId: string;
  readonly logicalRows: readonly SidebarChatThreadRow[];
  readonly expandedRows: readonly SidebarChatThreadRow[];
  readonly geometry: ProjectFoldGeometry;
  readonly range: ReturnType<typeof getProjectFoldRange>;
  readonly running: boolean;
}

interface FoldViewport {
  readonly scrollViewport$: Computed<HTMLElement | null>;
  readonly scrollMetrics$: Computed<{
    readonly scrollTop: number;
    readonly clientHeight: number;
  }>;
}
interface FoldRequest {
  readonly rows$: Computed<readonly SidebarChatThreadRow[]>;
  readonly trailingRow: boolean;
  readonly projectId: string;
  readonly expanded: boolean;
}

function createFoldDomSignals() {
  const internalMotion$ = state<ProjectFoldMotion | null>(null);
  const host$ = state<HTMLElement | null>(null);
  const internalList$ = state<Pick<
    FoldRequest,
    "rows$" | "trailingRow"
  > | null>(null);
  const list$ = computed((get) => {
    return get(internalList$);
  });
  const bindList$ = command(
    ({ set }, rows$: FoldRequest["rows$"], trailingRow: boolean) => {
      set(internalList$, { rows$, trailingRow });
    },
  );
  const restart$ = resetSignal();
  const motion$ = computed((get) => {
    return get(internalMotion$);
  });
  const cancel$ = command(({ get, set }) => {
    if (get(internalMotion$)) {
      set(restart$);
      set(internalMotion$, null);
    }
  });
  const hostRef$ = onRef(
    command(({ get, set }, host: HTMLElement, signal: AbortSignal) => {
      set(host$, host);
      // Child refs attach before the viewport ref, but DOM ancestry already exists.
      const scrollport = host.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      const cancel = () => {
        set(cancel$);
      };
      scrollport?.addEventListener("wheel", cancel, { passive: true, signal });
      scrollport?.addEventListener("touchmove", cancel, {
        passive: true,
        signal,
      });
      scrollport?.addEventListener("dragstart", cancel, { signal });
      window.addEventListener("resize", cancel, { signal });
      window
        .matchMedia("(prefers-reduced-motion: reduce)")
        .addEventListener("change", cancel, { signal });
      signal.addEventListener(
        "abort",
        () => {
          if (get(host$) === host) {
            set(cancel$);
            set(host$, null);
            set(internalList$, null);
          }
        },
        { once: true },
      );
    }),
  );
  return {
    internalMotion$,
    host$,
    list$,
    bindList$,
    restart$,
    motion$,
    cancel$,
    hostRef$,
  };
}
type FoldDomSignals = ReturnType<typeof createFoldDomSignals>;

function createCaptureFoldCommand(dom: FoldDomSignals, rowHeight: number) {
  return command(({ get, set }, request: FoldRequest) => {
    const { rows$, projectId, expanded } = request;
    const before = get(rows$);
    const candidate = get(dom.internalMotion$);
    // A source revision revokes retention; a later input cannot revive it.
    const previous = candidate?.logicalRows === before ? candidate : null;
    const header = before.find((row) => {
      return row.kind === "project" && row.project.id === projectId;
    });
    if (!header || header.kind !== "project") {
      set(dom.cancel$);
      set(expanded ? expandProject$ : collapseProject$, projectId);
      return null;
    }
    if (header.expanded === expanded) {
      return null;
    }
    const host = get(dom.host$);
    const oldBlock = host
      ? [
          ...host.querySelectorAll<HTMLElement>("[data-project-children-id]"),
        ].find((element) => {
          return element.dataset.projectChildrenId === projectId;
        })
      : undefined;
    // Sample displayed geometry once, at reversal intent, before cancellation.
    const fromHeight =
      previous?.projectId === projectId && oldBlock
        ? oldBlock.getBoundingClientRect().height
        : expanded
          ? 0
          : before.filter((row) => {
              return row.projectId === projectId && row.kind !== "project";
            }).length * rowHeight;
    return { previous, before, host, oldBlock, fromHeight };
  });
}
type FoldCapture = NonNullable<
  ReturnType<ReturnType<typeof createCaptureFoldCommand>["write"]>
>;

function createPrepareFoldCommand(
  viewport: FoldViewport,
  dom: FoldDomSignals,
  rowHeight: number,
) {
  return command(
    (
      { get, set },
      request: FoldRequest,
      capture: FoldCapture,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const { rows$, trailingRow, projectId, expanded } = request;
      const { previous, before, host, oldBlock, fromHeight } = capture;
      // ccstate publishes the command's domain/presentation writes together.
      set(dom.internalMotion$, null);
      set(expanded ? expandProject$ : collapseProject$, projectId);
      const logicalRows = get(rows$);
      const expandedRows = expanded
        ? logicalRows
        : previous?.projectId === projectId
          ? previous.expandedRows
          : before;
      const blockStartIndex =
        expandedRows.findIndex((row) => {
          return row.kind === "project" && row.project.id === projectId;
        }) + 1;
      const childCount = expandedRows.filter((row) => {
        return row.projectId === projectId && row.kind !== "project";
      }).length;
      const metrics = get(viewport.scrollMetrics$);
      if (
        !host ||
        !get(viewport.scrollViewport$) ||
        metrics.clientHeight <= 0 ||
        !host.isConnected ||
        (previous !== null && previous.projectId !== projectId) ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.querySelector("[data-chat-thread-menu-thread-id]") ||
        get(draggingProjectThread$) ||
        (oldBlock?.contains(document.activeElement) ?? false)
      ) {
        return null;
      }
      const geometry = {
        blockStartIndex,
        childCount,
        rowHeight,
        fromHeight,
        toHeight: expanded ? childCount * rowHeight : 0,
        totalRowsWithoutChildren:
          expandedRows.length - childCount + (trailingRow ? 1 : 0),
      };
      const range = getProjectFoldRange(geometry, {
        scrollTop: metrics.scrollTop,
        viewportHeight: metrics.clientHeight,
        overscan: 8,
      });
      if (!range.animate) {
        return null;
      }
      const motion: ProjectFoldMotion = {
        id: crypto.randomUUID(),
        projectId,
        logicalRows,
        expandedRows,
        geometry,
        range,
        running: false,
      };
      set(dom.internalMotion$, motion);
      return motion;
    },
  );
}

function waitForFoldFrame(signal: AbortSignal) {
  const frame = createDeferredPromise<void>(signal);
  animationFrame(
    () => {
      frame.resolve();
    },
    { signal },
  );
  return frame.promise;
}

function matchesFoldDom(
  host: HTMLElement,
  block: HTMLElement,
  motion: ProjectFoldMotion,
) {
  const phase = motion.running ? "running" : "prepared";
  const matchesHeight =
    motion.running ||
    Math.abs(
      Number.parseFloat(block.style.height) - motion.geometry.fromHeight,
    ) <= 0.02;
  return (
    matchesHeight &&
    [host, block].every((element) => {
      return (
        element.isConnected &&
        element.dataset.projectFoldId === motion.id &&
        element.dataset.projectFoldState === phase
      );
    })
  );
}

function createRunFoldCommand(dom: FoldDomSignals) {
  return command(
    async (
      { get, set },
      prepared: ProjectFoldMotion,
      host: HTMLElement,
      signal: AbortSignal,
    ) => {
      let transaction = prepared;
      const release = () => {
        if (get(dom.internalMotion$) === transaction) {
          set(dom.internalMotion$, null);
        }
      };
      signal.addEventListener("abort", release, { once: true });
      const finish = () => {
        release();
        if (!signal.aborted) {
          set(dom.restart$);
        }
      };
      await waitForFoldFrame(signal);
      signal.throwIfAborted();
      const list = get(dom.list$);
      if (
        !list ||
        get(list.rows$) !== prepared.logicalRows ||
        get(dom.host$) !== host
      ) {
        finish();
        return;
      }
      const block = [
        ...host.querySelectorAll<HTMLElement>("[data-project-children-id]"),
      ].find((element) => {
        return element.dataset.projectChildrenId === prepared.projectId;
      });
      // Animate only when this command's prepared geometry is actually mounted.
      if (!block || !matchesFoldDom(host, block, prepared)) {
        finish();
        return;
      }
      host.getBoundingClientRect();
      block.getBoundingClientRect();
      await waitForFoldFrame(signal);
      signal.throwIfAborted();
      if (get(list.rows$) !== prepared.logicalRows || get(dom.host$) !== host) {
        finish();
        return;
      }
      transaction = { ...transaction, running: true };
      // This continuation is async: ccstate publishes inside this boundary.
      flushSync(() => {
        set(dom.internalMotion$, transaction);
      });
      signal.throwIfAborted();
      if (
        get(list.rows$) !== prepared.logicalRows ||
        get(dom.host$) !== host ||
        !matchesFoldDom(host, block, transaction)
      ) {
        finish();
        return;
      }
      host.getBoundingClientRect();
      // Native CSS receipts identify these exact height owners. Disabled styles
      // yield no animations; stale events cannot settle a successor. No polling.
      const animations = [host, block].flatMap((element) => {
        return typeof element.getAnimations === "function"
          ? element.getAnimations().filter((animation) => {
              return (
                "transitionProperty" in animation &&
                animation.transitionProperty === "height"
              );
            })
          : [];
      });
      const receipts = await waitForToken(
        Promise.allSettled(
          animations.map((animation) => {
            return animation.finished;
          }),
        ),
        signal,
      );
      signal.throwIfAborted();
      finish();
      for (const receipt of receipts) {
        if (receipt.status === "rejected" && !isAbortError(receipt.reason)) {
          throw receipt.reason;
        }
      }
    },
  );
}

export function createProjectFoldMotionSignals(
  viewport: FoldViewport,
  rowHeight: number,
) {
  const dom = createFoldDomSignals();
  const capture$ = createCaptureFoldCommand(dom, rowHeight);
  const prepare$ = createPrepareFoldCommand(viewport, dom, rowHeight);
  const run$ = createRunFoldCommand(dom);
  const fold$ = command(
    async ({ set }, request: FoldRequest, owner: AbortSignal) => {
      owner.throwIfAborted();
      const capture = set(capture$, request);
      if (!capture) {
        return;
      }
      const signal = set(dom.restart$, owner);
      const prepared = set(prepare$, request, capture, signal);
      if (prepared && capture.host) {
        await set(run$, prepared, capture.host, signal);
      }
    },
  );
  return {
    motion$: dom.motion$,
    list$: dom.list$,
    bindList$: dom.bindList$,
    cancel$: dom.cancel$,
    hostRef$: dom.hostRef$,
    fold$,
  };
}
