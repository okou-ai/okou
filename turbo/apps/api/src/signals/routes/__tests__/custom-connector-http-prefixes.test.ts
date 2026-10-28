import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

function definition(
  prefix: string,
  authentication: "none" | "header" | "query" = "none",
): CreateCustomConnectorBody {
  return {
    kind: "http",
    displayName: "HTTP API prefix lifecycle",
    prefixTemplates: [prefix],
    authMode: authentication === "none" ? "none" : "manual",
    fields: [
      { key: "host", label: "Host", kind: "variable", required: true },
      ...(authentication === "none"
        ? []
        : [
            {
              key: "api_key",
              label: "API key",
              kind: "secret" as const,
              required: true,
            },
          ]),
    ],
    headerInjections:
      authentication === "header"
        ? [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ]
        : [],
    queryInjections:
      authentication === "query"
        ? [{ name: "api_key", valueTemplate: "{{secrets.api_key}}" }]
        : [],
  };
}

describe("Custom HTTP API prefix schemes", () => {
  it.each([
    ["http", "none"],
    ["http", "header"],
    ["http", "query"],
    ["https", "none"],
    ["https", "header"],
    ["https", "query"],
  ] as const)(
    "creates, connects and edits a %s API using %s authentication",
    async (scheme, authentication) => {
      const actor = bdd.user();
      const prefix = `${scheme}://{{variables.host}}:8080/v1/`;
      const input = definition(` ${prefix.slice(0, -1)} `, authentication);
      const created = await connectors.createCustomConnector(actor, input);
      onTestFinished(async () => {
        await connectors.deleteCustomConnector(actor, created.id);
      });
      expect(created).toMatchObject({
        kind: "http",
        prefixTemplates: [prefix],
        authMode: input.authMode,
        headerInjections: input.headerInjections,
        queryInjections: input.queryInjections,
      });
      await expect(
        connectors.readCustomConnector(actor, created.id),
      ).resolves.toStrictEqual(created);

      const connected = await connectors.setCustomConnectorValues(
        actor,
        created.id,
        [
          { key: "host", kind: "variable", value: "api.example.test" },
          ...(authentication === "none"
            ? []
            : [
                {
                  key: "api_key",
                  kind: "secret" as const,
                  value: "http-api-credential",
                },
              ]),
        ],
      );
      expect(connected).toMatchObject({
        id: created.id,
        prefixTemplates: [prefix],
        connectionId: expect.any(String),
      });
      await expect(
        connectors.listCustomConnectorAccounts(actor, created.id),
      ).resolves.toMatchObject([
        { id: connected.connectionId, isDefault: true },
      ]);

      const updatedPrefix = `${scheme === "https" ? "http" : "https"}://{{variables.host}}:8080/v2/`;
      const updated = await connectors.updateCustomConnector(
        actor,
        created.id,
        {
          ...definition(updatedPrefix, authentication),
          displayName: "Updated HTTP API prefix",
        },
      );
      expect(updated).toMatchObject({
        id: created.id,
        prefixTemplates: [updatedPrefix],
        storageVersion: created.storageVersion,
      });
      await expect(
        connectors.readCustomConnector(actor, created.id),
      ).resolves.toStrictEqual(updated);
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.toStrictEqual([updated]);
      expect(JSON.stringify([connected, updated])).not.toContain(
        "http-api-credential",
      );
    },
  );

  it.each(["http", "https", "HTTP", "HTTPS"])(
    "rejects %s path variables on creation and editing without changing the saved definition",
    async (scheme) => {
      const actor = bdd.user();
      const invalid = definition(
        `${scheme}://api.example.test/{{variables.host}}/`,
      );
      const rejected = await connectors.requestCreateCustomConnector(
        actor,
        invalid,
        [400],
      );
      expect(rejected.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "Prefix template variables may only appear in the URL host",
        },
      });
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.toStrictEqual([]);

      const created = await connectors.createCustomConnector(
        actor,
        definition(`${scheme}://{{variables.host}}/v1/`),
      );
      onTestFinished(async () => {
        await connectors.deleteCustomConnector(actor, created.id);
      });
      const rejectedUpdate = await connectors.requestUpdateCustomConnector(
        actor,
        created.id,
        invalid,
        [400],
      );
      expect(rejectedUpdate.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "Prefix template variables may only appear in the URL host",
        },
      });
      await expect(
        connectors.readCustomConnector(actor, created.id),
      ).resolves.toStrictEqual(created);
    },
  );
});
