import { command, computed } from "ccstate";
import { onRef } from "./utils.ts";
import {
  captureBootstrapPhaseTiming$,
  captureFirstSkeletonHide$,
} from "../lib/posthog.ts";
import {
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../lib/client-telemetry.ts";

const APP_BOOTSTRAP_SKELETON_ID = "app-bootstrap-skeleton";
const APP_BOOTSTRAP_SKELETON_HIDDEN_CLASS = "app-bootstrap-skeleton--hidden";

export const mainStylesheetLoaded$ = computed(async () => {
  return (await window.__mainStylesheetLoaded) !== "failed";
});

export async function hideBootstrapSkeleton(
  signal?: AbortSignal,
): Promise<boolean> {
  const mainStylesheetLoaded = window.__mainStylesheetLoaded;
  if (mainStylesheetLoaded) {
    const mainStylesheetStatus = await mainStylesheetLoaded;
    if (mainStylesheetStatus === "failed") {
      // The skeleton stays visible, as it did when this path threw.
      recordClientTelemetry(
        startClientTelemetryMeasurement(),
        { event_name: "bootstrap.stylesheet" },
        "error",
      );
      return false;
    }
  }
  signal?.throwIfAborted();

  const skeleton = document.getElementById(APP_BOOTSTRAP_SKELETON_ID);
  if (!skeleton) {
    return true;
  }
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.addEventListener(
    "transitionend",
    () => {
      skeleton.remove();
    },
    { once: true },
  );
  skeleton.classList.add(APP_BOOTSTRAP_SKELETON_HIDDEN_CLASS);
  return true;
}

export const hideAppSkeleton$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    if (!(await hideBootstrapSkeleton(signal))) {
      return;
    }
    set(captureFirstSkeletonHide$);
    set(captureBootstrapPhaseTiming$);
  },
);

export const hideAppSkeletonOnContentReadyRef$ = onRef(
  command(async ({ set }, _element: HTMLSpanElement, signal: AbortSignal) => {
    await set(hideAppSkeleton$, signal);
  }),
);
