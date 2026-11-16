/**
 * Geometry of one clipped child block in an otherwise fixed-height row list.
 * All lengths are CSS pixels. Row counts and indices are nonnegative integers;
 * rowHeight is positive. blockStartIndex is the first child's index in the
 * fully expanded list, so its header is at blockStartIndex - 1 (at least zero).
 * totalRowsWithoutChildren includes that header and every prefix/suffix row,
 * but excludes all childCount children. Both heights are reveal-container
 * heights in [0, childCount * rowHeight], not whole-list heights. Children stay
 * fixed relative to the block top while the suffix follows the reveal height.
 */
export interface ProjectFoldGeometry {
  blockStartIndex: number;
  childCount: number;
  fromHeight: number;
  toHeight: number;
  rowHeight: number;
  totalRowsWithoutChildren: number;
}

/**
 * Returns a conservative mount envelope for every intermediate reveal height
 * between fromHeight and toHeight, with scrollTop held fixed. Inputs must be
 * finite, viewportHeight positive, scrollTop nonnegative, and overscan a
 * nonnegative integer measured in rows. Geometry must satisfy its interface's
 * preconditions; this arithmetic helper does not sanitize caller-owned data.
 *
 * Every range is half-open. Render prefix expanded rows [startIndex,
 * blockStartIndex), children [childStart, childEnd) relative to the first child,
 * and suffix [suffixStart, suffixEnd) relative to the first row after ALL
 * children. Keep unmounted child gaps as padding; do not mount the entire
 * [startIndex, endIndex) envelope. endIndex is an expanded-list index, including
 * childCount even when most children are clipped or unmounted.
 *
 * The pixel window extends overscan * rowHeight above/below the viewport.
 * Prefix rows use their ordinary fixed positions. Children use fixed positions
 * clipped by the maximum reveal. Suffix rows are selected by inverse-sweeping
 * that window across BOTH height extremes, including intermediate exposures.
 * Edge contact alone does not count as intersection.
 *
 * animate is true only for a changing height with the header intersecting the
 * actual viewport, the prefix window origin no later than the block top, and
 * scrollTop valid even at the smaller total height (no browser bottom clamp).
 * Mount count must also be <= ceil(viewportHeight / rowHeight) * 4 + overscan * 6;
 * large suffix sweeps explicitly skip animation. When animate is false, ignore
 * the ranges and use the caller's ordinary non-animated virtualizer. Totals
 * remain valid in either case. There are no DOM reads, state changes or loops.
 */
export function getProjectFoldRange(
  geometry: ProjectFoldGeometry,
  {
    scrollTop,
    viewportHeight,
    overscan,
  }: { scrollTop: number; viewportHeight: number; overscan: number },
): {
  startIndex: number;
  endIndex: number;
  childStart: number;
  childEnd: number;
  suffixStart: number;
  suffixEnd: number;
  totalHeightFrom: number;
  totalHeightTo: number;
  animate: boolean;
} {
  const {
    blockStartIndex,
    childCount,
    fromHeight,
    toHeight,
    rowHeight,
    totalRowsWithoutChildren,
  } = geometry;
  const blockTop = blockStartIndex * rowHeight;
  const minHeight = Math.min(fromHeight, toHeight);
  const maxHeight = Math.max(fromHeight, toHeight);
  const windowTop = Math.max(0, scrollTop - overscan * rowHeight);
  const windowBottom = scrollTop + viewportHeight + overscan * rowHeight;
  const clampIndex = (index: number, count: number) => {
    return Math.max(0, Math.min(count, index));
  };

  const startIndex = clampIndex(
    Math.floor(windowTop / rowHeight),
    blockStartIndex,
  );
  const childStart = clampIndex(
    Math.floor((windowTop - blockTop) / rowHeight),
    childCount,
  );
  const childEnd = Math.max(
    childStart,
    clampIndex(
      Math.ceil(Math.min(windowBottom - blockTop, maxHeight) / rowHeight),
      childCount,
    ),
  );
  const suffixCount = totalRowsWithoutChildren - blockStartIndex;
  const suffixStart = clampIndex(
    Math.floor((windowTop - blockTop - maxHeight) / rowHeight),
    suffixCount,
  );
  const suffixEnd = Math.max(
    suffixStart,
    clampIndex(
      Math.ceil((windowBottom - blockTop - minHeight) / rowHeight),
      suffixCount,
    ),
  );
  const endIndex =
    suffixEnd > suffixStart
      ? blockStartIndex + childCount + suffixEnd
      : childEnd > childStart
        ? blockStartIndex + childEnd
        : blockStartIndex;
  const baseHeight = totalRowsWithoutChildren * rowHeight;
  const totalHeightFrom = baseHeight + fromHeight;
  const totalHeightTo = baseHeight + toHeight;
  const mountCount =
    blockStartIndex -
    startIndex +
    childEnd -
    childStart +
    suffixEnd -
    suffixStart;
  const mountBudget = Math.ceil(viewportHeight / rowHeight) * 4 + overscan * 6;
  const headerVisible =
    blockStartIndex > 0 &&
    blockTop > scrollTop &&
    blockTop - rowHeight < scrollTop + viewportHeight;

  return {
    startIndex,
    endIndex,
    childStart,
    childEnd,
    suffixStart,
    suffixEnd,
    totalHeightFrom,
    totalHeightTo,
    animate:
      fromHeight !== toHeight &&
      headerVisible &&
      windowTop <= blockTop &&
      scrollTop <= Math.max(0, baseHeight + minHeight - viewportHeight) &&
      mountCount <= mountBudget,
  };
}
