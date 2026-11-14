import { describe, expect, it, vi } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  captureTextReadingAnchor,
  measureTextReadingAnchor,
} from "../chat-text-reading-anchor.ts";

const context = testContext();

function fixture(html: string) {
  const container = document.createElement("div");
  const event = document.createElement("article");
  event.innerHTML = html;
  container.append(event);
  document.body.append(container);
  context.signal.addEventListener(
    "abort",
    () => {
      container.remove();
    },
    { once: true },
  );
  vi.spyOn(container, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(container, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 100, 600, 200),
  );
  return { container, event };
}

function element(root: Element, selector: string): HTMLElement {
  const result = root.querySelector<HTMLElement>(selector);
  if (!result) {
    throw new Error(`Missing fixture element: ${selector}`);
  }
  return result;
}

function blockGeometry(block: Element, top: number, height: number) {
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, top, 500, height),
  );
}

function glyphGeometry(measure: (range: Range) => DOMRect | null) {
  return vi
    .spyOn(Range.prototype, "getClientRects")
    .mockImplementation(function (this: Range) {
      const rect = measure(this);
      const rects = rect ? [rect] : [];
      return Object.assign(rects, {
        item(index: number) {
          return rects[index] ?? null;
        },
      });
    });
}

function lineRect(top: number): DOMRect {
  return new DOMRect(10, top, 10, 20);
}

describe("text reading anchors", () => {
  it("prefers the next complete paragraph over a clipped paragraph tail", () => {
    const { container, event } = fixture(
      '<div data-chat-selection-source><p id="clipped">Earlier paragraph.</p><p id="whole">  Complete paragraph.</p></div>',
    );
    const clipped = element(event, "#clipped");
    blockGeometry(clipped, 60, 100);
    blockGeometry(element(event, "#whole"), 180, 40);
    glyphGeometry((range) => {
      return lineRect(clipped.contains(range.startContainer) ? 120 : 180);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.offset).toBe("Earlier paragraph.  ".length);
    expect(bookmark?.viewportOffsetTop).toBe(80);
    expect(bookmark).toStrictEqual({
      offset: expect.any(Number),
      contextStart: expect.any(Number),
      contextLength: expect.any(Number),
      contextHash: expect.any(Number),
      viewportOffsetTop: 80,
    });
  });

  it("finds the first fully visible line inside one enormous clipped paragraph", () => {
    const { container, event } = fixture(
      `<div data-chat-selection-source><p>${"x".repeat(10_000)}</p></div>`,
    );
    blockGeometry(element(event, "p"), -1905, 20_000);
    const geometry = glyphGeometry((range) => {
      return lineRect(-1905 + Math.floor(range.startOffset / 10) * 20);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    // Line 100 is partly clipped (top 95), line 101 starts at 115.
    expect(bookmark?.offset).toBe(1010);
    expect(bookmark?.viewportOffsetTop).toBe(15);
    expect(geometry.mock.calls.length).toBeLessThan(40);
  });

  it("filters controls, hidden subtrees and text outside selection sources", () => {
    const { container, event } = fixture(
      '<p>Outside prose</p><div data-chat-selection-source><p><button>Copy</button><span hidden>Hidden</span><span aria-hidden="true">Icon</span><span style="display:none">Display</span><span style="visibility:hidden">Visibility</span><span contenteditable="true">Editor</span><span role="button">Action</span><svg><text>SVG</text></svg><script>Script</script><style>Style</style><span>  Visible</span></p></div><div data-chat-selection-source hidden><p>Hidden source</p></div>',
    );
    const prose = event.querySelectorAll("p")[1];
    if (!prose) {
      throw new Error("Missing source paragraph");
    }
    blockGeometry(prose, 120, 40);
    glyphGeometry(() => {
      return lineRect(120);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.offset).toBe(2);
    expect(bookmark?.contextLength).toBe("  Visible".length);
    expect(bookmark?.viewportOffsetTop).toBe(20);
    // Changing excluded controls cannot invalidate the durable text offset.
    element(event, "button").textContent = "Different control label";
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBe(20);
  });

  it("resolves identical text after replacing and splitting inline DOM nodes", () => {
    const { container, event } = fixture(
      "<div data-chat-selection-source><p>  Read this paragraph.</p></div>",
    );
    blockGeometry(element(event, "p"), 130, 40);
    let top = 130;
    glyphGeometry(() => {
      return lineRect(top);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.offset).toBe(2);
    event.innerHTML =
      "<div data-chat-selection-source><p><span>  Read</span> <strong>this</strong> paragraph.</p></div>";
    top = 55;
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBe(-45);
  });

  it("rejects unrelated replacement prose instead of restoring to a wrong glyph", () => {
    const { container, event } = fixture(
      "<div data-chat-selection-source><p>Original paragraph.</p></div>",
    );
    blockGeometry(element(event, "p"), 120, 40);
    glyphGeometry(() => {
      return lineRect(120);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    event.innerHTML =
      "<div data-chat-selection-source><p>Unrelated contents.</p></div>";
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBeNull();
  });

  it("keeps UTF-16 glyph and context boundaries intact with inline CJK and emoji", () => {
    const { container, event } = fixture(
      `<div data-chat-selection-source><p>中文<strong>😀</strong>${"界".repeat(63)}😀结尾</p></div>`,
    );
    blockGeometry(element(event, "p"), 80, 1000);
    const measuredSurrogateOffsets: [number, number][] = [];
    glyphGeometry((range) => {
      if (range.startContainer.parentElement?.tagName === "STRONG") {
        measuredSurrogateOffsets.push([range.startOffset, range.endOffset]);
        return lineRect(120);
      }
      return lineRect(range.startContainer.textContent === "中文" ? 80 : 140);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.offset).toBe(2);
    // The normal 64-unit suffix would end between the second emoji's surrogates.
    expect(bookmark?.contextLength).toBe(69);
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBe(20);
    expect(measuredSurrogateOffsets.length).toBeGreaterThan(0);
    expect(measuredSurrogateOffsets).toStrictEqual(
      measuredSurrogateOffsets.map(() => {
        return [0, 2];
      }),
    );
  });

  it("uses nested paragraph text once inside lists and blockquotes", () => {
    const { container, event } = fixture(
      "<div data-chat-selection-source><blockquote><ul><li><p>  Nested prose.</p></li></ul></blockquote></div>",
    );
    blockGeometry(element(event, "p"), 120, 40);
    glyphGeometry(() => {
      return lineRect(120);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.offset).toBe(2);
    expect(bookmark?.contextLength).toBe("  Nested prose.".length);
  });

  it("measures from the inner scrollport and excludes borders and scrollbars", () => {
    const { container, event } = fixture(
      "<div data-chat-selection-source><p>Readable paragraph.</p></div>",
    );
    vi.spyOn(container, "clientTop", "get").mockReturnValue(4);
    vi.spyOn(container, "clientLeft", "get").mockReturnValue(3);
    vi.spyOn(container, "clientWidth", "get").mockReturnValue(580);
    vi.spyOn(container, "clientHeight", "get").mockReturnValue(190);
    blockGeometry(element(event, "p"), 120, 40);
    const geometry = glyphGeometry(() => {
      return lineRect(120);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark?.viewportOffsetTop).toBe(16);
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBe(16);
    // This glyph fits the outer 600px box but is underneath its scrollbar.
    geometry.mockImplementation(() => {
      const rects = [new DOMRect(584, 120, 10, 20)];
      return Object.assign(rects, {
        item(index: number) {
          return rects[index] ?? null;
        },
      });
    });
    expect(captureTextReadingAnchor(container, event)).toBeNull();
  });

  it("returns no bookmark or measurement when glyph layout is unavailable", () => {
    const { container, event } = fixture(
      "<div data-chat-selection-source><p>Visible prose.</p></div>",
    );
    blockGeometry(element(event, "p"), 120, 40);
    const geometry = glyphGeometry(() => {
      return lineRect(120);
    });
    const bookmark = captureTextReadingAnchor(container, event);
    expect(bookmark).not.toBeNull();
    geometry.mockImplementation(() => {
      return Object.assign([new DOMRect()], {
        item() {
          return null;
        },
      });
    });
    expect(captureTextReadingAnchor(container, event)).toBeNull();
    expect(
      bookmark && measureTextReadingAnchor(container, event, bookmark),
    ).toBeNull();
  });
});
