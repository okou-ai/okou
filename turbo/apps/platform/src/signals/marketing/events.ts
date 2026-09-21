import { command } from "ccstate";
import {
  marketingEventsContract,
  type MarketingEventRequest,
} from "@okouai/api-contracts/contracts/marketing-events";
import {
  initClient,
  trpcRestFetchApi,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../../lib/client-telemetry.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { clerk$ } from "../auth.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detach, Reason } from "../utils.ts";

const postEvent$ = command(
  async ({ get }, tag: MarketingEventRequest["tag"], signal: AbortSignal) => {
    const baseUrl = resolveApiBaseForTarget("www");
    const eventId = crypto.randomUUID();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    const sessionId = clerk.session?.id;
    if (!userId || !orgId) {
      throw new Error("Authenticated user and organization are required");
    }
    const token = await get(apiClientRuntime$).getToken(signal);
    signal.throwIfAborted();
    if (
      clerk.user?.id !== userId ||
      clerk.organization?.id !== orgId ||
      clerk.session?.id !== sessionId
    ) {
      throw new DOMException("Marketing event identity changed", "AbortError");
    }
    const client = initClient(marketingEventsContract, {
      baseUrl,
      api: (args) => {
        return trpcRestFetchApi(args, { parseResponseBody: false });
      },
    });

    recordClientTelemetry(
      startClientTelemetryMeasurement(),
      {
        event_name: "marketing.event.send",
        tag,
        user_id: userId,
        org_id: orgId,
      },
      "started",
    );
    await client.record({
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: { tag, eventId },
      fetchOptions: { credentials: "include", keepalive: true, signal },
    });
  },
);

/** Root-owned fire-and-forget events never delay navigation or retry. */
export const sendEvent$ = command(
  ({ get, set }, tag: MarketingEventRequest["tag"]): void => {
    const signal = get(rootSignal$);
    detach(set(postEvent$, tag, signal), Reason.Daemon, "marketing event");
  },
);
