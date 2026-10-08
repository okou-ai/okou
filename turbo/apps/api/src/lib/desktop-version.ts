export function desktopVersionIsSupported(
  version: string,
  minimum: string,
): boolean {
  const parse = (value: string): [number, number, number] | null => {
    if (!/^\d+\.\d+\.\d+$/u.test(value)) {
      return null;
    }
    const [major, minor, patch] = value.split(".").map(Number);
    if (
      major === undefined ||
      minor === undefined ||
      patch === undefined ||
      ![major, minor, patch].every(Number.isSafeInteger)
    ) {
      return null;
    }
    return [major, minor, patch];
  };
  const parts = parse(version);
  const floor = parse(minimum);
  if (!parts || !floor) {
    return false;
  }
  return (
    parts[0] > floor[0] ||
    (parts[0] === floor[0] &&
      (parts[1] > floor[1] || (parts[1] === floor[1] && parts[2] >= floor[2])))
  );
}
