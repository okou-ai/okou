import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalConnectDialogOpen$ = state(false);
const internalAgentPhoneStatus$ = state<AgentPhoneLinkStatusResponse | null>(
  null,
);

export const agentPhoneConnectDialogOpen$ = computed((get) => {
  return get(internalConnectDialogOpen$);
});

export const setAgentPhoneConnectDialogOpen$ = command(
  ({ set }, value: boolean) => {
    set(internalConnectDialogOpen$, value);
  },
);

export const agentPhoneLinkStatus$ = computed(
  async (get): Promise<AgentPhoneLinkStatusResponse> => {
    get(internalReload$);
    const client = get(apiClient$)(integrationsAgentPhoneContract, {
      apiBase: "api",
    });
    const result = await accept(client.getLinkStatus({ headers: {} }), [200]);
    return result.body;
  },
);

const reloadAgentPhoneLinkStatus$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasAgentPhoneStatusChanged(
  previous: AgentPhoneLinkStatusResponse | null,
  next: AgentPhoneLinkStatusResponse,
): previous is AgentPhoneLinkStatusResponse {
  return previous !== null && previous.linked !== next.linked;
}

function toastAgentPhoneStatusChange(
  previous: AgentPhoneLinkStatusResponse,
  next: AgentPhoneLinkStatusResponse,
): void {
  if (next.linked && !previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.agentphoneConnected;
      }),
    );
    return;
  }
  if (!next.linked && previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.agentphoneDisconnected;
      }),
    );
  }
}

const refreshAgentPhoneFromChange$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const previous = get(internalAgentPhoneStatus$);
    set(reloadAgentPhoneLinkStatus$);
    const data = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    set(internalAgentPhoneStatus$, data);

    if (hasAgentPhoneStatusChanged(previous, data)) {
      toastAgentPhoneStatusChange(previous, data);
      if (data.linked) {
        set(internalConnectDialogOpen$, false);
      }
    }

    return false;
  },
);

export const watchAgentPhoneConnection$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    set(internalAgentPhoneStatus$, current);
    set(
      setAblyLoop$,
      {
        topic: "agentphone:changed",
        loopCommand$: refreshAgentPhoneFromChange$,
      },
      signal,
    );
  },
);

export const disconnectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsAgentPhoneContract, {
      apiBase: "api",
    });
    await accept(
      client.unlink({
        headers: {},
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadAgentPhoneLinkStatus$);
  },
);
