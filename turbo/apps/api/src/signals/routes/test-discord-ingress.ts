import { command } from "ccstate";
import { testDiscordIngressContract } from "@okouai/api-contracts/contracts/test-discord-ingress";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { drainCanonicalDiscordIngressForConnections$ } from "../services/canonical-discord-ingress-processor.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testDiscordIngressContract.recover);
const recover$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const processed = await set(
    drainCanonicalDiscordIngressForConnections$,
    body.data.connectionIds,
    signal,
  );
  return { status: 200 as const, body: { processed } };
});

/** Test-owned recovery only; deliberately omitted from production route registries. */
export const testDiscordIngressRoutes: readonly RouteEntry[] = [
  { route: testDiscordIngressContract.recover, handler: recover$ },
];
