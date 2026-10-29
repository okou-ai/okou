import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { vi } from "vitest";

/** Supply the browser layout that happy-dom does not calculate. */
export function mockTaskChipLayout(initialWidth: number) {
  let width = initialWidth;
  let labelWidth = 110;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalStyle = window.getComputedStyle.bind(window);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.taskChoices !== undefined ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.taskSizingItem !== undefined) {
        return new DOMRect(0, 0, labelWidth, 36);
      }
      if (this.dataset.moreSizing !== undefined) {
        return new DOMRect(0, 0, 80, 36);
      }
      return originalRect.call(this);
    },
  );
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (
      element instanceof HTMLElement &&
      element.dataset.taskSizing !== undefined
    ) {
      const style = document.createElement("div").style;
      Object.assign(style, {
        columnGap: "8px",
        paddingLeft: "4px",
        paddingRight: "4px",
      });
      return style;
    }
    return originalStyle(element, pseudo);
  });
  return {
    setWidth(next: number) {
      width = next;
    },
    setLabelWidth(next: number) {
      labelWidth = next;
    },
  };
}

export function taskMenuItem(label: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!item) {
    throw new Error(`Expected task menu item ${label}`);
  }
  return item;
}
