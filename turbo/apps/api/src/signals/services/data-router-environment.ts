import { env } from "../../lib/env";
import { emptyEnvironment, type Environment } from "./run-environment";

/** The service token exists only in encrypted runtime secrets, never the sandbox env. */
export function dataRouterEnvironment(): Environment {
  const url = env("OKOU_DATA_ROUTER_URL");
  const token = env("OKOU_DATA_TOKEN");
  if (!url || !token) {
    return emptyEnvironment();
  }
  const endpoint = new URL(url);
  return {
    ...emptyEnvironment(),
    platformEnvironment: { OKOU_DATA_ROUTER_URL: endpoint.toString() },
    secrets: { OKOU_DATA_TOKEN: token },
    firewalls: [
      {
        kind: "inline",
        firewall: {
          name: "data-router",
          apis: [
            {
              base: endpoint.toString(),
              auth: {
                headers: {
                  Authorization: `Bearer \${{ secrets.OKOU_DATA_TOKEN }}`,
                },
              },
              permissions: [{ name: "call", rules: ["ANY /{path*}"] }],
            },
          ],
        },
      },
    ],
    networkPolicies: {
      "data-router": {
        allow: ["call"],
        deny: [],
        ask: [],
        unknownPolicy: "deny",
      },
    },
    billableFirewalls: ["data-router"],
  };
}
