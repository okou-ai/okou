import { callAsync, onRef, resetSignal } from "../utils.ts";
import { command, type Computed } from "ccstate";
import { BrowserRuntime } from "./runtime.ts";
import { createViewerSignals, type ViewerModel } from "./viewer/model.ts";
import { diagnostic } from "./cdp/errors.ts";
import type { BrowserConnection } from "./viewer/types.ts";

/** Every browser session entry constructs its own graph in the existing App Store. */
export function createBrowserViewerSignals(
  connection$: Computed<
    BrowserConnection | null | Promise<BrowserConnection | null>
  >,
) {
  const model = createViewerSignals();
  const mount$ = onRef(
    command(async ({ get, set }, root: HTMLElement, signal: AbortSignal) => {
      const connection = await get(connection$);
      signal.throwIfAborted();
      if (!connection) {
        return;
      }
      const native: ViewerModel = {
        commitIntent: (...args) => {
          return set(model.commitIntent$, ...args);
        },
        configure: (...args) => {
          return set(model.configure$, ...args);
        },
        intent: () => {
          return get(model.intent$);
        },
        controls: () => {
          return get(model.controls$);
        },
        imageRecovery: () => {
          return get(model.imageRecovery$);
        },
        display: () => {
          return get(model.display$);
        },
        resetAddress: (...args) => {
          return set(model.resetAddress$, ...args);
        },
        setTabAction: (...args) => {
          return set(model.setTabAction$, ...args);
        },
        setConnected: (...args) => {
          return set(model.setConnected$, ...args);
        },
        setDisplay: (...args) => {
          return set(model.setDisplay$, ...args);
        },
        setFavicon: (...args) => {
          return set(model.setFavicon$, ...args);
        },
        inventoryState: () => {
          return get(model.inventoryState$);
        },
        getSnapshot: () => {
          return get(model.snapshot$);
        },
        update: (patch) => {
          return set(model.updateData$, patch);
        },
        inventory: (event) => {
          return set(model.inventoryUpdate$, event);
        },
        transition: (event) => {
          return set(model.transition$, event);
        },
      };
      set(model.transition$, { type: "reset" });
      // Control transport outlives DOM admission only while its original input
      // releases drain. Each mount owns a separate, explicitly cancelled signal.
      const transportLifetime$ = resetSignal();
      const transportSignal = set(transportLifetime$);
      const [acquired] = await Promise.allSettled([
        callAsync(() => {
          return new BrowserRuntime(
            root,
            { model: native, connection },
            {
              transport: get(model.transport$),
              capture: get(model.capture$),
              mode: get(model.windowSizeSync$),
              clipboardChanged: (value) => {
                return set(model.setClipboard$, value);
              },
              resized: (space) => {
                return set(model.resizeTabs$, space);
              },
              releaseTransport: () => {
                set(transportLifetime$);
              },
            },
            signal,
            transportSignal,
          );
        }),
      ]);
      signal.throwIfAborted();
      if (acquired.status === "rejected") {
        set(transportLifetime$);
        set(model.transition$, {
          type: "failed",
          error: diagnostic(acquired.reason),
        });
        return;
      }
      const runtime = acquired.value;
      signal.addEventListener(
        "abort",
        () => {
          runtime.close();
          set(model.unbind$, runtime.actions);
        },
        { once: true },
      );
      set(model.bind$, runtime.actions);
      signal.throwIfAborted();
      runtime.start();
    }),
  );
  return { ...model, mount$ };
}
export type BrowserViewerSignals = ReturnType<
  typeof createBrowserViewerSignals
>;
