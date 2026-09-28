import { z } from "zod";

import { safeUrlParse, settle } from "../utils";
import { mcpOAuthSafeFetch } from "./mcp-oauth-safe-fetch.service";

const MCP_CLIENT_NAME_LOOKUP_MS = 2_500;
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
  const url = metadataDocumentUrl(clientId);
  if (url === undefined) {
    return undefined;
  }
  const result = await settle(
    (async () => {
      const response = await mcpOAuthSafeFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(MCP_CLIENT_NAME_LOOKUP_MS),
        ]),
      });
      if (!response.ok) {
        return undefined;
      }
      const metadata: unknown = await response.json();
      const parsed = clientMetadataSchema.safeParse(metadata);
      if (!parsed.success || parsed.data.client_id !== clientId) {
        return undefined;
      }
      const name = parsed.data.client_name.replace(/\s+/gu, " ").trim();
      return name.length > 0 && name.length <= 120 && !/[\p{C}]/u.test(name)
        ? name
        : undefined;
    })(),
    signal,
  );
  // A cancelled MCP operation must not continue to enqueue an input. Only the
  // independent metadata lookup deadline/network failure is a display fallback.
  signal.throwIfAborted();
  return result.ok ? result.value : undefined;
}
