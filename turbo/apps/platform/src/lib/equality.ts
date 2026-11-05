type EqualityFn<T> = (previous: T, next: T) => boolean;

export function equalArrays<T>(
  previous: readonly T[],
  next: readonly T[],
  equalItem: EqualityFn<T> = Object.is,
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every((item, index) => {
    return equalItem(item, next[index]!);
  });
}
