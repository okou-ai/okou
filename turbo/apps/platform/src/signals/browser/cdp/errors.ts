import type { ViewerError } from "../viewer/types.ts";

export class CdpFault extends Error {
  constructor(
    readonly kind: ViewerError["kind"],
    message: string,
    readonly code?: number,
    readonly request?: ViewerError["request"],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CdpFault";
  }
}

/** Preserve diagnostic context without changing a wrapper's control-flow code. */
export function requestDetails(error: unknown): ViewerError["request"] {
  return error instanceof CdpFault ? error.request : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfiguration(url: string, windowId?: number): void {
  if (
    !URL.canParse(url) ||
    !["ws:", "wss:"].includes(new URL(url).protocol) ||
    !new URL(url).hostname
  ) {
    throw new CdpFault(
      "configuration",
      "cdpUrl must be an absolute browser debugger WebSocket URL.",
    );
  }
  if (windowId !== undefined && !Number.isSafeInteger(windowId)) {
    throw new CdpFault("configuration", "windowId must be an integer.");
  }
}
