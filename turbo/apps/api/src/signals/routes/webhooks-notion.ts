import { command } from "ccstate";
import { webhookNotionContract } from "@okouai/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { dispatchNotionWebhook$ } from "../services/notion-automation-event.service";

function jsonError(message: string, status: 400 | 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postNotionWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();

    const result = await set(
      dispatchNotionWebhook$,
      {
        rawBody,
        signature: request.raw.headers.get("X-Notion-Signature"),
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.kind) {
      case "ok": {
        return Response.json({
          success: true,
          kind: result.webhookKind,
          pending: result.pending,
          refreshed: result.refreshed,
          duplicates: result.duplicates,
        });
      }
      case "unauthorized": {
        return jsonError("Unauthorized", 401);
      }
      case "bad_request": {
        return jsonError(result.message, 400);
      }
      case "config_error":
      case "provider_unavailable": {
        return jsonError(result.message, 503);
      }
    }
  },
);

export const webhooksNotionRoutes: readonly RouteEntry[] = [
  {
    route: webhookNotionContract.post,
    handler: postNotionWebhook$,
  },
];
