import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { integrationsWhatsappContract } from "@okouai/api-contracts/client/integrations-whatsapp";
import type {
  WhatsappLinkCodeResponse,
  WhatsappLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-whatsapp";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalConnectDialogOpen$ = state(false);
const internalWhatsappStatus$ = state<WhatsappLinkStatusResponse | null>(null);

export const whatsappConnectDialogOpen$ = computed((get) => {
  return get(internalConnectDialogOpen$);
});

export const setWhatsappConnectDialogOpen$ = command(
  ({ set }, value: boolean) => {
    set(internalConnectDialogOpen$, value);
  },
);

export const whatsappLinkStatus$ = computed(
  async (get): Promise<WhatsappLinkStatusResponse> => {
    get(internalReload$);
    const client = get(apiClient$)(integrationsWhatsappContract, {
      apiBase: "api",
    });
    const result = await accept(client.getLinkStatus({ headers: {} }), [200]);
    return result.body;
  },
);

export const createWhatsappLinkCode$ = command(
  async ({ get }, signal: AbortSignal): Promise<WhatsappLinkCodeResponse> => {
    const client = get(apiClient$)(integrationsWhatsappContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.createLinkCode({
        headers: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const openWhatsappConnection$ = command(
  async ({ set }, signal: AbortSignal): Promise<WhatsappLinkCodeResponse> => {
    set(setWhatsappConnectDialogOpen$, true);
    return await set(createWhatsappLinkCode$, signal);
  },
);

export const reloadWhatsappLinkStatus$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasWhatsappStatusChanged(
  previous: WhatsappLinkStatusResponse | null,
  next: WhatsappLinkStatusResponse,
): previous is WhatsappLinkStatusResponse {
  return previous !== null && previous.linked !== next.linked;
}

function toastWhatsappStatusChange(
  previous: WhatsappLinkStatusResponse,
  next: WhatsappLinkStatusResponse,
): void {
  if (next.linked && !previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.works.whatsapp.connected;
      }),
    );
    return;
  }
  if (!next.linked && previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.works.whatsapp.disconnected;
      }),
    );
  }
}

const refreshWhatsappFromChange$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const previous = get(internalWhatsappStatus$);
    set(reloadWhatsappLinkStatus$);
    const data = await get(whatsappLinkStatus$);
    signal.throwIfAborted();
    set(internalWhatsappStatus$, data);

    if (hasWhatsappStatusChanged(previous, data)) {
      toastWhatsappStatusChange(previous, data);
      if (data.linked) {
        set(internalConnectDialogOpen$, false);
      }
    }

    return false;
  },
);

export const watchWhatsappConnection$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(internalConnectDialogOpen$, false);
    if (!get(featureSwitch$)[FeatureSwitchKey.WhatsappIntegration]) {
      return;
    }
    const current = await get(whatsappLinkStatus$);
    signal.throwIfAborted();
    set(internalWhatsappStatus$, current);
    set(
      setAblyLoop$,
      {
        topic: "agentphone:changed",
        loopCommand$: refreshWhatsappFromChange$,
      },
      signal,
    );
  },
);

export const disconnectWhatsapp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsWhatsappContract, {
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
    set(reloadWhatsappLinkStatus$);
  },
);
