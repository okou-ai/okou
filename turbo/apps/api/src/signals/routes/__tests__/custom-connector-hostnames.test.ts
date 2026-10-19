import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const joinerHosts = Object.freeze([
  "xn--mgba3gch31f060k.example",
  "xn--11b2ezcw70k.example",
]);

describe("Custom connector hostname compatibility", () => {
  it.each(joinerHosts)(
    "rejects encoded joiner host %s before creating a definition",
    async (host) => {
      const actor = bdd.user();
      const response = await connectors.requestCreateCustomConnector(
        actor,
        manualHttpCustomConnectorCreateBody({
          displayName: "Unsupported joiner",
          prefixTemplates: [`https://${host}/api/`],
        }),
        [400],
      );

      expect(response.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: expect.stringContaining("hostname policy"),
        },
      });
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.toStrictEqual([]);
    },
  );

  it("preserves a usable definition when an encoded joiner update is rejected", async () => {
    const actor = bdd.user();
    const body = manualHttpCustomConnectorCreateBody({
      displayName: "Persian API",
      prefixTemplates: ["https://xn--mgba3gch31f.example/api/"],
    });
    const connector = await connectors.createCustomConnector(actor, body);
    onTestFinished(async () => {
      await connectors.deleteCustomConnector(actor, connector.id);
    });

    const response = await connectors.requestUpdateCustomConnector(
      actor,
      connector.id,
      {
        ...body,
        prefixTemplates: ["https://xn--mgba3gch31f060k.example/api/"],
      },
      [400],
    );

    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    await expect(
      connectors.readCustomConnector(actor, connector.id),
    ).resolves.toMatchObject({
      displayName: body.displayName,
      prefixTemplates: body.prefixTemplates,
    });
  });

  it.each(joinerHosts)(
    "rejects encoded joiner host variable %s before saving an account",
    async (host) => {
      const actor = bdd.user();
      const connector = await connectors.createCustomConnector(actor, {
        slug: `_hostname-${randomUUID()}`,
        displayName: "Variable hostname",
        authMode: "manual",
        prefixTemplates: ["https://{{variables.host}}/api/"],
        fields: [
          { key: "host", label: "Host", kind: "variable", required: true },
        ],
        headerInjections: [
          { name: "X-Workspace", valueTemplate: "{{variables.host}}" },
        ],
        queryInjections: [],
      });
      onTestFinished(async () => {
        await connectors.deleteCustomConnector(actor, connector.id);
      });

      const response = await connectors.requestSetCustomConnectorValues(
        actor,
        connector.id,
        [{ key: "host", kind: "variable", value: host }],
        [400],
      );

      expect(response.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message:
            "Value for variable host is not a valid custom connector hostname",
        },
      });
      await expect(
        connectors.listCustomConnectorAccounts(actor, connector.id),
      ).resolves.toStrictEqual([]);
    },
  );
});
