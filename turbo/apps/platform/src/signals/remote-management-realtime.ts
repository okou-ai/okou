import { command, type Command } from "ccstate";
import { sshChangedPayloadSchema } from "@okouai/api-contracts/validators/ssh-access";

import { currentOrgInfo$ } from "./auth.ts";
import { invalidateCloudflareAccess$ } from "./cloudflare-access.ts";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import { invalidateSsh$ } from "./ssh.ts";
import { invalidateTailscale$ } from "./tailscale.ts";
import { onRef } from "./utils.ts";

function createManagementPanelSubscription(refresh$: Command<void, []>) {
  const catchUp$ = command(({ set }) => {
    set(refresh$);
    return false;
  });
  const receive$ = command(
    async ({ get, set }, payload: unknown, signal: AbortSignal) => {
      const parsed = sshChangedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return false;
      }
      const org = await get(currentOrgInfo$);
      signal.throwIfAborted();
      if (org?.id === parsed.data.orgId) {
        set(refresh$);
      }
      return false;
    },
  );
  return onRef(
    command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
      // Only this committed management panel consumes these notifications.
      // Leaving its scope releases the listener; the composer uses snapshots.
      set(
        setAblyPayloadLoop$,
        {
          topic: "ssh:changed",
          loopCommand$: receive$,
          initializeCommand$: catchUp$,
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }),
  );
}

export const mountRemoteControlPanel$ =
  createManagementPanelSubscription(invalidateSsh$);

const refreshPrivateNetworkUsage$ = command(({ set }) => {
  set(invalidateCloudflareAccess$);
  set(invalidateTailscale$);
});

export const mountPrivateNetworkPanel$ = createManagementPanelSubscription(
  refreshPrivateNetworkUsage$,
);
