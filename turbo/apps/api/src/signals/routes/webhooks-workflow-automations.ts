import { Buffer } from "node:buffer";

import { webhookWorkflowAutomationContract } from "@okouai/api-contracts/contracts/webhooks";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  dispatchWorkflowWebhook$,
  WORKFLOW_WEBHOOK_BODY_LIMIT_BYTES,
} from "../services/workflow-webhook-automation.service";

type WebhookErrorStatus = 400 | 401 | 404 | 413 | 429 | 500;

function jsonError(message: string, status: WebhookErrorStatus): Response {
  return Response.json({ error: message }, { status });
}

function contentLengthExceedsLimit(contentLength: string | null): boolean {
  if (!contentLength) {
    return false;
  }
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > WORKFLOW_WEBHOOK_BODY_LIMIT_BYTES;
}

const postWorkflowAutomationWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const params = get(pathParamsOf(webhookWorkflowAutomationContract.post));
    const request = get(request$);
    if (contentLengthExceedsLimit(request.raw.headers.get("content-length"))) {
      return jsonError("Payload too large", 413);
    }

    const rawBody = await request.text();
    signal.throwIfAborted();
    if (
      Buffer.byteLength(rawBody, "utf8") > WORKFLOW_WEBHOOK_BODY_LIMIT_BYTES
    ) {
      return jsonError("Payload too large", 413);
    }

    const result = await set(
      dispatchWorkflowWebhook$,
      {
        token: params.token,
        rawBody,
        headers: Object.fromEntries(request.raw.headers.entries()),
        signature: request.raw.headers.get("X-Okou-Signature"),
        timestamp: request.raw.headers.get("X-Okou-Timestamp"),
        apiStartTime: now(),
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.kind) {
      case "ok": {
        return Response.json({
          success: true,
          duplicate: result.duplicate,
          ...(result.duplicate || result.runId === null
            ? {}
            : { runId: result.runId }),
        });
      }
      case "not_found": {
        return jsonError("Not found", 404);
      }
      case "unauthorized": {
        return jsonError("Unauthorized", 401);
      }
      case "bad_request": {
        return jsonError(result.message, 400);
      }
      case "payload_too_large": {
        return jsonError("Payload too large", 413);
      }
      case "rate_limited": {
        return jsonError("Rate limited", 429);
      }
      case "run_error": {
        return jsonError(result.message, 500);
      }
    }
  },
);

export const webhooksWorkflowAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: webhookWorkflowAutomationContract.post,
    handler: postWorkflowAutomationWebhook$,
  },
];
