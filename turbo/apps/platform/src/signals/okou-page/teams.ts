import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { teamsConnectContract } from "@okouai/api-contracts/client/teams-connect";
import type { TeamsConnectStatus } from "@okouai/api-contracts/contracts/teams-connect";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { pageVersion$ } from "../page-signal.ts";
import { NEVER_RESOLVED_PROMISE, onDomEventFn, resetSignal } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

type TeamsConnectionState = Pick<
  TeamsConnectStatus,
  "isInstalled" | "isConnected"
>;

// Status requests belong to the page and authenticated actor. Keeping the
// request promise in this graph gives views a loadable without retaining a
// previous actor's result. Requests inherit their caller's route lifetime;
// actor guards reject replaced sessions, and only the latest refresh publishes.
function createTeamsStatus(owner: string | null) {
  const request$ = state<Promise<TeamsConnectStatus>>(NEVER_RESOLVED_PROMISE);
  const previous$ = state<TeamsConnectionState | null>(null);
  const read$ = command(async ({ get }, signal: AbortSignal) => {
    const { client, assertCurrent, identity } = await get(teamsClient$);
    signal.throwIfAborted();
    assertCurrent();
    if (identity !== owner) {
      throw new DOMException("Teams owner changed", "AbortError");
    }
    const result = await accept(
      client.getStatus({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    assertCurrent();
    return result.body;
  });
  const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const request = set(read$, signal);
    set(request$, request);
    const next = await request;
    signal.throwIfAborted();
    if (get(request$) !== request) {
      return false;
    }
    const previous = get(previous$);
    const current = {
      isInstalled: next.isInstalled,
      isConnected:
        next.isConnected &&
        (next.workspaceIdentity === true ||
          (next.isInstalled && !next.pendingInstallation)),
    };
    set(previous$, current);
    if (hasTeamsStatusChanged(previous, current)) {
      toastTeamsStatusChange(previous, current);
    }
    return false;
  });
  return { request$, refresh$ };
}

export const teamsClient$ = computed(async (get) => {
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;
  if (!orgId) {
    throw new DOMException("Teams owner changed", "AbortError");
  }
  const assertCurrent = () => {
    if (
      !identity ||
      !clerk.user ||
      !clerk.organization ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException("Teams owner changed", "AbortError");
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    identity,
    orgId,
    client: createClient(teamsConnectContract, {
      getTokenGuard: () => {
        assertCurrent();
        return assertCurrent;
      },
    }),
  };
});

const teamsStatus$ = computed((get) => {
  const owner = get(authenticatedSessionKey$);
  get(pageVersion$);
  return createTeamsStatus(owner);
});

export const teamsOrgData$ = computed((get) => {
  return get(get(teamsStatus$).request$);
});

export const refreshTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(get(teamsStatus$).refresh$, signal);
  },
);

function hasTeamsStatusChanged(
  previous: TeamsConnectionState | null,
  next: TeamsConnectionState,
): previous is TeamsConnectionState {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastTeamsStatusChange(
  previous: TeamsConnectionState,
  next: TeamsConnectionState,
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
    const { client, assertCurrent } = await get(teamsClient$);
    signal.throwIfAborted();
    assertCurrent();
    await accept(
      client.disconnect({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    await set(refreshTeamsOrg$, signal);
  },
);

export const uninstallTeamsOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { client, assertCurrent } = await get(teamsClient$);
    signal.throwIfAborted();
    assertCurrent();
    await accept(
      client.disconnect({
        query: { action: "uninstall" },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    await set(refreshTeamsOrg$, signal);
    signal.throwIfAborted();
    set(showTeamsUninstallDialogState$, false);
  },
);

const restartTeamsWatch$ = resetSignal();

const watchCurrentTeamsConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal = set(restartTeamsWatch$, signal);
    const status = get(teamsStatus$);
    const refresh = onDomEventFn(async () => {
      if (document.visibilityState === "visible") {
        await set(status.refresh$, signal);
      }
    });
    window.addEventListener("focus", refresh, { signal });
    document.addEventListener("visibilitychange", refresh, { signal });
    set(
      setAblyLoop$,
      {
        topic: "teams:changed",
        loopCommand$: status.refresh$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
    await set(status.refresh$, signal);
    signal.throwIfAborted();
  },
);

// Auth changes can happen without navigation. Cancel the old owner's HTTP,
// DOM listeners and realtime subscription before starting a new status graph.
export const watchTeamsConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    let owner = get(authenticatedSessionKey$);
    const unsubscribe = clerk.addListener(
      onDomEventFn(async () => {
        signal.throwIfAborted();
        const next = get(authenticatedSessionKey$);
        if (next !== owner) {
          owner = next;
          await set(watchCurrentTeamsConnection$, signal);
        }
      }),
    );
    signal.addEventListener("abort", unsubscribe, { once: true });
    await set(watchCurrentTeamsConnection$, signal);
  },
);
