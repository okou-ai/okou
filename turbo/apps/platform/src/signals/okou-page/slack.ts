import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalSlackStatus$ = state<SlackOrgStatus | null>(null);

export const slackOrgData$ = computed(async (get) => {
  get(internalReload$);
  const client = get(apiClient$)(integrationsSlackContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

const reloadSlackOrg$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasSlackStatusChanged(
  previous: SlackOrgStatus | null,
  next: SlackOrgStatus,
): previous is SlackOrgStatus {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastSlackStatusChange(
  previous: SlackOrgStatus,
  next: SlackOrgStatus,
): void {
  if (next.isConnected && !previous.isConnected) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackConnected;
      }),
    );
    return;
  }
  if (next.isInstalled && !previous.isInstalled) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackInstalled;
      }),
    );
    return;
  }
  if (!next.isInstalled && previous.isInstalled) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackUninstalled;
      }),
    );
    return;
  }
  if (!next.isConnected && previous.isConnected) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackDisconnected;
      }),
    );
    return;
  }
  toast.success(
    i18n.t(($) => {
      return $.connectors.providerSettings.toasts.slackUpdated;
    }),
  );
}

/** True when the org-scoped Slack installation has outdated bot scopes (admin-only). */
export const slackOrgScopeMismatch$ = computed(async (get) => {
  const data = await get(slackOrgData$);
  return data.scopeMismatch === true;
});

// ---------------------------------------------------------------------------
// Uninstall dialog visibility — view-local state managed in signals layer
// ---------------------------------------------------------------------------

const showUninstallDialogState$ = state(false);

/** Whether the uninstall confirmation dialog is visible. */
export const showUninstallDialog$ = computed((get) => {
  return get(showUninstallDialogState$);
});

/** Show or hide the uninstall confirmation dialog. */
export const setShowUninstallDialog$ = command(({ set }, show: boolean) => {
  set(showUninstallDialogState$, show);
});

export const disconnectSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsSlackContract);
    await accept(client.disconnect(), [200]);
    signal.throwIfAborted();
    set(reloadSlackOrg$);
  },
);

export const uninstallSlackOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsSlackContract);
    await accept(client.disconnect({ query: { action: "uninstall" } }), [200]);
    signal.throwIfAborted();
    set(reloadSlackOrg$);
  },
);

const onSlackChanged$ = command(async ({ get, set }, signal: AbortSignal) => {
  const previous = get(internalSlackStatus$);
  set(reloadSlackOrg$);
  const next = await get(slackOrgData$);
  signal.throwIfAborted();
  set(internalSlackStatus$, next);

  if (hasSlackStatusChanged(previous, next)) {
    toastSlackStatusChange(previous, next);
  }

  return false;
});

/**
 * Subscribe to Slack connection changes for the /works route lifetime.
 */
export const watchSlackConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = await get(slackOrgData$);
    signal.throwIfAborted();
    set(internalSlackStatus$, current);

    set(
      setAblyLoop$,
      {
        topic: "slack:changed",
        loopCommand$: onSlackChanged$,
      },
      signal,
    );
  },
);

export const initSlackOrg$ = command((_ctx) => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("updated") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackPermissionsUpdated;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  } else if (params.get("installed") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackInstalled;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("connected") === "1") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackConnected;
      }),
    );
    window.history.replaceState({}, "", window.location.pathname);
  }
});
