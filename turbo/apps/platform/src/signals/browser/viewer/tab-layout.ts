import type { ViewerTarget } from "./types.ts";

export interface TabSpace {
  readonly width: number;
  readonly gap: number;
  readonly overflow: number;
}

/** Body widths exclude the strip's decorative corner gutters. */
export function layoutTabs(
  targets: readonly ViewerTarget[],
  selectedId: string | null,
  interactive: boolean,
  space: TabSpace | null,
) {
  const preferred = 232;
  const minimum = 32;
  const selectedMinimum = interactive ? 48 : minimum;
  const selected = targets.findIndex((target) => {
    return target.id === selectedId;
  });
  const extra = selected === -1 ? 0 : selectedMinimum - minimum;
  const gap = Math.max(0, space?.gap ?? 0);
  const available = Math.max(0, space?.width ?? Infinity);
  const needed =
    targets.length * minimum + Math.max(0, targets.length - 1) * gap + extra;
  const overflow = needed > available;
  const budget = Math.max(0, available - (overflow ? space!.overflow : 0));
  const count = overflow
    ? Math.min(
        targets.length,
        Math.max(0, Math.floor((budget + gap - extra) / (minimum + gap))),
      )
    : targets.length;
  const visible = targets.slice(0, count);
  // Keep target order and the actual selection; hiding is never remote reordering.
  if (count && selected >= count) {
    visible[count - 1] = targets[selected]!;
  }
  const bodySpace = Math.max(0, budget - Math.max(0, count - 1) * gap);
  const equalWidth = Math.min(preferred, bodySpace / Math.max(1, count));
  const protectSelected = selected !== -1 && equalWidth < selectedMinimum;
  const inactiveWidth = protectSelected
    ? (bodySpace - selectedMinimum) / Math.max(1, count - 1)
    : equalWidth;
  return {
    overflow,
    items: visible.map((target) => {
      return {
        target,
        width:
          protectSelected && target.id === selectedId
            ? selectedMinimum
            : inactiveWidth,
      };
    }),
  };
}
