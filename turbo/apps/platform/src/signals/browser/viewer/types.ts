import type { BridgeDiagnostics } from "@okouai/browser-extension-client";
import type {
  CdpConnectionObservation,
  CdpWindowObservation,
} from "../cdp/errors.ts";

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
    | "target-crashed"
    | "input"
    | "display"
    | "extension"
    | "tab"
    | "frame";
  /** A fixed diagnostic, excluding endpoint credentials and provider payloads. */
  readonly message: string;
  /** Safe transient-failure evidence; never permission to replay a failed effect. */
  readonly transient?: boolean;
  /** Original failed request, when known. Never includes parameters or session IDs. */
  readonly request?: {
    readonly method: string;
    readonly code?: number;
  };
  /** Safe bridge observations, retained independently of reporting policy. */
  readonly bridge?: BridgeDiagnostics;
  readonly connection?: CdpConnectionObservation;
  readonly window?: CdpWindowObservation;
  readonly http?: { readonly status: number; readonly code: string };
}

export interface ViewerTarget {
  readonly id: string;
  readonly title: string;
  /** Target metadata for presentation; never input or membership authority. */
  readonly blank: boolean;
}

/** Targets have positive scope proof; only complete inventory supports absence decisions. */
export type ViewerInventory =
  | {
      readonly status: "pending" | "partial";
      readonly targets: readonly ViewerTarget[];
    }
  | {
      readonly status: "complete";
      readonly targets: readonly ViewerTarget[];
    };

export interface ViewerSnapshot {
  readonly status: ViewerStatus;
  readonly inventory: ViewerInventory;
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
  | "back"
  | "forward"
  | "reload"
  | { readonly url: string }
  | { readonly search: string };

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

export type ViewerTransport = "shared" | "split";
export type WindowSizeSync = "off" | "initial" | "live";
