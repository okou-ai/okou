// Temporary PR47142 instrumentation. Never enable on another deployment.
export const PWA_SCROLL_DIAGNOSTICS_EVENT = "okou-preview-scroll-diagnostic";
export const PWA_SCROLL_RECORDING_ATTRIBUTE = "data-preview-scroll-recording";

export function isPwaScrollDiagnosticsPreview(): boolean {
  return (
    globalThis.location?.hostname ===
    "pr-47142-app-okou-app-preview.vm0.workers.dev"
  );
}

export interface PwaScrollSourceDetail {
  readonly kind:
    | "apply"
    | "apply-write"
    | "apply-skip"
    | "layout-skip"
    | "held-capture"
    | "held-clear"
    | "request"
    | "commit"
    | "generic-commit"
    | "restore"
    | "bottom-fallback"
    | "container-mount"
    | "container-unmount"
    | "content-mount"
    | "content-unmount";
  readonly element?: HTMLElement;
  readonly requestedTop?: number;
  readonly targetTop?: number;
  readonly revision?: number;
  readonly offset?: number;
  readonly held?: boolean;
  readonly measured?: boolean;
  readonly behavior?: ScrollBehavior;
}

export class PwaScrollSourceEvent extends CustomEvent<PwaScrollSourceDetail> {
  constructor(detail: PwaScrollSourceDetail) {
    super(PWA_SCROLL_DIAGNOSTICS_EVENT, { detail });
  }
}

/** No geometry reads: application writes stay separate from native snapshots. */
export function emitPwaScrollSource(detail: PwaScrollSourceDetail): void {
  if (
    isPwaScrollDiagnosticsPreview() &&
    document.documentElement.hasAttribute(PWA_SCROLL_RECORDING_ATTRIBUTE)
  ) {
    document.dispatchEvent(new PwaScrollSourceEvent(detail));
  }
}
