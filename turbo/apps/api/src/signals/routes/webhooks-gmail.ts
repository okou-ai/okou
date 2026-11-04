import { command } from "ccstate";
import { webhookGmailContract } from "@okouai/api-contracts/contracts/webhooks";

import type { RouteEntry } from "../route-entry";
import { request$ } from "../context/hono";
import { now } from "../../lib/time";
import { dispatchGmailPubSubPush$ } from "../services/gmail-automation-event.service";

function jsonError(message: string, status: 400 | 401 | 429 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postGmailWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();

    const result = await set(
      dispatchGmailPubSubPush$,
      {
        authorization: request.raw.headers.get("authorization"),
        rawBody,
        apiStartTime: now(),
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.kind) {
      case "ok": {
        return Response.json({
          success: true,
          watchStates: result.watchStates,
          dispatched: result.dispatched,
          duplicates: result.duplicates,
        });
      }
      case "unauthorized": {
        return jsonError("Unauthorized", 401);
      }
      case "bad_request": {
        return jsonError(result.message, 400);
      }
      case "config_error": {
        return jsonError(result.message, 503);
      }
      case "retryable_error": {
        return jsonError(result.message, 503);
      }
      case "run_error": {
        return jsonError(result.message, 429);
      }
    }
  },
);

export const webhooksGmailRoutes: readonly RouteEntry[] = [
  {
    route: webhookGmailContract.post,
    handler: postGmailWebhook$,
  },
];
