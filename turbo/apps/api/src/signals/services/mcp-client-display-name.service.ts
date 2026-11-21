import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { object, string } from "zod";

import { singleton } from "../../lib/singleton";
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

const clientMetadataSchema = object({
  client_id: string(),
  client_name: string(),
});

const DISPLAY_NAME_TTL_MS = 5 * 60 * 1000;
const DISPLAY_NAME_CACHE_LIMIT = 512;

// Retain only completed public labels. Misses stay owned by each request,
// including on Workers where in-flight I/O cannot be shared across requests.
const cachedDisplayNames = singleton(() => {
  return new Map<
    string,
    { readonly name: string; readonly expiresAt: number }
  >();
});

function cacheDisplayName(clientId: string, name: string): void {
  const cache = cachedDisplayNames();
  // Concurrent misses can resolve the same ID. Reinsert it as the newest
  // entry without evicting another ID if it already occupied a slot.
  cache.delete(clientId);
  if (cache.size >= DISPLAY_NAME_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(clientId, {
    name,
    expiresAt: monotonicNow() + DISPLAY_NAME_TTL_MS,
  });
}

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
): Promise<{
  readonly name: string | undefined;
  readonly fetchInvoked: boolean;
}> {
  const startedAt = monotonicNow();
  let outcome: McpClientNameLookupOutcome = "lookup_failed";
  let fetchInvoked = false;

  const operation = await settleIncludingAbort(async () => {
    signal.throwIfAborted();
    const cache = cachedDisplayNames();
    const cached = cache.get(clientId);
    if (cached !== undefined) {
      if (startedAt < cached.expiresAt) {
        outcome = "cache_hit";
        return cached.name;
      }
      cache.delete(clientId);
    }
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
    if (result.value !== undefined) {
      cacheDisplayName(clientId, result.value);
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
  signal.throwIfAborted();
  return { name: operation.value, fetchInvoked };
}
