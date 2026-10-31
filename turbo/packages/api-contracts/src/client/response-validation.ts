import type { ApiFetcherResponse, ClientRoute } from "./types";
import { validateResponse } from "../contracts/trpc-contract";

export function validateClientResponse<TResponse extends ApiFetcherResponse>(
  route: ClientRoute,
  response: TResponse,
): TResponse {
  if ("responses" in route) {
    return validateResponse({ appRoute: route, response });
  }

  throw new Error(
    `Response validator missing for ${route.method} ${route.path}`,
  );
}
