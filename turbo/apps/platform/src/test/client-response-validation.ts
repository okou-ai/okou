import { clientDescriptorContracts } from "@okouai/api-contracts/client/testing";
import type {
  ApiFetcherResponse,
  ClientRoute,
} from "@okouai/api-contracts/client/types";
import {
  validateResponse,
  type AppRoute,
} from "@okouai/api-contracts/contracts/trpc-contract";

const sourceRoutes: ReadonlyMap<ClientRoute, AppRoute> = new Map(
  clientDescriptorContracts.flatMap(([descriptor, contract]) => {
    return Object.entries(descriptor).map(([name, route]) => {
      return [route, contract[name]] as const;
    });
  }),
);

function sourceRoute(route: ClientRoute): Pick<AppRoute, "responses"> {
  if ("responses" in route) {
    return route;
  }

  const source = sourceRoutes.get(route);
  if (!source) {
    throw new Error(
      `Response validator missing for ${route.method} ${route.path}`,
    );
  }
  return source;
}

export function validateClientResponse<TResponse extends ApiFetcherResponse>(
  route: ClientRoute,
  response: TResponse,
): TResponse {
  return validateResponse({ appRoute: sourceRoute(route), response });
}
