import type { Command, Computed } from "ccstate";
import { isAbortError } from "../utils.ts";
import { createBrowserRuntime } from "./runtime.ts";
import { CdpFault } from "./cdp/errors.ts";
import { isImageFailure } from "./viewer/diagnostic.ts";
import type { ClipboardRecovery } from "./input/clipboard.ts";
import type { BrowserNavigationAction } from "./navigation/action.ts";
import type { DisplayModeResult, DisplayState } from "./display/sync.ts";
import type { DisplaySize } from "./display/geometry.ts";
import type { ImageRecovery } from "./viewer/image-recovery.ts";
import type { BrowserRecoveryResult } from "./recovery.ts";
import type { layoutTabs } from "./viewer/tab-layout.ts";
import type { TabStripMotion } from "./tab-strip.ts";
import type { CaptureQualitySignals } from "./capture-quality.ts";
import type { FrameRateSignals } from "./frame-rate.ts";
import type {
  NavigationReceipt,
  ViewerCaptureOptions,
  ViewerError,
  ViewerHistory,
  ViewerNavigation,
  ViewerStatus,
  ViewerTransport,
  WindowSizeSync,
} from "./viewer/types.ts";

export interface BrowserConnection {
  readonly cdpUrl: string;
  readonly instanceId: string;
  readonly windowId: number;
  readonly extension: {
    readonly id: string;
    readonly runtimeId: string;
    readonly version: string;
  };
}

export function isBrowserOperationFailure(
  error: unknown,
  imageFailureHandled = false,
): boolean {
  if (
    isAbortError(error) ||
    (error instanceof Error && isAbortError(error.cause))
  ) {
    return false;
  }
  // Selection/create/reconnect can reject after native creation succeeded. The
  // image-recovery controls own those image failures, including a later retry.
  return !(
    imageFailureHandled &&
    error instanceof CdpFault &&
    isImageFailure(error)
  );
}

export interface BrowserTab {
  readonly id: string;
  readonly title: string;
  readonly faviconUrl?: string;
}

export interface BrowserPresentation {
  readonly status: ViewerStatus;
  readonly error: ViewerError | null;
  readonly loadingPreview: boolean;
  /** A same-scope presented frame can remain visible without input authority. */
  readonly retainedFrame: boolean;
  /** Empty content can be shown before the selected tab accepts remote input. */
  readonly blank: boolean;
}

export interface BrowserControls {
  readonly streaming: boolean;
  readonly empty: boolean;
  readonly recovery: boolean;
  readonly showRecovery: boolean;
  readonly showEmptyCreate: boolean;
  readonly canMutateTabs: boolean;
  readonly canCreate: boolean;
  readonly tabsDisabled: boolean;
  readonly canSyncDisplay: boolean;
  readonly canReload: boolean;
  readonly showImageRetry: boolean;
  readonly canRetryImage: boolean;
  readonly retryingImage: boolean;
}

type Ref<E extends HTMLElement> = Command<(() => void) | undefined, [E | null]>;

export interface AddressSubmitNotice {
  readonly kind: "opening" | "preparing";
}

/** Read-only observations and finite domain actions; resource plumbing is private. */
export interface BrowserSignals {
  readonly recoveryOperation$: Computed<Promise<BrowserRecoveryResult> | null>;
  readonly tabs$: Computed<readonly BrowserTab[]>;
  readonly selectedTabId$: Computed<string | null>;
  readonly navigation$: Computed<ViewerNavigation | null>;
  readonly history$: Computed<Promise<ViewerHistory | null>>;
  readonly navigationScope$: Computed<object | null>;
  readonly address$: Computed<string>;
  readonly addressSubmissionKind$: Computed<"navigate" | "search" | null>;
  readonly addressComposing$: Computed<boolean>;
  readonly composeAddress$: Command<void, [boolean]>;
  readonly armAddressCompletion$: Command<void, [boolean]>;
  readonly canSubmitAddress$: Computed<boolean>;
  readonly addressSubmitNotice$: Computed<AddressSubmitNotice | null>;
  readonly notifyAddressSubmit$: Command<
    void,
    [AddressSubmitNotice["kind"] | null]
  >;
  readonly presentation$: Computed<BrowserPresentation>;
  readonly canvasVisible$: Computed<boolean>;
  readonly contentVisible$: Computed<boolean>;
  readonly showBlankPage$: Computed<boolean>;
  readonly imageRecovery$: Computed<ImageRecovery | null>;
  readonly controls$: Computed<BrowserControls>;
  readonly tabsDisabled$: Computed<boolean>;
  readonly canMutateTabs$: Computed<boolean>;
  readonly canCreateTab$: Computed<boolean>;
  readonly recovering$: Computed<boolean>;
  readonly streaming$: Computed<boolean>;
  readonly proxyType$: Computed<"text" | "password">;
  readonly capture$: Computed<ViewerCaptureOptions>;
  readonly quality: CaptureQualitySignals;
  readonly frameRate: FrameRateSignals;
  readonly transport$: Computed<ViewerTransport>;
  readonly windowSizeSync$: Computed<WindowSizeSync>;
  readonly display$: Computed<DisplayState>;
  readonly displayRecovery$: Computed<ViewerError | null>;
  readonly clipboardRecovery$: Computed<ClipboardRecovery | null>;
  readonly tabLayout$: Computed<ReturnType<typeof layoutTabs>>;
  readonly rejectFavicon$: Command<void, [targetId: string, url: string]>;
  readonly selectTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly createTab$: Command<Promise<string>, [AbortSignal]>;
  readonly closeTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly navigate$: Command<
    Promise<NavigationReceipt>,
    [BrowserNavigationAction, AbortSignal]
  >;
  readonly editAddress$: Command<void, [string]>;
  readonly resetAddress$: Command<void, []>;
  readonly beginAddressEdit$: Command<void, ["focus" | "interaction"]>;
  readonly blurAddress$: Command<void, []>;
  readonly reconnect$: Command<Promise<void>, [AbortSignal]>;
  readonly retryImage$: Command<Promise<void>, [AbortSignal]>;
  readonly changeCapture$: Command<
    Promise<void>,
    [ViewerCaptureOptions, AbortSignal]
  >;
  readonly changeTransport$: Command<
    Promise<void>,
    [ViewerTransport, AbortSignal]
  >;
  readonly changeWindowSizeSync$: Command<
    Promise<DisplayModeResult>,
    [WindowSizeSync, AbortSignal]
  >;
  readonly syncDisplay$: Command<Promise<void>, [AbortSignal]>;
  readonly copyClipboard$: Command<Promise<void>, [AbortSignal]>;
  readonly dismissClipboardRecovery$: Command<void, []>;
  /** Notify after the owner invalidates/publishes connection$; not for lease-only updates. */
  readonly connectionChanged$: Command<void, []>;
  /** Refresh geometry; only an explicit null acknowledges all host motion settled. */
  readonly syncLayout$: Command<void, [motion?: TabStripMotion | null]>;
  /** Sample the mounted surface even before a remote connection exists. */
  readonly measureInitialDisplay$: Command<DisplaySize | null, []>;
  readonly refs: {
    readonly root$: Ref<HTMLDivElement>;
    readonly canvas$: Ref<HTMLCanvasElement>;
    readonly input$: Ref<HTMLInputElement>;
    readonly toolbar$: Ref<HTMLDivElement>;
    readonly toolbarActions$: Ref<HTMLDivElement>;
    readonly tabs$: Ref<HTMLDivElement>;
    readonly address$: Ref<HTMLInputElement>;
    readonly surface$: Ref<HTMLDivElement>;
  };
}

/** Each surface uses the existing App Store, with its own private native owners. */
export function createBrowserSignals(
  connection$: Computed<Promise<BrowserConnection | null>>,
  reloadConnection$: Command<void, []>,
  onPageInput$?: Command<void, []>,
): BrowserSignals {
  return createBrowserRuntime(connection$, reloadConnection$, onPageInput$);
}
