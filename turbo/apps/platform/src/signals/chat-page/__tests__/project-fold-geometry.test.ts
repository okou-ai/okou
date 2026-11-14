import { describe, expect, it } from "vitest";

import {
  getProjectFoldRange,
  type ProjectFoldGeometry,
} from "../project-fold-geometry.ts";

function mountedIndices(range: ReturnType<typeof getProjectFoldRange>) {
  return {
    children: Array.from(
      { length: range.childEnd - range.childStart },
      (_, index) => {
        return range.childStart + index;
      },
    ),
    suffix: Array.from(
      { length: range.suffixEnd - range.suffixStart },
      (_, index) => {
        return range.suffixStart + index;
      },
    ),
  };
}

describe("project fold geometry", () => {
  const geometry: ProjectFoldGeometry = {
    blockStartIndex: 5,
    childCount: 20,
    fromHeight: 0,
    toHeight: 800,
    rowHeight: 40,
    totalRowsWithoutChildren: 100,
  };
  const viewport = { scrollTop: 160, viewportHeight: 400, overscan: 2 };

  it("keeps separate sparse slices instead of mounting the expanded envelope", () => {
    expect(getProjectFoldRange(geometry, viewport)).toStrictEqual({
      startIndex: 2,
      endIndex: 36,
      childStart: 0,
      childEnd: 11,
      suffixStart: 0,
      suffixEnd: 11,
      totalHeightFrom: 4000,
      totalHeightTo: 4800,
      animate: true,
    });
  });

  it("uses the same swept slices for opening and closing", () => {
    const opening = getProjectFoldRange(geometry, viewport);
    expect(
      getProjectFoldRange(
        { ...geometry, fromHeight: geometry.toHeight, toHeight: 0 },
        viewport,
      ),
    ).toStrictEqual({
      ...opening,
      totalHeightFrom: opening.totalHeightTo,
      totalHeightTo: opening.totalHeightFrom,
    });
  });

  it("includes suffix rows exposed between the endpoint positions", () => {
    const input = { ...geometry, fromHeight: 5, toHeight: 395 };
    const view = { scrollTop: 400, viewportHeight: 40, overscan: 0 };
    const range = getProjectFoldRange(input, view);
    expect(range.animate).toBeFalsy();
    expect(range.suffixStart).toBe(0);
    expect(range.suffixEnd).toBe(6);
    // Row zero misses the viewport at both endpoints but crosses it at
    // height 210. The envelope remains conservative even when animation skips.
    expect(200 + 5 + 40).toBeLessThan(400);
    expect(200 + 395).toBeGreaterThan(440);
    expect(mountedIndices(range).suffix).toContain(0);
  });

  it("clips children to the maximum fractional reveal and excludes edge contact", () => {
    const range = getProjectFoldRange(
      { ...geometry, fromHeight: 40, toHeight: 40.5 },
      { scrollTop: 160, viewportHeight: 120, overscan: 0 },
    );
    expect(range.childStart).toBe(0);
    expect(range.childEnd).toBe(2);
    expect(range.suffixEnd).toBe(1);
    expect(range.animate).toBeTruthy();
    expect(
      getProjectFoldRange(
        { ...geometry, toHeight: 40 },
        { scrollTop: 160, viewportHeight: 120, overscan: 0 },
      ).childEnd,
    ).toBe(1);
  });

  it("skips a large inverse suffix sweep rather than mounting thousands of rows", () => {
    const sweep = getProjectFoldRange(
      {
        ...geometry,
        childCount: 10_000,
        totalRowsWithoutChildren: 20_000,
        fromHeight: 0,
        toHeight: 400_000,
      },
      { scrollTop: 200_000, viewportHeight: 400, overscan: 2 },
    );
    expect(sweep.suffixEnd - sweep.suffixStart).toBe(5007);
    expect(sweep.suffixEnd - sweep.suffixStart).toBeGreaterThan(10 * 4 + 2 * 6);
    expect(sweep.animate).toBeFalsy();
  });

  it("skips bottom-clamped scrolling in either direction", () => {
    const input = { ...geometry, totalRowsWithoutChildren: 10 };
    const view = { scrollTop: 160, viewportHeight: 400, overscan: 2 };
    expect(getProjectFoldRange(input, view).animate).toBeFalsy();
    expect(
      getProjectFoldRange({ ...input, fromHeight: 800, toHeight: 0 }, view)
        .animate,
    ).toBeFalsy();
    expect(
      getProjectFoldRange(input, { ...view, scrollTop: 0 }).animate,
    ).toBeTruthy();
  });

  it("requires actual header visibility, rather than overscan visibility", () => {
    expect(
      getProjectFoldRange(geometry, { ...viewport, scrollTop: 200 }).animate,
    ).toBeFalsy();
    expect(
      getProjectFoldRange(geometry, {
        ...viewport,
        scrollTop: 0,
        viewportHeight: 160,
      }).animate,
    ).toBeFalsy();
    expect(
      getProjectFoldRange(geometry, { ...viewport, scrollTop: 199.5 }).animate,
    ).toBeTruthy();
    expect(
      getProjectFoldRange({ ...geometry, toHeight: 0 }, viewport).animate,
    ).toBeFalsy();
  });

  it("handles a last project with no suffix and a list shorter than its viewport", () => {
    expect(
      getProjectFoldRange(
        {
          ...geometry,
          blockStartIndex: 1,
          totalRowsWithoutChildren: 1,
          toHeight: 20,
        },
        { scrollTop: 0, viewportHeight: 600, overscan: 2 },
      ),
    ).toStrictEqual({
      startIndex: 0,
      endIndex: 2,
      childStart: 0,
      childEnd: 1,
      suffixStart: 0,
      suffixEnd: 0,
      totalHeightFrom: 40,
      totalHeightTo: 60,
      animate: true,
    });
  });

  it.each([32, 40, 48])(
    "matches desktop/mobile swept row intersections at row height %i",
    (rowHeight) => {
      for (const viewportHeight of [240, 640, 900]) {
        for (const childCount of [1, 7, 100, 10_000]) {
          for (const overscan of [0, 2, 6]) {
            for (const fraction of [0, 0.25, 0.95]) {
              const blockStartIndex = 12;
              const blockTop = blockStartIndex * rowHeight;
              const fromHeight = childCount * rowHeight * fraction;
              const toHeight = childCount * rowHeight;
              const scrollTop = blockTop - rowHeight / 2;
              const input = {
                blockStartIndex,
                childCount,
                rowHeight,
                fromHeight,
                toHeight,
                totalRowsWithoutChildren: 200,
              };
              const view = { scrollTop, viewportHeight, overscan };
              const range = getProjectFoldRange(input, view);
              const top = Math.max(0, scrollTop - overscan * rowHeight);
              const bottom = scrollTop + viewportHeight + overscan * rowHeight;
              const children = Array.from({ length: childCount }, (_, i) => {
                return i;
              }).filter((i) => {
                const rowTop = blockTop + i * rowHeight;
                return (
                  rowTop < bottom &&
                  rowTop < blockTop + toHeight &&
                  Math.min(rowTop + rowHeight, blockTop + toHeight) > top
                );
              });
              const suffix = Array.from({ length: 188 }, (_, i) => {
                return i;
              }).filter((i) => {
                const firstTop = blockTop + fromHeight + i * rowHeight;
                const lastBottom = blockTop + toHeight + (i + 1) * rowHeight;
                return firstTop < bottom && lastBottom > top;
              });
              expect(mountedIndices(range)).toStrictEqual({ children, suffix });
              const mountCount =
                blockStartIndex -
                range.startIndex +
                children.length +
                suffix.length;
              expect(range.animate).toBe(
                fromHeight !== toHeight &&
                  mountCount <=
                    Math.ceil(viewportHeight / rowHeight) * 4 + overscan * 6,
              );
              expect(
                getProjectFoldRange(
                  { ...input, fromHeight: toHeight, toHeight: fromHeight },
                  view,
                ),
              ).toStrictEqual({
                ...range,
                totalHeightFrom: range.totalHeightTo,
                totalHeightTo: range.totalHeightFrom,
              });
            }
          }
        }
      }
    },
  );
});
