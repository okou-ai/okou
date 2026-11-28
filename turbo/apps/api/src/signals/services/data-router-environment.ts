import { connectorCredentialPlaceholder } from "@okouai/connectors/firewall-metadata/credential-placeholder";
import { env } from "../../lib/env";
import { emptyEnvironment, type Environment } from "./run-environment";

const DATA_ROUTER_FIREWALL_NAME = "data-router";
const DATA_ROUTER_TOKEN_ALIAS = "OKOU_DATA_TOKEN";
const DATA_ROUTER_TOKEN_PLACEHOLDER = connectorCredentialPlaceholder(
  DATA_ROUTER_FIREWALL_NAME,
  DATA_ROUTER_TOKEN_ALIAS,
);

/** The service token resolves at firewall auth; execution carries only its reference. */
export function dataRouterEnvironment(): Environment {
  const url = env("OKOU_DATA_ROUTER_URL");
  const token = env(DATA_ROUTER_TOKEN_ALIAS);
  if (!url || !token) {
    return emptyEnvironment();
  }
  const endpoint = new URL(url);
  return {
    ...emptyEnvironment(),
    platformEnvironment: { OKOU_DATA_ROUTER_URL: endpoint.toString() },
    reservedSecretAliases: [DATA_ROUTER_TOKEN_ALIAS],
    firewalls: [
      {
        kind: "inline",
        firewall: {
          name: DATA_ROUTER_FIREWALL_NAME,
          placeholders: {
            [DATA_ROUTER_TOKEN_ALIAS]: DATA_ROUTER_TOKEN_PLACEHOLDER,
          },
          apis: [
            {
              base: endpoint.toString(),
              auth: {
                headers: {
                  Authorization: `Bearer \${{ secrets.${DATA_ROUTER_TOKEN_ALIAS} }}`,
                },
              },
              permissions: [{ name: "call", rules: ["ANY /{path*}"] }],
            },
          ],
        },
      },
    ],
    networkPolicies: {
      [DATA_ROUTER_FIREWALL_NAME]: {
        allow: ["call"],
        deny: [],
        ask: [],
        unknownPolicy: "deny",
      },
    },
    billableFirewalls: [DATA_ROUTER_FIREWALL_NAME],
  };
}
