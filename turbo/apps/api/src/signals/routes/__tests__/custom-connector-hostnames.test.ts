import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

const ENCODED_JOINER_HOST = "xn--mgba3gch31f060k.example";

describe("Custom connector hostname compatibility", () => {
  it("custom-connector-hostnames-001 rejects an encoded joiner host before creating a definition", async () => {
    const member = bdd.user();

    const response = await connectors.requestCreateCustomConnector(
      member,
      manualHttpCustomConnectorCreateBody({
        displayName: "Joiner host",
        prefixTemplates: [`https://${ENCODED_JOINER_HOST}/`],
      }),
      [400],
    );

    if (!("error" in response.body)) {
      throw new Error("Expected an error body");
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("hostname policy");
    await expect(
      connectors.listCustomConnectors(member),
    ).resolves.toStrictEqual([]);
  });

  it("custom-connector-hostnames-003 keeps the usable definition when an encoded joiner update is rejected", async () => {
    const owner = bdd.user();
    const displayName = `Bücher ${randomUUID()}`;
    const original = manualHttpCustomConnectorCreateBody({
      displayName,
      prefixTemplates: ["https://bücher.example/api/"],
    });
    const connector = await connectors.createCustomConnector(owner, original);

    const response = await connectors.requestUpdateCustomConnector(
      owner,
      connector.id,
      { ...original, prefixTemplates: [`https://${ENCODED_JOINER_HOST}/`] },
      [400],
    );

    if (!("error" in response.body)) {
      throw new Error("Expected an error body");
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
    const readback = await connectors.readCustomConnector(owner, connector.id);
    expect(readback.displayName).toBe(displayName);
    expect(readback).toMatchObject({
      prefixTemplates: connector.prefixTemplates,
    });
  });

  it("custom-connector-hostnames-004 rejects an encoded joiner host variable before saving an account", async () => {
    const member = bdd.user();
    const base = manualHttpCustomConnectorCreateBody({
      displayName: "Regional host",
      prefixTemplates: ["https://{{variables.host}}/"],
    });
    const connector = await connectors.createCustomConnector(member, {
      ...base,
      fields: [
        ...base.fields,
        { key: "host", label: "Host", kind: "variable", required: true },
      ],
    });

    const response = await connectors.requestSetCustomConnectorValues(
      member,
      connector.id,
      [{ key: "host", kind: "variable", value: ENCODED_JOINER_HOST }],
      [400],
    );

    if (!("error" in response.body)) {
      throw new Error("Expected an error body");
    }
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toBe(
      "Value for variable host is not a valid custom connector hostname",
    );
    await expect(
      connectors.listCustomConnectorAccounts(member, connector.id),
    ).resolves.toStrictEqual([]);
  });
});
