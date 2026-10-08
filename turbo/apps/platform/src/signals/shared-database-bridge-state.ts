import { command, computed, state } from "ccstate";

import type { SharedDatabaseBridge } from "../shared-database/bridge.ts";
import { NEVER_RESOLVED_PROMISE } from "./utils.ts";

const sharedDatabaseBridgeState$ = state<SharedDatabaseBridge | null>(null);
const internalBridgeConnected$ = state<Promise<unknown>>(
  NEVER_RESOLVED_PROMISE,
);

export const bridgeConnected$ = computed((get): Promise<unknown> => {
  return get(internalBridgeConnected$);
});

export const setBridgeConnected$ = command(
  ({ set }, connected: Promise<unknown>): void => {
    set(internalBridgeConnected$, connected);
  },
);

export const sharedDatabaseBridgeInstalled$ = computed((get): boolean => {
  return get(sharedDatabaseBridgeState$) !== null;
});

export const installedSharedDatabaseBridge$ = computed(
  (get): SharedDatabaseBridge => {
    const bridge = get(sharedDatabaseBridgeState$);
    if (!bridge) {
      throw new Error("Shared database bridge is not installed");
    }
    return bridge;
  },
);

const reportTabVisibility$ = command(({ get }): void => {
  get(installedSharedDatabaseBridge$).setTabVisibility(
    document.visibilityState,
  );
});

const reportTabHidden$ = command(({ get }): void => {
  get(installedSharedDatabaseBridge$).setTabVisibility("hidden");
});

export const setupTabVisibilityReport$ = command(
  ({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    document.addEventListener(
      "visibilitychange",
      () => {
        set(reportTabVisibility$);
      },
      { signal },
    );
    window.addEventListener(
      "pageshow",
      () => {
        set(reportTabVisibility$);
      },
      { signal },
    );
    window.addEventListener(
      "pagehide",
      () => {
        set(reportTabHidden$);
      },
      { signal },
    );
    set(reportTabVisibility$);
  },
);

export const installSharedDatabaseBridge$ = command(
  async (
    { set },
    bridge: SharedDatabaseBridge,
    signal: AbortSignal,
  ): Promise<void> => {
    await bridge.registerTab(signal);
    signal.throwIfAborted();
    set(sharedDatabaseBridgeState$, bridge);
    set(setupTabVisibilityReport$, signal);
  },
);
