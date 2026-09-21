import { stoppedOkouDriverState } from "./test/desktop-driver-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopComputerUseAutoStartSupervisor } from "./desktop-computer-use-autostart";
import {
  OFFLINE_COMPUTER_USE_HOST_STATE,
  type ComputerUseHostRuntimeStatus,
  type DesktopComputerUseState,
} from "./computer-use-types";

function computerUseState(
  status: ComputerUseHostRuntimeStatus,
): DesktopComputerUseState {
  return {
    driver: stoppedOkouDriverState,
    platform: "darwin",
    supported: true,
    permissions: { accessibility: true, screenRecording: true },
    host: { ...OFFLINE_COMPUTER_USE_HOST_STATE, status },
    keepAwake: { enabled: false, active: false },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DesktopComputerUseAutoStartSupervisor", () => {
  it("coalesces launch auto-start requests", async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => {});
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => computerUseState("offline"),
      start,
      logError: vi.fn(),
    });

    supervisor.requestStart();
    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(start).toHaveBeenCalledOnce();
  });

  it("restarts only recoverable terminal runtime states", async () => {
    vi.useFakeTimers();
    let state = computerUseState("online");
    const start = vi.fn(async () => {});
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => state,
      start,
      logError: vi.fn(),
    });

    supervisor.restartRecoverableRuntimeState();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();

    state = computerUseState("unauthenticated");
    supervisor.restartRecoverableRuntimeState();
    await vi.advanceTimersByTimeAsync(0);

    expect(start).toHaveBeenCalledOnce();
  });

  it("does not recursively restart while an auto-start is running", async () => {
    vi.useFakeTimers();
    const startGate = deferred<void>();
    let supervisor!: DesktopComputerUseAutoStartSupervisor;
    const start = vi.fn(async () => {
      supervisor.restartRecoverableRuntimeState();
      await startGate.promise;
    });
    supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => computerUseState("unauthenticated"),
      start,
      logError: vi.fn(),
    });

    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledOnce();

    startGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(start).toHaveBeenCalledOnce();
  });

  it("paces further attempts while the runtime stays recoverable", async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => {});
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => computerUseState("unauthenticated"),
      start,
      logError: vi.fn(),
    });

    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("stops pacing once the runtime comes online", async () => {
    vi.useFakeTimers();
    let state = computerUseState("unauthenticated");
    const start = vi.fn(async () => {
      state = computerUseState("online");
    });
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => state,
      start,
      logError: vi.fn(),
    });

    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(start).toHaveBeenCalledOnce();
  });

  it("stops pacing when recovery needs the user", async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => {});
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => computerUseState("unauthenticated"),
      start,
      canRecover: () => false,
      logError: vi.fn(),
    });

    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(start).toHaveBeenCalledOnce();
  });

  it("logs background auto-start failures", async () => {
    vi.useFakeTimers();
    const error = new Error("start failed");
    const logError = vi.fn();
    const supervisor = new DesktopComputerUseAutoStartSupervisor({
      getState: () => computerUseState("offline"),
      start: vi.fn(async () => {
        throw error;
      }),
      logError,
    });

    supervisor.requestStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(logError).toHaveBeenCalledWith(error);
  });
});
