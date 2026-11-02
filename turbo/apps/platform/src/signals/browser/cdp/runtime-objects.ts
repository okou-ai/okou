import type { CdpClient } from "./client.ts";
import { isRecord } from "./errors.ts";

/** The caller decides retention; cleanup always uses the originating session. */
export function releaseRuntimeObjects(
  client: CdpClient,
  sessionId: string,
  result: unknown,
): void {
  if (!isRecord(result)) {
    return;
  }
  const objects = [
    result.result,
    isRecord(result.exceptionDetails)
      ? result.exceptionDetails.exception
      : undefined,
  ];
  const ids = new Set<string>();
  for (const object of objects) {
    if (isRecord(object) && typeof object.objectId === "string") {
      ids.add(object.objectId);
    }
  }
  for (const objectId of ids) {
    client.notify("Runtime.releaseObject", { objectId }, sessionId);
  }
}
