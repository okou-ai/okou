import { command } from "ccstate";
import { testDiscordDeliveriesContract } from "@okouai/api-contracts/contracts/test-discord-deliveries";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { drainDiscordChatDeliveriesForConnections$ } from "../services/internal-discord-chat-run-callback.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const drainBody$ = bodyResultOf(testDiscordDeliveriesContract.drain);
const drainDiscordReplies$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const body = await get(drainBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    await set(
      drainDiscordChatDeliveriesForConnections$,
      body.data.connectionIds,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { success: true as const } };
  },
);

export const testDiscordDeliveriesRoutes: readonly RouteEntry[] = [
  { route: testDiscordDeliveriesContract.drain, handler: drainDiscordReplies$ },
];
