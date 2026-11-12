import type { ViewerError } from "../viewer/types.ts";

export interface CdpConnectionObservation {
  readonly source:
    "native-close" | "native-error" | "opening-timeout" | "response-timeout";
  readonly role?: "control" | "frames";
  readonly phase: "opening" | "open";
  readonly ready_state: number;
  readonly code?: number;
  readonly was_clean?: boolean;
  readonly pending_requests: number;
  readonly cancelled_awaiting_response: number;
}

/** Non-secret binding identity for private lifecycle joins, never authority. */
export interface CdpWindowObservation {
  readonly source: "native-window-removed";
  readonly instanceId: string;
  readonly primaryWindowId: number;
}

export class CdpFault extends Error {
  /** Capture ownership follows this fault through wrappers retaining its cause. */
  reported = false;
  readonly connection: CdpConnectionObservation | undefined;
  readonly window: CdpWindowObservation | undefined;
  readonly readOnly: boolean;

  constructor(
    readonly kind: ViewerError["kind"],
    message: string,
    readonly code?: number,
    readonly request?: ViewerError["request"],
    options?: ErrorOptions & {
      readonly connection?: CdpConnectionObservation;
      readonly window?: CdpWindowObservation;
      readonly readOnly?: boolean;
    },
  ) {
    super(message, options);
    this.name = "CdpFault";
    this.connection = options?.connection;
    this.window = options?.window;
    this.readOnly = options?.readOnly === true;
  }
}

/** A failed read is not a lost wire or permission to use an unverified scope. */
export function isRecoverableReadFailure(error: unknown): error is CdpFault {
  return (
    error instanceof CdpFault &&
    error.readOnly &&
    error.code !== -32_601 &&
    (error.kind === "protocol" || error.kind === "scope")
  );
}

/** Preserve diagnostic context without changing a wrapper's control-flow code. */
export function requestDetails(error: unknown): ViewerError["request"] {
  return error instanceof CdpFault ? error.request : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfiguration(url: string, windowId: number): void {
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
  if (!Number.isSafeInteger(windowId)) {
    throw new CdpFault("configuration", "windowId must be an integer.");
  }
}
