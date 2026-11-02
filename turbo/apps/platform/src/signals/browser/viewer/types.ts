export type ViewerStatus =
  | "connecting"
  | "streaming"
  | "paused"
  | "unavailable"
  | "disconnected"
  | "error";

export interface ViewerError {
  readonly kind:
    | "configuration"
    | "connection"
    | "protocol"
    | "scope"
    | "unsupported-capability"
    | "target-unavailable"
    | "input"
    | "display"
    | "extension"
    | "tab"
    | "frame";
  /** A fixed diagnostic, excluding endpoint credentials and provider payloads. */
  readonly message: string;
  /** Original failed request, when known. Never includes parameters or session IDs. */
  readonly request?: {
    readonly method: string;
    readonly code?: number;
  };
}

export interface ViewerTarget {
  readonly id: string;
  readonly title: string;
}

export interface ViewerSnapshot {
  readonly status: ViewerStatus;
  readonly targets: readonly ViewerTarget[];
  readonly selectedTargetId: string | null;
  readonly error: ViewerError | null;
}

/** The last confirmed main-frame document, never a navigation ACK. */
export interface ViewerNavigation {
  readonly url: string;
  readonly frameId: string;
  readonly loaderId: string;
}

/** Optional authoritative history read; pending/failure belongs to its loadable. */
export interface ViewerHistory {
  readonly url: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type NavigationAction =
  "back" | "forward" | "reload" | { readonly url: string };

export type NavigationReceipt =
  | {
      readonly kind: "ack";
      readonly frameId?: string;
      readonly loaderId?: string;
    }
  | {
      readonly kind: "download";
      readonly frameId: string;
      readonly loaderId?: string;
    }
  | { readonly kind: "unavailable" };

export type ViewerCaptureFormat = "webp" | "jpeg" | "png";

/** All capture bounds share a 3840×2160 total-pixel limit. */
export interface ViewerCaptureOptions {
  /** Image compression format. Default: "webp". Endpoint support is required. */
  readonly format?: ViewerCaptureFormat;
  /** WebP/JPEG quality, integer 0..100. Default: 70. Retained but unused for PNG. */
  readonly quality?: number;
  /** Fixed maximum image width, integer 1..4096. Omit to follow container/DPR. */
  readonly maxWidth?: number;
  /** Fixed maximum image height, integer 1..4096. Omit to follow container/DPR. */
  readonly maxHeight?: number;
}

/** Internal connection configuration; product controls live in Platform signals. */
export interface BrowserConnection {
  readonly cdpUrl: string;
  readonly instanceId: string | null;
  readonly windowId: number | null;
  readonly extension: {
    readonly id: string;
    readonly runtimeId: string;
    readonly version: string;
  };
}
export type ViewerTransport = "shared" | "split";
export type WindowSizeSync = "off" | "initial" | "live";
