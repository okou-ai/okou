import type { ViewerTarget } from "./types.ts";

export interface TabSpace {
  readonly width: number;
  readonly gap: number;
  readonly overflow: number;
}

/** Only admission is data-dependent; CSS owns the admitted tabs' widths. */
export function layoutTabs(
  targets: readonly ViewerTarget[],
  selectedId: string | null,
  space: TabSpace | null,
) {
  // Matches BrowserTab's min-w-14: favicon, close button and their padding.
  const minimum = 56;
  const selected = targets.findIndex((target) => {
    return target.id === selectedId;
  });
  const gap = Math.max(0, space?.gap ?? 0);
  const available = Math.max(0, space?.width ?? 0);
  const needed =
    targets.length * minimum + Math.max(0, targets.length - 1) * gap;
  const overflow = needed > available;
  const budget = Math.max(
    0,
    available - (overflow ? (space?.overflow ?? 0) : 0),
  );
  const count = overflow
    ? Math.min(
        targets.length,
        Math.max(0, Math.floor((budget + gap) / (minimum + gap))),
      )
    : targets.length;
  const visible = targets.slice(0, count);
  // Keep target order and the actual selection; hiding is never remote reordering.
  if (count && selected >= count) {
    visible[count - 1] = targets[selected]!;
  }
  return {
    overflow,
    items: visible.map((target) => {
      return { target };
    }),
  };
}
