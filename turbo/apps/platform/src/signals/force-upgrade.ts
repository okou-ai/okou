import { command, state } from "ccstate";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";

const FORCE_UPGRADE_REQUIRED_EVENT = "force-upgrade-required";

const forceUpgradeDialogOpenState$ = state(false);

export const forceUpgradeDialogOpen$ = forceUpgradeDialogOpenState$;

export function reportForceUpgradeRequired(): void {
  window.dispatchEvent(new Event(FORCE_UPGRADE_REQUIRED_EVENT));
}

export function reportForceUpgradeResponse(response: {
  readonly status: number;
}): boolean {
  if (response.status === CLIENT_FORCE_UPGRADE_STATUS) {
    reportForceUpgradeRequired();
    return true;
  }
  return false;
}

export const listenForceUpgradeDialog$ = command(
  ({ set }, signal: AbortSignal) => {
    if (signal.aborted) {
      return;
    }

    const onRequired = () => {
      set(forceUpgradeDialogOpenState$, true);
    };
    const removeListener = () => {
      window.removeEventListener(FORCE_UPGRADE_REQUIRED_EVENT, onRequired);
    };

    window.addEventListener(FORCE_UPGRADE_REQUIRED_EVENT, onRequired);
    signal.addEventListener("abort", removeListener, { once: true });
  },
);
