import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

type PlausibleEventProps = Record<string, string | number | boolean>;

interface PlausibleEventOptions {
  props?: PlausibleEventProps;
  callback?: () => void;
}

type PlausibleFn = {
  (eventName: string, options?: PlausibleEventOptions): void;
  q?: [string, PlausibleEventOptions?][];
  init?: (options?: unknown) => void;
  o?: unknown;
};

declare global {
  interface Window {
    __okouPlausibleLoadScheduled?: boolean;
    plausible?: PlausibleFn;
  }
}

function plausibleScriptUrl(): string | null {
  const url = resolvePlatformRuntimeConfig().plausibleScriptUrl;
  return url?.includes("plausible") ? url : null;
}

function getPlausible(): PlausibleFn | null {
  if (typeof window === "undefined" || !plausibleScriptUrl()) {
    return null;
  }

  if (window.plausible) {
    return window.plausible;
  }

  const plausible = ((...args: [string, PlausibleEventOptions?]) => {
    plausible.q = plausible.q ?? [];
    plausible.q.push(args);
  }) as PlausibleFn;

  window.plausible = plausible;
  return plausible;
}

function loadPlausible(): void {
  const url = plausibleScriptUrl();
  const plausible = getPlausible();
  if (!url || !plausible) {
    return;
  }

  plausible.init = (options) => {
    plausible.o = options ?? {};
  };
  plausible.init({
    transformRequest(payload: { u: string }) {
      payload.u = payload.u.replace(
        /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "/:id",
      );
      return payload;
    },
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = url;
  document.head.appendChild(script);
}

export function initPlausible(signal: AbortSignal): void {
  if (window.__okouPlausibleLoadScheduled || !plausibleScriptUrl()) {
    return;
  }
  signal.throwIfAborted();
  window.__okouPlausibleLoadScheduled = true;

  if (typeof window.requestIdleCallback === "function") {
    const idleLoad: { callbackId?: number; pending: boolean } = {
      pending: true,
    };
    const cancelLoad = () => {
      if (idleLoad.callbackId !== undefined) {
        window.cancelIdleCallback(idleLoad.callbackId);
      }
    };
    idleLoad.callbackId = window.requestIdleCallback(() => {
      idleLoad.pending = false;
      signal.removeEventListener("abort", cancelLoad);
      loadPlausible();
    });
    if (idleLoad.pending) {
      signal.addEventListener("abort", cancelLoad, { once: true });
    }
    return;
  }
  loadPlausible();
}

export function capturePlausibleEvent(
  eventName: string,
  options?: PlausibleEventOptions,
): void {
  const plausible = getPlausible();
  plausible?.(eventName, {
    ...options,
    props: {
      ...options?.props,
      public_brand: resolvePlatformRuntimeConfig().publicBrand,
    },
  });
}
