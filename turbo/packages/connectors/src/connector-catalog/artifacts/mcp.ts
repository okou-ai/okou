import { z } from "zod";

import {
  canonicalizeFirewallBaseUrl,
  validateBaseUrlHostPolicy,
} from "../../firewall-types";
import { attempt } from "../safe";

export const connectorMcpSchema = z
  .object({
    transport: z.literal("streamable-http"),
    endpoint: z
      .string()
      .min(1)
      .max(2048)
      .superRefine((endpoint, context) => {
        const result = attempt(() => {
          if (/[{}]/u.test(endpoint)) {
            throw new Error("MCP endpoint must not contain templates");
          }
          const canonical = canonicalizeFirewallBaseUrl(
            endpoint,
            "builtin MCP",
          );
          if (
            canonical !== endpoint ||
            new URL(canonical).protocol !== "https:"
          ) {
            throw new Error("MCP endpoint must be a canonical HTTPS URL");
          }
          validateBaseUrlHostPolicy({
            base: canonical,
            serviceName: "builtin MCP",
            hostPolicy: { kind: "publicDestination" },
          });
        });
        if ("error" in result) {
          context.addIssue({
            code: "custom",
            message: "MCP endpoint must be a fixed canonical public HTTPS URL",
          });
        }
      }),
  })
  .strict();
