import type { DesktopComputerUseDriverState } from "../computer-use-types";

/** External bridge baseline for renderer, IPC and tray test entry points. */
export const stoppedOkouDriverState: DesktopComputerUseDriverState = {
  actual: null,
  phase: "stopped",
  lifecycleElapsedMs: 0,
  cleanupPending: false,
  error: null,
  canRetry: true,
};
