import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDesktopConfig, type DesktopConfig } from "./config";
import { OFFLINE_COMPUTER_USE_HOST_STATE } from "./computer-use-types";
import type { ComputerUseHostRuntimeState } from "./computer-use-types";
import { installDesktopAutoUpdates } from "./desktop-auto-updates";
import type { DesktopAutoUpdatesController } from "./desktop-main-module";

const mocks = vi.hoisted(() => {
  type AutoUpdaterListener = (...args: readonly unknown[]) => void;
  type NativeUpdateState = "idle" | "checking" | "downloading" | "settling";
  interface ScheduledNativeSettle {
    readonly callback: () => void;
    readonly delay: number | undefined;
  }

  const autoUpdaterListeners = new Map<string, Set<AutoUpdaterListener>>();
  const autoUpdaterOnceListeners = new Map<string, Set<AutoUpdaterListener>>();
  const scheduledUpdateChecks: Array<() => void> = [];
  const scheduledNativeSettles: ScheduledNativeSettle[] = [];
  const nativeUpdate = { state: "idle" as NativeUpdateState };

  function addAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    const listeners = autoUpdaterListeners.get(eventName) ?? new Set();
    listeners.add(listener);
    autoUpdaterListeners.set(eventName, listeners);
  }

  function addAutoUpdaterOnceListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    const listeners = autoUpdaterOnceListeners.get(eventName) ?? new Set();
    listeners.add(listener);
    autoUpdaterOnceListeners.set(eventName, listeners);
  }

  function removeAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    autoUpdaterListeners.get(eventName)?.delete(listener);
    autoUpdaterOnceListeners.get(eventName)?.delete(listener);
  }

  function startNativeUpdateCheck(): void {
    if (nativeUpdate.state !== "idle") {
      throw new Error("The command is disabled and cannot be executed");
    }
    nativeUpdate.state = "checking";
  }

  return {
    app: { isPackaged: true },
    autoUpdater: {
      checkForUpdates: vi.fn(startNativeUpdateCheck),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      on: vi.fn(addAutoUpdaterListener),
      once: vi.fn(addAutoUpdaterOnceListener),
      removeListener: vi.fn(removeAutoUpdaterListener),
    },
    autoUpdaterListeners,
    autoUpdaterOnceListeners,
    nativeUpdate,
    dialog: {
      showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
    },
    scheduledNativeSettles,
    scheduledUpdateChecks,
    startNativeUpdateCheck,
    setInterval: vi.fn((callback: () => void) => {
      scheduledUpdateChecks.push(callback);
      return 1;
    }),
    setTimeout: vi.fn((callback: () => void, delay?: number) => {
      scheduledNativeSettles.push({ callback, delay });
      return 1;
    }),
  };
});

vi.mock("node:timers", () => ({
  setInterval: mocks.setInterval,
  setTimeout: mocks.setTimeout,
}));

vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: mocks.autoUpdater,
  dialog: mocks.dialog,
}));

const originalPlatform = process.platform;
const originalArch = process.arch;

const productionConfig = resolveDesktopConfig();

function stubDesktopAutoUpdatePlatform(
  arch: NodeJS.Architecture = "arm64",
): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  Object.defineProperty(process, "arch", {
    configurable: true,
    value: arch,
  });
}

function installAndCaptureAutoUpdates(
  getComputerUseHostState: () => ComputerUseHostRuntimeState,
): {
  readonly autoUpdates: DesktopAutoUpdatesController;
  readonly prepareForQuitAndInstall: ReturnType<typeof vi.fn>;
} {
  const prepareForQuitAndInstall = vi.fn(async () => {});
  const autoUpdates = installDesktopAutoUpdates({
    config: productionConfig,
    apiBaseUrl: "https://api.okou.ai",
    getComputerUseHostState,
    prepareForQuitAndInstall,
  });

  if (!autoUpdates) {
    throw new Error("Expected Desktop auto-updates to install");
  }

  expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
    url: "https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    serverType: "json",
  });
  expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(mocks.setInterval).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    30 * 60 * 1000,
  );

  return { autoUpdates, prepareForQuitAndInstall };
}

function emitAutoUpdaterEvent(
  eventName: string,
  ...args: readonly unknown[]
): void {
  if (eventName === "update-available") {
    if (mocks.nativeUpdate.state !== "checking") {
      throw new Error(
        `Cannot enter native download from ${mocks.nativeUpdate.state}`,
      );
    }
    mocks.nativeUpdate.state = "downloading";
  } else if (eventName === "update-downloaded") {
    if (mocks.nativeUpdate.state !== "downloading") {
      throw new Error(
        `Cannot enter native settle from ${mocks.nativeUpdate.state}`,
      );
    }
    mocks.nativeUpdate.state = "settling";
  } else if (eventName === "update-not-available" || eventName === "error") {
    const isLateSettlingError =
      eventName === "error" && mocks.nativeUpdate.state === "settling";
    // Errors after update-downloaded belong to the updater globally; the
    // completed check must remain guarded until its settle timer fires.
    if (!isLateSettlingError) {
      if (
        mocks.nativeUpdate.state !== "checking" &&
        mocks.nativeUpdate.state !== "downloading"
      ) {
        throw new Error(
          `Cannot finish native update check from ${mocks.nativeUpdate.state}`,
        );
      }
      mocks.nativeUpdate.state = "idle";
    }
  }

  const listeners = [...(mocks.autoUpdaterListeners.get(eventName) ?? [])];
  const onceListeners = [
    ...(mocks.autoUpdaterOnceListeners.get(eventName) ?? []),
  ];
  mocks.autoUpdaterOnceListeners.delete(eventName);
  [...listeners, ...onceListeners].forEach((listener) => {
    listener(...args);
  });
}

function expectActiveUpdateCheckListenerCount(expected: number): void {
  for (const eventName of [
    "update-not-available",
    "update-available",
    "update-downloaded",
    "error",
  ]) {
    expect(mocks.autoUpdaterOnceListeners.get(eventName)?.size ?? 0).toBe(
      expected,
    );
  }
}

function finishNativeSettle(): void {
  const settle = mocks.scheduledNativeSettles.shift();
  if (!settle) {
    throw new Error("Expected a scheduled native update settle");
  }
  if (mocks.nativeUpdate.state !== "settling") {
    throw new Error(
      `Cannot finish native settle from ${mocks.nativeUpdate.state}`,
    );
  }

  expect(settle.delay).toBe(1000);
  mocks.nativeUpdate.state = "idle";
  settle.callback();
}

function runScheduledUpdateCheck(): void {
  const scheduledUpdateCheck = mocks.scheduledUpdateChecks[0];
  if (!scheduledUpdateCheck) {
    throw new Error("Expected a scheduled Desktop update check");
  }
  scheduledUpdateCheck();
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("desktop auto-updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoUpdaterListeners.clear();
    mocks.autoUpdaterOnceListeners.clear();
    mocks.nativeUpdate.state = "idle";
    mocks.scheduledNativeSettles.length = 0;
    mocks.scheduledUpdateChecks.length = 0;
    mocks.autoUpdater.checkForUpdates.mockImplementation(
      mocks.startNativeUpdateCheck,
    );
    mocks.app.isPackaged = true;
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    stubDesktopAutoUpdatePlatform();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    Object.defineProperty(process, "arch", {
      configurable: true,
      value: originalArch,
    });
  });

  it("configures the feed and starts one immediate check on a 30-minute schedule", () => {
    installAndCaptureAutoUpdates(() => OFFLINE_COMPUTER_USE_HOST_STATE);

    expectActiveUpdateCheckListenerCount(1);
    expect(mocks.scheduledUpdateChecks).toHaveLength(1);
  });

  it("does not install auto-updates on Intel Macs", () => {
    stubDesktopAutoUpdatePlatform("x64");

    expect(
      installDesktopAutoUpdates({
        config: productionConfig,
        apiBaseUrl: "https://api.okou.ai",
        getComputerUseHostState: () => OFFLINE_COMPUTER_USE_HOST_STATE,
        prepareForQuitAndInstall: vi.fn(async () => {}),
      }),
    ).toBeNull();
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.setInterval).not.toHaveBeenCalled();
  });

  it("selects the isolated Okou update feed for an Okou identity", () => {
    const okouConfig: DesktopConfig = {
      ...productionConfig,
      identity: {
        product: "okou",
        brandName: "Okou",
        displayName: "Okou",
        userDataDirectoryName: "Okou",
        updateLine: "ai-okou-desktop",
        bundleId: "ai.okou.desktop",
        authProtocolName: "Okou Desktop Auth",
        authScheme: "ai.okou.desktop",
      },
    };

    expect(
      installDesktopAutoUpdates({
        config: okouConfig,
        apiBaseUrl: "https://api.okou.ai",
        getComputerUseHostState: () => OFFLINE_COMPUTER_USE_HOST_STATE,
        prepareForQuitAndInstall: vi.fn(async () => {}),
      }),
    ).not.toBeNull();
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledExactlyOnceWith({
      url: "https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
      serverType: "json",
    });
  });

  it("coalesces a manual request with the startup check", async () => {
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );

    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expectActiveUpdateCheckListenerCount(1);

    emitAutoUpdaterEvent("update-not-available");
    await flushAsyncCallbacks();

    expectActiveUpdateCheckListenerCount(0);
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "No Updates Available",
        message: "Okou is up to date.",
      }),
    );
  });

  it("coalesces a manual request with a scheduled check", async () => {
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );
    emitAutoUpdaterEvent("update-not-available");

    runScheduledUpdateCheck();
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expectActiveUpdateCheckListenerCount(1);

    emitAutoUpdaterEvent("update-not-available");
    await flushAsyncCallbacks();

    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid manual requests into one check and one result", async () => {
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );
    emitAutoUpdaterEvent("update-not-available");

    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expectActiveUpdateCheckListenerCount(1);

    emitAutoUpdaterEvent("update-not-available");
    await flushAsyncCallbacks();

    expectActiveUpdateCheckListenerCount(0);
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it.each(["startup", "interval", "manual"] as const)(
    "holds a %s check through download and native settle",
    async (origin) => {
      const { autoUpdates } = installAndCaptureAutoUpdates(() => ({
        ...OFFLINE_COMPUTER_USE_HOST_STATE,
        lastCommandAt: new Date().toISOString(),
      }));

      if (origin !== "startup") {
        emitAutoUpdaterEvent("update-not-available");
        if (origin === "interval") {
          runScheduledUpdateCheck();
        } else {
          expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
        }
      }
      const nativeCallCount = origin === "startup" ? 1 : 2;

      emitAutoUpdaterEvent("update-available");
      runScheduledUpdateCheck();
      expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(
        nativeCallCount,
      );
      expect(mocks.nativeUpdate.state).toBe("downloading");

      emitAutoUpdaterEvent("update-downloaded");
      runScheduledUpdateCheck();
      expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(
        nativeCallCount,
      );
      expect(mocks.nativeUpdate.state).toBe("settling");
      expectActiveUpdateCheckListenerCount(0);

      finishNativeSettle();
      expect(mocks.nativeUpdate.state).toBe("idle");
      expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
      runScheduledUpdateCheck();
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(
        nativeCallCount + 1,
      );
      expectActiveUpdateCheckListenerCount(1);
      expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
    },
  );

  it("releases immediately after no-update and lets later checks run", async () => {
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );

    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    emitAutoUpdaterEvent("update-not-available");
    await flushAsyncCallbacks();

    expectActiveUpdateCheckListenerCount(0);
    expect(mocks.scheduledNativeSettles).toHaveLength(0);
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expectActiveUpdateCheckListenerCount(1);
  });

  it("keeps settle ownership when a later updater error arrives", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { autoUpdates } = installAndCaptureAutoUpdates(() => ({
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    }));
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    const error = new Error("install failed");

    emitAutoUpdaterEvent("error", error);

    expect(consoleError).toHaveBeenCalledWith(
      "Desktop auto-updater error",
      error,
    );
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.nativeUpdate.state).toBe("settling");
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();

    finishNativeSettle();
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    consoleError.mockRestore();
  });

  it("shows genuine errors from a requested check", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );

    emitAutoUpdaterEvent("update-available");
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    runScheduledUpdateCheck();
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    const error = new Error("feed unavailable");
    emitAutoUpdaterEvent("error", error);
    await flushAsyncCallbacks();

    expect(consoleError).toHaveBeenCalledWith(
      "Desktop update check failed",
      error,
    );
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Unable to Check for Updates",
        message: "Okou could not check for updates.",
        detail: "feed unavailable",
      }),
    );
    expectActiveUpdateCheckListenerCount(0);
    expect(mocks.scheduledNativeSettles).toHaveLength(0);
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    consoleError.mockRestore();
  });

  it("cleans up and reports a synchronous requested-check failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { autoUpdates } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );
    emitAutoUpdaterEvent("update-not-available");
    const error = new Error("feed unavailable");
    mocks.autoUpdater.checkForUpdates.mockImplementationOnce(() => {
      throw error;
    });

    expect(autoUpdates.checkForUpdates("Okou")).toBe(false);
    await flushAsyncCallbacks();

    expectActiveUpdateCheckListenerCount(0);
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Unable to Check for Updates",
        detail: "feed unavailable",
      }),
    );
    expect(autoUpdates.checkForUpdates("Okou")).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);

    consoleError.mockRestore();
  });

  it("silently restarts after a downloaded update when Computer Use is offline", async () => {
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("leaves the app running when the quit preparation rejects", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );
    prepareForQuitAndInstall.mockRejectedValueOnce(
      new Error("Computer Use could not stop"),
    );

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Desktop update install failed",
        expect.any(Error),
      );
    });

    // The preparation owns the teardown steps that assume the app is going
    // away, and none of them has happened: the restart never reached the
    // point that closes a window.
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    finishNativeSettle();
    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(2);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    consoleError.mockRestore();
  });

  it("defers without prompting during recent command activity", async () => {
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(() => ({
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    }));

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await flushAsyncCallbacks();

    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs a deferred update on the next check after activity stops", async () => {
    let hostState: ComputerUseHostRuntimeState = {
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    };
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(
      () => hostState,
    );

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await flushAsyncCallbacks();
    finishNativeSettle();

    hostState = OFFLINE_COMPUTER_USE_HOST_STATE;
    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("keeps a downloaded update pending across active scheduled checks", async () => {
    let hostState: ComputerUseHostRuntimeState = {
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    };
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(
      () => hostState,
    );

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await flushAsyncCallbacks();
    finishNativeSettle();

    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");
    emitAutoUpdaterEvent("update-not-available");
    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");
    emitAutoUpdaterEvent("update-not-available");
    await flushAsyncCallbacks();

    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    hostState = OFFLINE_COMPUTER_USE_HOST_STATE;
    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it("defers when Computer Use activity inspection fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let inspectionFails = true;
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(() => {
      if (inspectionFails) {
        throw new Error("state unavailable");
      }
      return OFFLINE_COMPUTER_USE_HOST_STATE;
    });

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await flushAsyncCallbacks();
    finishNativeSettle();

    expect(warn).toHaveBeenCalledWith(
      "Unable to inspect Computer Use activity for update",
      expect.any(Error),
    );
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    inspectionFails = false;
    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    warn.mockRestore();
  });

  it("starts only one install while an update restart is in progress", async () => {
    const { prepareForQuitAndInstall } = installAndCaptureAutoUpdates(
      () => OFFLINE_COMPUTER_USE_HOST_STATE,
    );
    let finishPreparation: (() => void) | undefined;
    prepareForQuitAndInstall.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );

    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    });
    finishNativeSettle();

    runScheduledUpdateCheck();
    emitAutoUpdaterEvent("checking-for-update");
    emitAutoUpdaterEvent("update-available");
    emitAutoUpdaterEvent("update-downloaded");
    await flushAsyncCallbacks();

    expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    finishPreparation?.();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    emitAutoUpdaterEvent("checking-for-update");
    await flushAsyncCallbacks();
    expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
