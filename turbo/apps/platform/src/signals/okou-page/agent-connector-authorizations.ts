import { command, computed, state, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { withCleanup } from "../utils.ts";

interface AgentConnectorAuthorizations {
  readonly agentId: string;
  readonly enabledConnectorSlugs: readonly ConnectorSlug[];
}

type MissingPolicy = "throw" | "null";

const internalAgentConnectorAuthorizationsReload$ = state(0);

const agentConnectorAuthorizationsReload$ = computed((get) => {
  return get(internalAgentConnectorAuthorizationsReload$);
});

export const reloadAgentConnectorAuthorizations$ = command(({ set }) => {
  set(internalAgentConnectorAuthorizationsReload$, (x) => {
    return x + 1;
  });
});

function pendingRequestKey(params: {
  readonly agentId: string;
  readonly missing: MissingPolicy;
  readonly reloadGeneration: number;
}): string {
  return JSON.stringify([
    params.reloadGeneration,
    params.missing,
    params.agentId,
  ]);
}

interface AgentConnectorAuthorizationRequestBroker {
  load(params: {
    readonly createClient: ApiClientFactory;
    readonly agentId: string;
    readonly missing: MissingPolicy;
    readonly reloadGeneration: number;
  }): Promise<AgentConnectorAuthorizations | null>;
}

interface ResolvedAgentConnectorAuthorizationRequest {
  readonly key: string;
  readonly value: AgentConnectorAuthorizations | null;
}

function createAgentConnectorAuthorizationRequestBroker(): AgentConnectorAuthorizationRequestBroker {
  const pendingRequestsByClient = new WeakMap<
    ApiClientFactory,
    Map<string, Promise<AgentConnectorAuthorizations | null>>
  >();
  const latestRequestedKeyByClient = new WeakMap<ApiClientFactory, string>();
  const latestResolvedByClient = new WeakMap<
    ApiClientFactory,
    ResolvedAgentConnectorAuthorizationRequest
  >();

  return {
    load(params) {
      const key = pendingRequestKey(params);
      latestRequestedKeyByClient.set(params.createClient, key);
      const resolved = latestResolvedByClient.get(params.createClient);
      if (resolved?.key === key) {
        return Promise.resolve(resolved.value);
      }
      let pendingRequests = pendingRequestsByClient.get(params.createClient);
      if (!pendingRequests) {
        pendingRequests = new Map();
        pendingRequestsByClient.set(params.createClient, pendingRequests);
      }

      const pendingRequest = pendingRequests.get(key);
      if (pendingRequest) {
        return pendingRequest;
      }

      const client = params.createClient(userBuiltinConnectorsContract);
      const response = client.get({ params: { id: params.agentId } });
      const load = async (): Promise<AgentConnectorAuthorizations | null> => {
        const result =
          params.missing === "null"
            ? await accept(response, [200, 404])
            : await accept(response, [200]);
        if (result.status === 404) {
          return null;
        }
        return {
          agentId: params.agentId,
          enabledConnectorSlugs: result.body.enabledConnectorSlugs,
        };
      };

      const loadAndRemember = async () => {
        const value = await load();
        if (latestRequestedKeyByClient.get(params.createClient) === key) {
          latestResolvedByClient.set(params.createClient, { key, value });
        }
        return value;
      };
      const sharedRequest = withCleanup(loadAndRemember(), () => {
        pendingRequests.delete(key);
        if (pendingRequests.size === 0) {
          pendingRequestsByClient.delete(params.createClient);
        }
      });
      pendingRequests.set(key, sharedRequest);
      return sharedRequest;
    },
  };
}

const agentConnectorAuthorizationRequestBroker$ = computed(() => {
  return createAgentConnectorAuthorizationRequestBroker();
});

function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "throw" },
): Computed<Promise<AgentConnectorAuthorizations>>;
function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "null" },
): Computed<Promise<AgentConnectorAuthorizations | null>>;
function createAuthorizationsAtom(
  agentId: string,
  options: { readonly missing: "throw" | "null" },
): Computed<Promise<AgentConnectorAuthorizations | null>> {
  return computed(async (get): Promise<AgentConnectorAuthorizations | null> => {
    const reloadGeneration = get(agentConnectorAuthorizationsReload$);
    return await get(agentConnectorAuthorizationRequestBroker$).load({
      createClient: get(apiClient$),
      agentId,
      missing: options.missing,
      reloadGeneration,
    });
  });
}

export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing: "null";
}): Computed<Promise<AgentConnectorAuthorizations | null>>;
export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing?: "throw";
}): Computed<Promise<AgentConnectorAuthorizations>>;
export function agentConnectorAuthorizations(params: {
  readonly agentId: string;
  readonly missing?: "throw" | "null";
}): Computed<Promise<AgentConnectorAuthorizations | null>> {
  if (params.missing === "null") {
    return createAuthorizationsAtom(params.agentId, { missing: "null" });
  }
  return createAuthorizationsAtom(params.agentId, { missing: "throw" });
}

export function isAgentConnectorAuthorized(params: {
  readonly agentId: string;
  readonly connectorSlug: ConnectorSlug;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const authorizations = await get(
      agentConnectorAuthorizations({ agentId: params.agentId }),
    );
    return authorizations.enabledConnectorSlugs.includes(params.connectorSlug);
  });
}
