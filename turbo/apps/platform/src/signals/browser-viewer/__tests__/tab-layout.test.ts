import { expect, test } from "vitest";
import { layoutTabs } from "../viewer/tab-layout.ts";

const targets = Array.from({ length: 30 }, (_, index) => {
  return {
    id: `page-${index}`,
    title: `Project ${index}`,
  };
});
const space = (width: number) => {
  return { width, gap: 3, overflow: 38 };
};

test("caps comfortable widths and compresses before hiding any targets", () => {
  expect(layoutTabs([], null, true, space(0))).toStrictEqual({
    overflow: false,
    items: [],
  });
  const few = targets.slice(0, 3);
  expect(
    layoutTabs(few, "page-1", true, null).items.map((item) => {
      return item.width;
    }),
  ).toStrictEqual([232, 232, 232]);
  for (const width of [702, 703, 1200]) {
    const layout = layoutTabs(few, "page-1", true, space(width));
    expect(layout.overflow).toBeFalsy();
    expect(
      layout.items.map((item) => {
        return item.width;
      }),
    ).toStrictEqual([232, 232, 232]);
  }
  const compressed = layoutTabs(few, "page-1", true, space(306));
  expect(compressed.overflow).toBeFalsy();
  expect(
    compressed.items.map((item) => {
      return item.width;
    }),
  ).toStrictEqual([100, 100, 100]);
});

test("protects the active close action and switches at the actual minimum boundary", () => {
  const few = targets.slice(0, 3);
  expect(
    layoutTabs(few, "page-1", true, space(134)).items.map((item) => {
      return item.width;
    }),
  ).toStrictEqual([40, 48, 40]);
  for (const width of [118, 119]) {
    const result = layoutTabs(few, "page-1", true, space(width));
    expect(result.overflow).toBeFalsy();
    expect(result.items).toHaveLength(3);
    expect(result.items[1]!.width).toBe(48);
  }
  const overflow = layoutTabs(few, "page-2", true, space(117));
  expect(overflow.overflow).toBeTruthy();
  expect(overflow.items).toStrictEqual([{ target: few[2], width: 79 }]);
  expect(
    layoutTabs(few, "page-2", true, space(118)).items.map((item) => {
      return item.target;
    }),
  ).toStrictEqual(few);
});

test("keeps an ordered prefix and selected target without changing remote data", () => {
  const before = targets.slice();
  const result = layoutTabs(targets, "page-29", true, space(210));
  expect(result.overflow).toBeTruthy();
  expect(
    result.items.map((item) => {
      return item.target.id;
    }),
  ).toStrictEqual(["page-0", "page-1", "page-2", "page-29"]);
  expect(targets).toStrictEqual(before);
  expect(
    layoutTabs(targets, null, true, space(210)).items.map((item) => {
      return item.target.id;
    }),
  ).toStrictEqual(["page-0", "page-1", "page-2", "page-3", "page-4"]);
  expect(layoutTabs(targets, "lost", true, space(210)).items).toStrictEqual(
    layoutTabs(targets, null, true, space(210)).items,
  );
});

test("fits fractional and tiny budgets without negative widths or losing selector access", () => {
  for (const interactive of [true, false]) {
    for (const width of [-1, 0, 1, 47, 86, 117.5, 118, 220.25, 800]) {
      const result = layoutTabs(targets, "page-29", interactive, space(width));
      const used =
        result.items.reduce((total, item) => {
          return total + item.width;
        }, 0) +
        Math.max(0, result.items.length - 1) * 3;
      expect(used).toBeLessThanOrEqual(Math.max(0, width - 38) + 0.001);
      for (const item of result.items) {
        expect(item.width).toBeGreaterThanOrEqual(
          interactive && item.target.id === "page-29" ? 48 : 32,
        );
        expect(item.width).toBeLessThanOrEqual(232);
      }
      expect(result.overflow).toBeTruthy();
    }
  }
  expect(layoutTabs(targets, "page-29", true, space(47)).items).toStrictEqual(
    [],
  );
});

test("does not reserve an unavailable close control in view-only mode", () => {
  const few = targets.slice(0, 3);
  const result = layoutTabs(few, "page-2", false, space(102));
  expect(result.overflow).toBeFalsy();
  expect(
    result.items.map((item) => {
      return item.width;
    }),
  ).toStrictEqual([32, 32, 32]);
  expect(layoutTabs(few, "page-2", false, space(101)).overflow).toBeTruthy();
});
