import type { AssistantMessage } from "@earendil-works/pi-ai";

const SOURCE = "okou_firewall_auth";
const DEADLINE_PHASES = [
  "dns",
  "connect",
  "proxy_connect",
  "tls",
  "request_write",
  "response_headers",
  "response_body",
] as const;

type FirewallAuthFailure = {
  readonly source: typeof SOURCE;
} & (
  | { readonly kind: "api_http_error"; readonly status: number }
  | {
      readonly kind: "deadline_exceeded";
      readonly phase: (typeof DEADLINE_PHASES)[number];
    }
  | {
      readonly kind:
        "transport_error" | "invalid_response" | "unexpected_error";
    }
);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read only the actual local response, never SDK prose or assistant content. */
export function parseFirewallAuthFailure(
  status: number,
  body: string,
): FirewallAuthFailure | undefined {
  if (status !== 502) return undefined;
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = record(JSON.parse(body) as unknown);
  } catch {
    return undefined;
  }
  if (envelope?.error !== "auth_failed") return undefined;
  const evidence = record(envelope.authFailure);
  if (evidence?.source !== SOURCE) return undefined;
  switch (evidence.kind) {
    case "api_http_error": {
      const apiStatus = evidence.status;
      return typeof apiStatus === "number" &&
        Number.isInteger(apiStatus) &&
        apiStatus >= 100 &&
        apiStatus <= 599
        ? { source: SOURCE, kind: evidence.kind, status: apiStatus }
        : undefined;
    }
    case "deadline_exceeded": {
      const phase = DEADLINE_PHASES.find((candidate) => {
        return candidate === evidence.phase;
      });
      return phase ? { source: SOURCE, kind: evidence.kind, phase } : undefined;
    }
    case "transport_error":
    case "invalid_response":
    case "unexpected_error": {
      return { source: SOURCE, kind: evidence.kind };
    }
    default: {
      return undefined;
    }
  }
}

export function applyFirewallAuthFailure(
  message: AssistantMessage,
  failure: FirewallAuthFailure | undefined,
): void {
  if (!failure) return;
  // Keep the native HTTP error prefix used by the SDK's existing retry owner.
  const summary = `502 "auth_failed": local firewall auth ${failure.kind}`;
  message.errorMessage =
    failure.kind === "api_http_error"
      ? `${summary} (API HTTP ${failure.status})`
      : failure.kind === "deadline_exceeded"
        ? `${summary} during ${failure.phase}`
        : summary;
}
