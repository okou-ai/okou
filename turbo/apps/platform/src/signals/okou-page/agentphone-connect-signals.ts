import { command } from "ccstate";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseAgentPhoneConnectParams } from "./agentphone-connect-params.ts";

export const connectAgentPhoneAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const parsed = parseAgentPhoneConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(apiClient$)(integrationsAgentPhoneContract);
    const result = await accept(
      client.connectAgentPhone({
        headers: {},
        fetchOptions: { signal },
        body: parsed.params,
      }),
      [200],
    );
    signal.throwIfAborted();

    return result.body;
  },
);
