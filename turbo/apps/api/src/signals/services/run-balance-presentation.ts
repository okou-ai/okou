import {
  formatRunBalanceError,
  isLegacyProviderBalanceError,
  isProviderBalanceErrorBody,
  MODEL_UNAVAILABLE_MESSAGE,
} from "@okouai/api-contracts/contracts/run-balance-errors";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { safeJsonParse } from "../utils";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only marked provider errors are eligible; ordinary assistant text stays verbatim. */
export function publicAssistantBalanceError(
  event: Readonly<Record<string, unknown>>,
  modelProvider: string | null | undefined,
  eventType: unknown = event.type,
): string | undefined {
  if (eventType !== "assistant" || event.is_api_error_message !== true) {
    return undefined;
  }
  const content = record(event.message)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const item = record(block);
    if (item?.type === "text" && typeof item.text === "string") {
      const error = formatRunBalanceError({
        message: item.text,
        modelProvider,
        framework: "claude-code",
      });
      if (error !== undefined) {
        return error;
      }
    }
  }
  return undefined;
}

/** Public projection only: retain the source event in internal diagnostics. */
export function publicBuiltInBalanceEvent(
  event: Readonly<Record<string, unknown>>,
  modelProvider: string | null | undefined,
  eventType: unknown = event.type,
): Readonly<Record<string, unknown>> {
  if (modelProvider !== "built-in") {
    return event;
  }
  const visible = publicBalanceEventBody(event, eventType);
  const nested = record(visible.eventData);
  return nested !== null && eventType === "result"
    ? { ...visible, eventData: publicBalanceEventBody(nested, "result") }
    : visible;
}

function publicBalanceEventBody(
  event: Readonly<Record<string, unknown>>,
  eventType: unknown,
): Readonly<Record<string, unknown>> {
  if (
    eventType === "result" &&
    (event.is_error === true || event.subtype === "error") &&
    typeof event.result === "string" &&
    isLegacyProviderBalanceError(event.result, "claude-code")
  ) {
    return {
      ...event,
      result: MODEL_UNAVAILABLE_MESSAGE,
      ...(Array.isArray(event.errors)
        ? { errors: [MODEL_UNAVAILABLE_MESSAGE] }
        : {}),
    };
  }
  const assistantError = publicAssistantBalanceError(
    event,
    "built-in",
    eventType,
  );
  if (assistantError !== undefined) {
    return {
      ...event,
      error: "model_unavailable",
      message: {
        ...record(event.message),
        content: [{ type: "text", text: assistantError }],
      },
    };
  }
  return publicProviderErrorEvent(event, eventType);
}

function publicProviderErrorEvent(
  event: Readonly<Record<string, unknown>>,
  eventType: unknown,
): Readonly<Record<string, unknown>> {
  if (
    (eventType === "error" ||
      eventType === "turn.failed" ||
      eventType === "response.failed") &&
    (isProviderBalanceErrorBody(event) ||
      (typeof record(event.error)?.message === "string" &&
        isLegacyProviderBalanceError(
          String(record(event.error)?.message),
          null,
        )))
  ) {
    const response = record(event.response);
    return {
      ...event,
      error: { type: "model_unavailable", message: MODEL_UNAVAILABLE_MESSAGE },
      ...(event.message === undefined
        ? {}
        : { message: MODEL_UNAVAILABLE_MESSAGE }),
      ...(event.code === undefined ? {} : { code: "model_unavailable" }),
      ...(response === null
        ? {}
        : {
            response: {
              ...response,
              error: {
                type: "model_unavailable",
                message: MODEL_UNAVAILABLE_MESSAGE,
              },
              ...(response.error_type === undefined
                ? {}
                : { error_type: "model_unavailable" }),
            },
          }),
    };
  }
  return event;
}

function containsProviderBalanceResponse(body: string): boolean {
  const parseBody = (value: string): boolean => {
    return isProviderBalanceErrorBody(safeJsonParse(value));
  };
  if (parseBody(body)) {
    return true;
  }
  // Captured SSE frames retain provider error structure; successful text is not searched.
  return body.split(/\r?\n\r?\n/).some((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => {
        return line.startsWith("data:");
      })
      .map((line) => {
        return line.slice(5).trimStart();
      })
      .join("\n");
    return data !== "" && parseBody(data);
  });
}

/** Only upstream responses on authenticated billable model flows belong to the platform key. */
export function publicBuiltInBalanceNetworkLog(
  entry: NetworkLogEntry,
  modelProvider: string | null | undefined,
): NetworkLogEntry {
  if (
    modelProvider !== "built-in" ||
    entry.firewall_billable !== true ||
    !entry.firewall_name?.startsWith("model-provider:") ||
    entry.action !== "ALLOW"
  ) {
    return entry;
  }
  const body =
    entry.response_body_encoding === "base64" &&
    entry.response_body !== undefined
      ? Buffer.from(entry.response_body, "base64").toString("utf8")
      : entry.response_body;
  if (
    entry.status !== 402 &&
    (body === undefined || !containsProviderBalanceResponse(body))
  ) {
    return entry;
  }
  return {
    ...entry,
    // Keep the upstream payment status in internal telemetry with its response body.
    status: undefined,
    ...(entry.error === undefined ? {} : { error: MODEL_UNAVAILABLE_MESSAGE }),
    ...(entry.response_body === undefined
      ? {}
      : {
          response_body: MODEL_UNAVAILABLE_MESSAGE,
          response_body_encoding: undefined,
          response_body_truncated: false,
        }),
  };
}
