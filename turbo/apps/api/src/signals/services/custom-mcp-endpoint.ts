import {
  canonicalizeFirewallBaseUrl,
  validateAuthBaseUrl,
  validateBaseUrlHostPolicy,
} from "@okouai/connectors/firewall-types";

import { safeSync, safeUrlParse } from "../utils";

/** Keep the MCP request URL separate from its host/path firewall scope. */
export function parseCustomMcpEndpoint(raw: string) {
  return safeSync(() => {
    const endpoint = raw.trim();
    if (/[{}]/u.test(endpoint)) {
      throw new Error("MCP endpoint must not contain templates");
    }
    if (endpoint.includes("#")) {
      throw new Error("MCP endpoint must not contain a fragment");
    }
    const url = safeUrlParse(endpoint);
    if (!url || url.protocol !== "https:") {
      throw new Error("MCP endpoint must be a valid HTTPS URL");
    }
    validateAuthBaseUrl(endpoint, "MCP custom connector");

    const queryStart = endpoint.indexOf("?");
    const base = queryStart === -1 ? endpoint : endpoint.slice(0, queryStart);
    const firewallBase = canonicalizeFirewallBaseUrl(
      base,
      "MCP custom connector",
    );
    validateBaseUrlHostPolicy({
      base: firewallBase,
      serviceName: "MCP custom connector",
      hostPolicy: { kind: "publicDestination" },
    });

    // Preserve ordering, repeated keys, empty values and percent encoding.
    const query = queryStart === -1 ? "" : endpoint.slice(queryStart);
    return { endpoint: `${firewallBase}${query}`, firewallBase };
  });
}
