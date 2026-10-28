import { command, computed, state } from "ccstate";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";
import { reloadAgentPhoneLinkStatus$ } from "./agentphone.ts";

const reload$ = state(0);

export const reloadAgentPhoneConnectStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

export const agentPhoneConnectStatus$ = computed(async (get) => {
  get(reload$);
  const parsed = parseAgentPhoneConnectParams(get(searchParams$));
  if (!parsed.ok) {
    return null;
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
    const parsed = parseAgentPhoneConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(apiClient$)(integrationsAgentPhoneContract);
    const result = await accept(
      client.connectAgentPhone({
        headers: {},
        fetchOptions: { signal },
        body: {
          ...parsed.params,
          ...(replacePhoneHandle ? { replacePhoneHandle } : {}),
        },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadAgentPhoneLinkStatus$);
    return result.body;
  },
);
