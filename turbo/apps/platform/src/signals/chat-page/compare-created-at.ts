function compareCursorString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Order two chat-event creation instants.
 *
 * Timestamps are compared as instants when both parse, and lexicographically
 * otherwise, so an opaque cursor still orders deterministically.
 */
export function compareCreatedAt(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return compareCursorString(left, right);
  }
  return leftTime - rightTime;
}
