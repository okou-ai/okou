import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalTeamsStatus$ = state<TeamsConnectStatus | null>(null);

export const teamsOrgData$ = computed(async (get) => {
  get(internalReload$);
  const client = get(apiClient$)(teamsConnectContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

const reloadTeamsOrg$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasTeamsStatusChanged(
  previous: TeamsConnectStatus | null,
  next: TeamsConnectStatus,
): previous is TeamsConnectStatus {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastTeamsStatusChange(
  previous: TeamsConnectStatus,
  next: TeamsConnectStatus,
): void {
  if (next.isConnected && !previous.isConnected) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.teamsConnected;
      }),
    );
    return;
  }
  if (next.isInstalled && !previous.isInstalled) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.teamsInstalled;
      }),
    );
    return;
  }
  if (!next.isInstalled && previous.isInstalled) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.teamsUninstalled;
      }),
    );
    return;
  }
  if (!next.isConnected && previous.isConnected) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.teamsDisconnected;
      }),
    );
    return;
  }
  toast.success(
    i18n.t(($) => {
      return $.connectors.providerSettings.toasts.teamsUpdated;
    }),
  );
}

const showTeamsUninstallDialogState$ = state(false);

export const showTeamsUninstallDialog$ = computed((get) => {
  return get(showTeamsUninstallDialogState$);
});

export const setShowTeamsUninstallDialog$ = command(
  ({ set }, show: boolean) => {
    set(showTeamsUninstallDialogState$, show);
  },
);

export const disconnectTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(teamsConnectContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    set(reloadTeamsOrg$);
  },
);

export const uninstallTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(teamsConnectContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
    set(reloadTeamsOrg$);
  },
);

const onTeamsChanged$ = command(async ({ get, set }, signal: AbortSignal) => {
  const previous = get(internalTeamsStatus$);
  set(reloadTeamsOrg$);
  const next = await get(teamsOrgData$);
  signal.throwIfAborted();
  set(internalTeamsStatus$, next);

  if (hasTeamsStatusChanged(previous, next)) {
    toastTeamsStatusChange(previous, next);
  }

  return false;
});

export const watchTeamsConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = await get(teamsOrgData$);
    signal.throwIfAborted();
    set(internalTeamsStatus$, current);

    set(
      setAblyLoop$,
      { topic: "teams:changed", loopCommand$: onTeamsChanged$ },
      signal,
    );
  },
);
