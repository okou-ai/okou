import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { integrationsSlackContract } from "@okouai/api-contracts/client/integrations-slack";
import type { SlackOrgStatus } from "@okouai/api-contracts/contracts/integrations-slack";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import {
  pathname$,
  searchParams$,
  hash$,
  replacePathSilently$,
  replaceSearchParams$,
} from "../route.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalSlackStatus$ = state<SlackOrgStatus | null>(null);

export const slackOrgData$ = computed(async (get) => {
  get(internalReload$);
  const client = get(apiClient$)(integrationsSlackContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

export const reloadSlackOrg$ = command(({ set }) => {
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
      previous.isConnected !== next.isConnected ||
      (previous.scopeMismatch === true && next.scopeMismatch === false))
  );
}

function toastSlackStatusChange(
  previous: SlackOrgStatus,
  next: SlackOrgStatus,
): void {
  if (previous.scopeMismatch === true && next.scopeMismatch === false) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.slackPermissionsUpdated;
      }),
    );
    return;
  }
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
    set(showUninstallDialogState$, false);
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

// Retained Slack callbacks and copied links (#40196). Keep until their public
// URL contract and serving/rollback writers have been retired by the PMO.
export const initSlackOrg$ = command(({ get, set }) => {
  const path = get(pathname$).toLowerCase().replace(/\/$/u, "") || "/";
  const params = new URLSearchParams(get(searchParams$));
  const legacyResult =
    path === "/" &&
    params.get("tab") === "works" &&
    ["updated", "installed", "connected"].some((key) => {
      return params.get(key) === "1";
    }) &&
    [...params.keys()].every((key) => {
      return ["tab", "updated", "installed", "connected"].includes(key);
    });
  if (path === "/slack/failed" || legacyResult) {
    const fragment = get(hash$);
    params.delete("tab");
    set(
      replacePathSilently$,
      INTEGRATION_SETTINGS_PATHS.slack,
      undefined,
      params,
    );
    if (fragment) {
      set(replaceSearchParams$, params, {}, fragment);
    }
  }
});
