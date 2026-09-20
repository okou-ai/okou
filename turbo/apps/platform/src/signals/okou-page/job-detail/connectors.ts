import { command, computed, state } from "ccstate";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { apiClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import {
  agentConnectorAuthorizations,
  reloadAgentConnectorAuthorizations$,
} from "../agent-connector-authorizations.ts";
import { agentDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Authorized connectors: User↔Agent↔Connector (per-agent grant)
//  - GET/PUT /api/agents/:id/user-connectors
//  - Wire data: { enabledConnectorSlugs: string[] } — connector slugs this user
//    authorized for this agent
// ---------------------------------------------------------------------------

const authorizedConnectors$ = computed(async (get): Promise<string[]> => {
  const detail = await get(agentDetail$);
  if (!detail?.agentId) {
    return [];
  }
  const authorizations = await get(
    agentConnectorAuthorizations({ agentId: detail.agentId }),
  );
  return [...authorizations.enabledConnectorSlugs];
});

type AuthorizedConnectorsDraft = {
  readonly agentId: string;
  readonly enabledConnectorSlugs: readonly string[];
};

const internalAuthorizedConnectors$ = state<AuthorizedConnectorsDraft | null>(
  null,
);

export const agentAuthorizedConnectors$ = computed(
  async (get): Promise<string[]> => {
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return [];
    }
    const local = get(internalAuthorizedConnectors$);
    if (local?.agentId === detail.agentId) {
      return [...local.enabledConnectorSlugs];
    }
    return await get(authorizedConnectors$);
  },
);

const setAgentConnectorDraft$ = command(
  async (
    { get, set },
    args: {
      readonly name: string;
      readonly operation: "add" | "remove";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      return;
    }
    const current = get(internalAuthorizedConnectors$);
    const base =
      current?.agentId === detail.agentId
        ? current.enabledConnectorSlugs
        : await get(authorizedConnectors$);
    signal.throwIfAborted();
    const enabledConnectorSlugs =
      args.operation === "add"
        ? Array.from(new Set([...base, args.name]))
        : base.filter((s) => {
            return s !== args.name;
          });
    set(internalAuthorizedConnectors$, {
      agentId: detail.agentId,
      enabledConnectorSlugs,
    });
  },
);

const clearAgentConnectorDraft$ = command(({ set }, agentId: string): void => {
  set(internalAuthorizedConnectors$, (current) => {
    return current?.agentId === agentId ? null : current;
  });
});

export const authorizeAgentConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(setAgentConnectorDraft$, { name, operation: "add" }, signal);
  },
);

export const deauthorizeAgentConnector$ = command(
  async ({ set }, name: string, signal: AbortSignal) => {
    await set(setAgentConnectorDraft$, { name, operation: "remove" }, signal);
  },
);

export const discardAgentConnectorsDraft$ = command(({ set }) => {
  set(internalAuthorizedConnectors$, null);
});

export const saveAgentConnectors$ = command(
  async (
    { get, set },
    name: string,
    operation: "add" | "remove",
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const client = get(apiClient$)(userBuiltinConnectorsContract);
    await withCleanup(
      (async () => {
        await accept(
          client.update({
            params: { id: detail.agentId },
            body: { enabledConnectorSlugs: [name], operation },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
      })(),
      () => {
        set(clearAgentConnectorDraft$, detail.agentId);
        set(reloadAgentConnectorAuthorizations$);
      },
    );
  },
);
