import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/client/agents";
import type {
  ApiFetcherResponse,
  ClientRoute,
  ClientRouter,
} from "@okouai/api-contracts/client/types";
import {
  agentInstructionsContract as sourceAgentInstructionsContract,
  agentsByIdContract as sourceAgentsByIdContract,
  agentsMainContract as sourceAgentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  validateResponse,
  type AppRoute,
  type AppRouter,
} from "@okouai/api-contracts/contracts/trpc-contract";

const descriptorContracts: readonly (readonly [ClientRouter, AppRouter])[] = [
  [agentsMainContract, sourceAgentsMainContract],
  [agentsByIdContract, sourceAgentsByIdContract],
  [agentInstructionsContract, sourceAgentInstructionsContract],
];

function sourceRoute(route: ClientRoute): Pick<AppRoute, "responses"> {
  if ("responses" in route) {
    return route;
  }

  for (const [descriptor, contract] of descriptorContracts) {
    for (const [name, candidate] of Object.entries(descriptor)) {
      if (candidate === route && Object.hasOwn(contract, name)) {
        return contract[name];
      }
    }
  }

  throw new Error(
    `Response validator missing for ${route.method} ${route.path}`,
  );
}

export function validateClientResponse<TResponse extends ApiFetcherResponse>(
  route: ClientRoute,
  response: TResponse,
): TResponse {
  return validateResponse({ appRoute: sourceRoute(route), response });
}
