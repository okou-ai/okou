import { command, state, type Command, type Computed } from "ccstate";
import type { TabSpace } from "./viewer/tab-layout.ts";
import { detach, onRef, Reason, waitForBrowserPaint } from "../utils.ts";

export interface TabStripNodes {
  readonly toolbar: HTMLDivElement;
  readonly tabs: HTMLDivElement;
}

/** The host supplies a proved lower bound while its CSS widths are moving. */
export interface TabStripMotion {
  readonly minimumWidth: number;
}

function measureTabStrip(nodes: TabStripNodes): TabSpace | null {
  const budget = nodes.toolbar.querySelector<HTMLElement>(
    "[data-browser-tab-budget]",
  );
  if (!budget) {
    return null;
  }
  const gap = Number.parseFloat(getComputedStyle(nodes.tabs).columnGap) || 0;
  const rowGap = Number.parseFloat(getComputedStyle(budget).columnGap) || 0;
  return {
    width: Math.max(0, budget.getBoundingClientRect().width),
    gap,
    // The fixed size-8 picker is internal to the stable budget, reserved once.
    overflow: 32 + rowGap,
  };
}

/** Host commands and native viewport/DOM lifetimes own tab admission. */
export function createTabStripLayout(
  nodes$: Computed<TabStripNodes | null>,
  resize$: Command<void, [TabSpace]>,
) {
  const motion$ = state<TabStripMotion | null>(null);
  const limit$ = state<number | null>(null);
  const lastSpace$ = state<TabSpace | null>(null);
  const owner$ = state<{
    readonly token: object;
    readonly signal: AbortSignal;
  } | null>(null);
  const sync$ = command(
    ({ get, set }, motion?: TabStripMotion | null): void => {
      // Undefined is a local geometry acknowledgement, not proof of host
      // completion. Only the shared host barrier explicitly unlocks with null.
      if (motion !== undefined) {
        set(motion$, motion);
        if (motion === null) {
          set(limit$, null);
        }
      }
      const nodes = get(nodes$);
      const measured = nodes ? measureTabStrip(nodes) : null;
      if (!nodes || !measured) {
        return;
      }
      let width = measured.width;
      const moving = get(motion$);
      if (moving) {
        const panel = nodes.toolbar.closest<HTMLElement>(
          '[data-sidebar-layout-owner="panel"]',
        );
        // A responsive change can invalidate the desktop split floor while the
        // same transaction is pending. Below xl, zero remains a safe bound.
        const hostWidth = panel?.getBoundingClientRect().width ?? 0;
        const floor =
          panel && getComputedStyle(panel).flexGrow === "0"
            ? Math.min(moving.minimumWidth, hostWidth)
            : 0;
        const conservative = panel
          ? Math.max(0, width - Math.max(0, hostWidth - floor))
          : 0;
        width = Math.min(get(limit$) ?? width, conservative);
        set(limit$, width);
      }
      const previous = get(lastSpace$);
      if (
        !previous ||
        previous.width !== width ||
        previous.gap !== measured.gap ||
        previous.overflow !== measured.overflow
      ) {
        const space = { ...measured, width };
        set(lastSpace$, space);
        set(resize$, space);
      }
    },
  );
  const measureToolbar$ = command(
    async ({ get, set }, owner: object, signal: AbortSignal) => {
      await waitForBrowserPaint(signal);
      if (get(owner$)?.token === owner) {
        set(sync$);
      }
    },
  );
  const toolbarChanged$ = command(({ get, set }) => {
    const owner = get(owner$);
    if (owner) {
      detach(
        set(measureToolbar$, owner.token, owner.signal),
        Reason.DomCallback,
        "browser toolbar geometry",
      );
    }
  });
  // This is the actual fixed-width action group, not a render-commit sentinel.
  // Its removal remeasures against the surviving surface's lifetime.
  const actionsRef$ = onRef(
    command(({ set }, node: HTMLDivElement, signal: AbortSignal) => {
      if (node.isConnected) {
        set(toolbarChanged$);
      }
      signal.addEventListener(
        "abort",
        () => {
          set(toolbarChanged$);
        },
        { once: true },
      );
    }),
  );
  const mount$ = command(({ get, set }, signal: AbortSignal): void => {
    const owner = { token: {}, signal };
    set(owner$, owner);
    set(limit$, null);
    set(lastSpace$, null);
    const refresh = () => {
      if (get(owner$) === owner) {
        set(toolbarChanged$);
      }
    };
    window.addEventListener("resize", refresh, { signal });
    window.visualViewport?.addEventListener("resize", refresh, { signal });
    signal.addEventListener(
      "abort",
      () => {
        if (get(owner$) === owner) {
          set(owner$, null);
          set(limit$, null);
          set(lastSpace$, null);
        }
      },
      { once: true },
    );
    refresh();
  });
  return { sync$, mount$, actionsRef$ };
}
