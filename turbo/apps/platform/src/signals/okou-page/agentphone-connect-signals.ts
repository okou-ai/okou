import { command, computed, state } from "ccstate";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/client/integrations-agentphone";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pathname$, searchParams$ } from "../route.ts";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";
import {
  reloadAgentPhoneLinkStatus$,
  agentPhoneLinkStatus$,
} from "./agentphone.ts";
import { integrationsWhatsappContract } from "@okouai/api-contracts/client/integrations-whatsapp";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { whatsappLinkStatus$, reloadWhatsappLinkStatus$ } from "./whatsapp.ts";

const reload$ = state(0);

export const isWhatsappConnectPage$ = computed((get) => {
  return (
    get(pathname$).toLowerCase().replace(/\/$/u, "") ===
    INTEGRATION_SETTINGS_PATHS.whatsapp
  );
});

const connectionPath$ = computed((get) => {
  return get(isWhatsappConnectPage$)
    ? INTEGRATION_SETTINGS_PATHS.whatsapp
    : INTEGRATION_SETTINGS_PATHS.agentphone;
});

export const phoneConnectionLinkStatus$ = computed(async (get) => {
  return get(isWhatsappConnectPage$)
    ? await get(whatsappLinkStatus$)
    : await get(agentPhoneLinkStatus$);
});

export const reloadAgentPhoneConnectStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

export const agentPhoneConnectStatus$ = computed(async (get) => {
  get(reload$);
  const parsed = parseAgentPhoneConnectParams(
    get(searchParams$),
    get(connectionPath$),
  );
  if (
    !parsed.ok ||
    (get(isWhatsappConnectPage$) &&
      !get(featureSwitch$)[FeatureSwitchKey.WhatsappIntegration])
  ) {
    return null;
  }
  if (get(isWhatsappConnectPage$)) {
    const client = get(apiClient$)(integrationsWhatsappContract);
    return (
      await accept(
        client.getConnectStatus({ headers: {}, query: parsed.params }),
        [200],
      )
    ).body;
  }
  const client = get(apiClient$)(integrationsAgentPhoneContract);
  const result = await accept(
    client.getConnectStatus({ headers: {}, query: parsed.params }),
    [200],
  );
  return result.body;
});

export const connectAgentPhoneAccount$ = command(
  async (
    { get, set },
    replacePhoneHandle: string | undefined,
    signal: AbortSignal,
  ) => {
    const parsed = parseAgentPhoneConnectParams(
      get(searchParams$),
      get(connectionPath$),
    );
    if (!parsed.ok) {
      return null;
    }

    const body = {
      ...parsed.params,
      ...(replacePhoneHandle ? { replacePhoneHandle } : {}),
    };
    const whatsapp = get(isWhatsappConnectPage$);
    const result = whatsapp
      ? await accept(
          get(apiClient$)(integrationsWhatsappContract).connectWhatsapp({
            headers: {},
            fetchOptions: { signal },
            body,
          }),
          [200],
        )
      : await accept(
          get(apiClient$)(integrationsAgentPhoneContract).connectAgentPhone({
            headers: {},
            fetchOptions: { signal },
            body,
          }),
          [200],
        );
    signal.throwIfAborted();
    set(whatsapp ? reloadWhatsappLinkStatus$ : reloadAgentPhoneLinkStatus$);
    return result.body;
  },
);
