/** UUIDv7 identity makes the retry window immutable without a second receipt ledger. */
export function createProjectOperationId(
  timestamp: number,
  randomId: string,
): string {
  const time = Math.trunc(timestamp).toString(16).padStart(12, "0");
  if (time.length !== 12) {
    throw new Error("Invalid Project operation timestamp");
  }
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomId.slice(15, 18)}-${randomId.slice(19)}`;
}
export function isFreshProjectOperation(
  id: string,
  timestamp: number,
): boolean {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return false;
  }
  const issued = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return (
    issued <= timestamp + 5 * 60 * 1000 &&
    issued > timestamp - (7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000)
  );
}
