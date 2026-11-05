import { vi } from "vitest";

/** Supply browser geometry and immediate native scrolling, not CSS visibility. */
export function mockRailBrowserLayout({
  viewportWidth,
  contentWidth,
}: {
  readonly viewportWidth: number;
  readonly contentWidth: number;
}) {
  const widths = new WeakMap<HTMLElement, number>();
  const originalScrollBy = HTMLElement.prototype.scrollBy;

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "rail")
        ? (widths.get(this) ?? viewportWidth)
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("[data-rail], [data-rail-track]") ? contentWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollBy").mockImplementation(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    if (!Object.hasOwn(this.dataset, "rail")) {
      if (typeof options === "number") {
        originalScrollBy.call(this, options, y ?? 0);
      } else {
        originalScrollBy.call(this, options?.left ?? 0, options?.top ?? 0);
      }
      return;
    }
    const distance =
      typeof options === "number" ? options : (options?.left ?? 0);
    this.scrollLeft = Math.max(
      0,
      Math.min(
        this.scrollLeft + distance,
        Math.max(0, this.scrollWidth - this.clientWidth),
      ),
    );
    this.dispatchEvent(new Event("scroll"));
  });

  return {
    setViewportWidth(viewport: HTMLElement, width: number) {
      widths.set(viewport, width);
    },
  };
}

/** Locate a native scrollport and its controls from rendered page content. */
export function renderedRail(content: HTMLElement) {
  const viewport = content.closest<HTMLElement>("[data-rail]");
  const root = viewport?.closest<HTMLElement>("[data-rail-root]");
  if (!viewport || !root) {
    throw new Error("Expected a rail around the rendered content");
  }
  return { viewport, root };
}
