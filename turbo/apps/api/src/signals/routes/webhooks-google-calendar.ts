import { command } from "ccstate";
import { webhookGoogleCalendarContract } from "@okouai/api-contracts/contracts/webhooks";

import type { RouteEntry } from "../route-entry";
import { request$ } from "../context/hono";
import { now } from "../../lib/time";
import { dispatchGoogleCalendarWebhook$ } from "../services/google-calendar-automation-event.service";

function jsonError(message: string, status: 400 | 401 | 429 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postGoogleCalendarWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    await request.text();
    signal.throwIfAborted();

    const result = await set(
      dispatchGoogleCalendarWebhook$,
      {
        headers: request.raw.headers,
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
      case "run_error": {
        return jsonError(result.message, 429);
      }
    }
  },
);

export const webhooksGoogleCalendarRoutes: readonly RouteEntry[] = [
  {
    route: webhookGoogleCalendarContract.post,
    handler: postGoogleCalendarWebhook$,
  },
];
