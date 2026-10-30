import { onRef } from "../utils.ts";
import { command } from "ccstate";
import { BrowserRuntime } from "./runtime.ts";
import { createViewerSignals, type ViewerModel } from "./viewer/model.ts";
import type { BrowserConnection } from "./viewer/types.ts";

/** Every browser session entry constructs its own graph in the existing App Store. */
export function createBrowserViewerSignals(connection: BrowserConnection) {
  const model = createViewerSignals();
  const mount$ = onRef(
    command(({ get, set }, root: HTMLElement, signal: AbortSignal) => {
      signal.throwIfAborted();
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
      const runtime = new BrowserRuntime(
        root,
        native,
        connection,
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
        },
        signal,
      );
      signal.addEventListener(
        "abort",
        () => {
          using _binding = {
            [Symbol.dispose]: () => {
              set(model.unbind$, runtime.actions);
            },
          };
          runtime.close();
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
