import type { DesktopAuthCallback } from "./desktop-auth";
import type { DesktopAuthState } from "./desktop-bridge";
import { isComputerUseSetupRequired } from "./computer-use-startup-gate";
import {
  hasRequiredComputerUsePermissions,
  type ComputerUsePermissionState,
} from "./computer-use-types";

export async function isLaunchComputerUseSetupRequired(options: {
  readonly getAuthState: () => Promise<DesktopAuthState>;
  readonly waitForAuthCleanup: () => Promise<void>;
  readonly refreshPermissions: () => Promise<ComputerUsePermissionState>;
  readonly canRecoverSession: () => boolean;
}): Promise<boolean> {
  // Restoration changes the permission revision; probe only after it settles.
  const authState = await options.getAuthState();
  await options.waitForAuthCleanup();
  const permissions = await options.refreshPermissions();
  if (!hasRequiredComputerUsePermissions(permissions)) return true;
  // An indeterminate hidden restore should enter paced auth recovery rather
  // than open setup and leave the host permanently offline. A confirmed
  // sign-out still requires the user to sign in.
  if (authState.status === "signed_out" && options.canRecoverSession())
    return false;
  return isComputerUseSetupRequired({ authState, permissions });
}

interface DesktopLaunchComputerUseOptions {
  readonly pendingCallback: DesktopAuthCallback | null;
  readonly consumeAuthCallback: (
    callback: DesktopAuthCallback,
  ) => Promise<void>;
  readonly isComputerUseSetupRequired: () => Promise<boolean>;
  readonly openSetupWindow: () => Promise<void>;
  readonly requestAutoStartComputerUse: () => void;
  readonly logAuthError: (error: unknown) => void;
  readonly logLaunchError: (error: unknown) => void;
}

async function launchComputerUseWithoutAuthCallback(
  options: DesktopLaunchComputerUseOptions,
): Promise<void> {
  if (await options.isComputerUseSetupRequired()) {
    await options.openSetupWindow();
    return;
  }

  options.requestAutoStartComputerUse();
}

export function startDesktopLaunchComputerUse(
  options: DesktopLaunchComputerUseOptions,
): void {
  if (options.pendingCallback) {
    void options
      .consumeAuthCallback(options.pendingCallback)
      .catch(options.logAuthError);
    return;
  }

  void launchComputerUseWithoutAuthCallback(options).catch((error) => {
    options.logLaunchError(error);
    options.requestAutoStartComputerUse();
  });
}
