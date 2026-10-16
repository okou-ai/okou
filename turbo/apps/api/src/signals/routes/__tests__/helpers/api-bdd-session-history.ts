import type { TestContext } from "../../../../__tests__/test-context";

export function sessionHistoryBlobBodyForKey(
  context: TestContext,
  key: string,
): Uint8Array | undefined {
  const match = /^blobs\/([a-f0-9]{64})\.blob$/.exec(key);
  if (!match) {
    return undefined;
  }
  const hash = match[1];
  if (!hash) {
    return undefined;
  }
  return context.sessionHistoryBlobs.get(hash);
}
