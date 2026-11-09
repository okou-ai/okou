import type { ComputerUseAuthorizationContinuation } from "@okouai/api-contracts/contracts/computer-use";
import { i18n } from "../../i18n/index.ts";

export function computerUseAuthorizationBlocker(
  continuation: ComputerUseAuthorizationContinuation | undefined,
): string | null {
  switch (continuation?.blockedReason) {
    case "run_active": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.blocked.runActive;
      });
    }
    case "chat_busy": {
      return i18n.t(($) => {
        return $.desktopShellAuthorization.blocked.chatBusy;
      });
    }
    case "request_superseded": {
      return i18n.t(($) => {
        return $.authorization.computerUse.requestSuperseded;
      });
    }
    default: {
      return null;
    }
  }
}
