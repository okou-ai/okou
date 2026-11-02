import {
  BrowserBridgeError,
  OkouBrowserClient,
  type NativeEvent,
} from "@okouai/browser-extension-client";
import type { CdpClient } from "./client.ts";
import { CdpFault, isRecord } from "./errors.ts";

export function nativeFault(error?: unknown): CdpFault {
  // The shared client owns sanitization; never attach an arbitrary transport cause.
  const cause = error instanceof BrowserBridgeError ? error : undefined;
  return new CdpFault(
    "extension",
    "The required Okou Browser extension is unavailable. Reconnect the browser.",
    undefined,
    cause?.diagnostics.request,
    cause ? { cause } : undefined,
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
      signal,
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
            signal,
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
    throw nativeFault(result.reason);
  }
  if (signal.aborted) {
    await result.value.close();
    signal.throwIfAborted();
  }
  return result.value;
}
