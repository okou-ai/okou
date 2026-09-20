export function orderByCustomConnectorId<T>(
  values: readonly T[],
  customConnectorId: (value: T) => string,
): T[] {
  return [...values].sort((left, right) => {
    return customConnectorId(left).localeCompare(customConnectorId(right));
  });
}
