import { accept, HttpStatusError } from "@okouai/connectors/accept";
import * as z from "zod";

import { monotonicNow } from "../../lib/time";
import {
  recordMcpClientNameLookup,
  type McpClientNameLookupOutcome,
} from "../external/sandbox-op-log";
import { safeUrlParse, settle, settleIncludingAbort } from "../utils";
import {
  McpOAuthUnsafeUrlError,
  mcpOAuthSafeFetch,
} from "./mcp-oauth-safe-fetch.service";

const clientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
});

function metadataDocumentUrl(clientId: string): URL | undefined {
  const url = safeUrlParse(clientId);
  // Clerk's CIMD clients use an HTTPS URL with a nonempty path. Other signed
  // client IDs can still send, but they have no supported display-name source.
  return url?.protocol === "https:" && url.pathname !== "/" ? url : undefined;
}

/** An optional self-asserted label, never an authority for the OAuth client. */
export async function mcpClientDisplayName(
  clientId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const startedAt = monotonicNow();
  let outcome: McpClientNameLookupOutcome = "lookup_failed";
  let fetchInvoked = false;

  const operation = await settleIncludingAbort(async () => {
    const url = metadataDocumentUrl(clientId);
    if (url === undefined) {
      outcome = "ineligible";
      return undefined;
    }
    const result = await settle(
      (async () => {
        fetchInvoked = true;
        const response = await accept(
          mcpOAuthSafeFetch(url, {
            headers: { accept: "application/json" },
            signal,
          }),
          [200],
        );
        const metadata: unknown = await response.json();
        const parsed = clientMetadataSchema.safeParse(metadata);
        if (!parsed.success || parsed.data.client_id !== clientId) {
          outcome = "invalid_metadata";
          return undefined;
        }
        const name = parsed.data.client_name.replace(/\s+/gu, " ").trim();
        if (name.length === 0 || name.length > 120 || /[\p{C}]/u.test(name)) {
          outcome = "invalid_metadata";
          return undefined;
        }
        outcome = "validated";
        return name;
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      outcome =
        result.error instanceof HttpStatusError
          ? "http_unavailable"
          : result.error instanceof McpOAuthUnsafeUrlError
            ? "unsafe_url"
            : result.error instanceof SyntaxError
              ? "invalid_metadata"
              : "lookup_failed";
      return undefined;
    }
    return result.value;
  });
  // Record terminal outcomes before propagating the original cancellation or
  // exception. The timing interface only enqueues detached delivery, and its
  // own failures (including AbortError) cannot replace the lookup result.
  await recordMcpClientNameLookup({
    outcome: signal.aborted ? "caller_cancelled" : outcome,
    fetchInvoked,
    startedAt,
  });
  if (!operation.ok) {
    throw operation.error;
  }
  return operation.value;
}
