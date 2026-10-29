import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";
import { positive } from "./geometry.ts";

/** Confirm an elapsed native clock boundary before a serialized capture start. */
export async function captureBoundary(
  client: CdpClient,
  sessionId: string,
  current: () => boolean,
): Promise<number | null> {
  if (!current()) {
    return null;
  }
  const tree = await client.request("Page.getFrameTree", undefined, sessionId);
  if (!current()) {
    return null;
  }
  const world = await client.request(
    "Page.createIsolatedWorld",
    {
      frameId: tree.frameTree.frame.id,
      worldName: "okou-browser-display",
    },
    sessionId,
  );
  if (!current()) {
    return null;
  }
  const release = (result: unknown) => {
    return releaseRuntimeObjects(client, sessionId, result);
  };
  const clock = await client.request(
    "Runtime.evaluate",
    {
      expression: `new Promise((resolve) => {
          const fence = Date.now() + 1;
          setTimeout(() => resolve({ fence, now: Date.now() }), 1);
        })`,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
    release,
  );
  release(clock);
  if (!current()) {
    return null;
  }
  const value: unknown = clock.result.value;
  if (
    clock.exceptionDetails ||
    !isRecord(value) ||
    !Number.isSafeInteger(value.fence) ||
    !positive(value.fence) ||
    !Number.isSafeInteger(value.now) ||
    !positive(value.now) ||
    value.now < value.fence
  ) {
    throw new CdpFault(
      "display",
      "A fresh browser image could not be confirmed. Try synchronizing again.",
    );
  }
  return value.fence / 1000;
}
