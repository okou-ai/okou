import type { TabSpace } from "./viewer/tab-layout.ts";

/** The committed toolbar owns its geometry subscription, independently of CDP. */
export function observeTabStrip(
  row: HTMLDivElement,
  list: HTMLDivElement,
  resized: (space: TabSpace) => void,
): { refresh: () => void; close: () => void } {
  let active = true;
  const measure = () => {
    if (!active) {
      return;
    }
    const width = list.getBoundingClientRect().width;
    if (!width) {
      return;
    }
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const rowGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    const picker = row.querySelector<HTMLElement>("[data-browser-tab-picker]");
    // The layout policy reserves the picker from the complete tab budget once.
    const pickerWidth = picker
      ? picker.getBoundingClientRect().width + rowGap
      : 0;
    resized({ width: width + pickerWidth, gap, overflow: 32 + rowGap });
  };
  const observer = new ResizeObserver(measure);
  observer.observe(row);
  observer.observe(list);
  measure();
  return {
    refresh: measure,
    close: () => {
      active = false;
      observer.disconnect();
    },
  };
}
