import { command } from "ccstate";
import { webhookOpenaiImagesContract } from "@okouai/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { ingestOpenaiImageWebhook$ } from "../services/openai-image-webhook.service";

const postOpenaiImagesWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();

    const result = await set(ingestOpenaiImageWebhook$, {
      rawBody,
      headers: request.raw.headers,
    });
    signal.throwIfAborted();
    switch (result) {
      case "ok": {
        return new Response("OK");
      }
      case "unauthorized": {
        return Response.json(
          { error: "Invalid webhook signature" },
          { status: 401 },
        );
      }
      case "bad_request": {
        return Response.json(
          { error: "Invalid webhook event" },
          { status: 400 },
        );
      }
      case "not_configured": {
        return Response.json(
          { error: "Webhook is not configured" },
          { status: 503 },
        );
      }
    }
  },
);

export const webhooksOpenaiImagesRoutes: readonly RouteEntry[] = [
  {
    route: webhookOpenaiImagesContract.post,
    handler: postOpenaiImagesWebhook$,
  },
];
