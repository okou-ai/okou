/** Bounded protocol traces without sharing mutable fixture state. */
export function* sequences<T>(
  items: readonly T[],
  length: number,
): Generator<readonly T[]> {
  if (!length) {
    yield [];
    return;
  }
  for (const first of items) {
    for (const rest of sequences(items, length - 1)) {
      yield [first, ...rest];
    }
  }
}
