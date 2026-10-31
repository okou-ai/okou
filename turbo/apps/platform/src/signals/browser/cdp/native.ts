import {
  OkouBrowserClient,
  type NativeEvent,
} from "@okouai/browser-extension-client";
import type { CdpClient } from "./client.ts";
import { CdpFault, isRecord } from "./errors.ts";

export function nativeFault(): CdpFault {
  return new CdpFault(
    "extension",
    "The required Okou Browser extension is unavailable. Reconnect the browser.",
  );
}

/** Native membership invalidations have no authority over CDP page identities. */
export function changesMembership(
  event: NativeEvent,
  windowId?: number,
): boolean {
  if (event.kind === "tab-replaced") {
    return true;
  }
  return (
    [
      "tab-created",
      "tab-removed",
      "tab-detached",
      "tab-attached",
      "window-removed",
    ].includes(event.kind) &&
    (windowId === undefined ||
      event.windowId === windowId ||
      event.oldWindowId === windowId)
  );
}

export async function connectNative(
  client: CdpClient,
  runtimeId: string,
  signal: AbortSignal,
): Promise<OkouBrowserClient> {
  signal.throwIfAborted();
  const [result] = await Promise.allSettled([
    OkouBrowserClient.connect({
      runtimeId,
      transport: {
        request: (method, params, sessionId) => {
          const late = async (value: unknown) => {
            if (isRecord(value) && typeof value.sessionId === "string") {
              await client.requestRaw(
                "Target.detachFromTarget",
                { sessionId: value.sessionId },
                sessionId,
              );
            }
          };
          return client.requestRaw(
            method,
            params,
            sessionId,
            method === "Target.attachToBrowserTarget" ||
              method === "Target.attachToTarget"
              ? late
              : undefined,
          );
        },
        onEvent: (listener) => {
          return client.onEvent(listener);
        },
      },
    }),
  ]);
  if (result.status === "rejected") {
    signal.throwIfAborted();
    throw nativeFault();
  }
  if (signal.aborted) {
    await result.value.close();
    signal.throwIfAborted();
  }
  return result.value;
}
