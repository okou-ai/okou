import {
  BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
  runnersBuiltinFirewallsResolveContract,
  type RunnerBuiltinFirewallsResolveResponse,
} from "@okouai/api-contracts/contracts/runners";
import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "@okouai/connectors/firewall-metadata/runner-runtime-catalog";
import { describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { API_TEST_CONNECTOR_FIREWALL_CONFIGS } from "../../../test-fixtures/connector-catalog";
import { runnersRoutes } from "../runners";

const context = testContext({ connectorCatalog: true });
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const OPENAI_API_KEY_AUTH_HEADER = [
  "Bearer $",
  "{{ secrets.OPENAI_API_KEY }}",
].join("");
const CHATGPT_ACCESS_TOKEN_AUTH_HEADER = [
  "Bearer $",
  "{{ secrets.CHATGPT_ACCESS_TOKEN }}",
].join("");
const CHATGPT_ACCOUNT_ID_AUTH_HEADER = [
  "$",
  "{{ secrets.CHATGPT_ACCOUNT_ID }}",
].join("");
const EXPECTED_RUNNER_FIREWALL_CATALOG = createRunnerRuntimeFirewallCatalog([
  ...API_TEST_CONNECTOR_FIREWALL_CONFIGS.map((firewall) => {
    return projectRunnerRuntimeFirewall(firewall);
  }),
  ...Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS).map((firewall) => {
    return projectRunnerRuntimeFirewall(firewall);
  }),
]);

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function client() {
  return setupAppWithRoutes({ context, routes: runnersRoutes })(
    runnersBuiltinFirewallsResolveContract,
  );
}

function rawApp() {
  return createAppWithRoutes({ signal: context.signal, routes: runnersRoutes });
}

describe("runner builtin firewall resolver", () => {
  it("requires runner authentication", async () => {
    const response = await accept(
      client().resolve({
        headers: {},
        body: { names: ["github"] },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects unknown builtin firewall names", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: { names: ["github", "not-a-builtin-firewall"] },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Unknown builtin firewall: not-a-builtin-firewall",
    );
  });

  it("rejects misspelled full-catalog request fields", async () => {
    const response = await rawApp().request(
      "/api/runners/builtin-firewalls/resolve",
      {
        method: "POST",
        headers: {
          authorization: OFFICIAL_RUNNER_AUTHORIZATION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: ["github"] }),
      },
    );

    expect(response.status).toBe(400);
  });

  it.each([
    { body: "not-json", label: "invalid JSON" },
    { body: "null", label: "null JSON" },
    { body: "[]", label: "array JSON" },
  ])("rejects $label full-catalog request bodies", async ({ body }) => {
    const response = await rawApp().request(
      "/api/runners/builtin-firewalls/resolve",
      {
        method: "POST",
        headers: {
          authorization: OFFICIAL_RUNNER_AUTHORIZATION,
          "content-type": "application/json",
        },
        body,
      },
    );

    expect(response.status).toBe(400);
  });

  it("resolves connector and model-provider builtin firewalls", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {
          names: ["github", "github", "model-provider:openai-api-key"],
        },
      }),
      [200],
    );
    const body: RunnerBuiltinFirewallsResolveResponse = response.body;

    expect(body.catalogDigest).toBe(
      EXPECTED_RUNNER_FIREWALL_CATALOG.catalogDigest,
    );
    expect(body.catalogVersion).toBe(
      EXPECTED_RUNNER_FIREWALL_CATALOG.catalogVersion,
    );
    expect(Object.keys(body.firewalls).sort()).toStrictEqual([
      "github",
      "model-provider:openai-api-key",
    ]);
    expect(body.firewalls.github?.name).toBe("github");
    expect(
      body.firewalls["model-provider:openai-api-key"]?.apis[0],
    ).toStrictEqual({
      base: "https://api.openai.com/v1/responses",
      auth: {
        headers: {
          Authorization: OPENAI_API_KEY_AUTH_HEADER,
        },
      },
      permissions: [],
    });
  });

  it("publishes the Codex workspace discovery firewall to Runner", async () => {
    const name = "model-provider:codex-oauth-token";
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: { names: [name] },
      }),
      [200],
    );

    expect(response.body.firewalls[name]?.apis[1]).toStrictEqual({
      base: "https://chatgpt.com/backend-api/wham/accounts/check",
      auth: {
        headers: {
          Authorization: CHATGPT_ACCESS_TOKEN_AUTH_HEADER,
          "ChatGPT-Account-ID": CHATGPT_ACCOUNT_ID_AUTH_HEADER,
        },
      },
      permissions: [
        {
          name: "codex:workspace-routing",
          rules: ["GET /"],
        },
      ],
    });
  });

  it("handles concurrent full generated builtin firewall catalog resolves", async () => {
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => {
        return accept(
          client().resolve({
            headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
            body: {},
          }),
          [200],
        );
      }),
    );

    for (const response of responses) {
      const body: RunnerBuiltinFirewallsResolveResponse = response.body;
      expect(body.catalogDigest).toBe(
        EXPECTED_RUNNER_FIREWALL_CATALOG.catalogDigest,
      );
      expect(body.catalogVersion).toBe(
        EXPECTED_RUNNER_FIREWALL_CATALOG.catalogVersion,
      );
      expect(Object.keys(body.firewalls).sort(compareStrings)).toStrictEqual([
        ...EXPECTED_RUNNER_FIREWALL_CATALOG.names,
      ]);
    }
  });

  it("keeps the complete serialized builtin firewall catalog within the Runner byte budget", async () => {
    const response = await rawApp().request(
      "/api/runners/builtin-firewalls/resolve",
      {
        method: "POST",
        headers: {
          authorization: OFFICIAL_RUNNER_AUTHORIZATION,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);
    const bodyBytes = Buffer.from(await response.arrayBuffer());
    const body =
      runnersBuiltinFirewallsResolveContract.resolve.responses[200].parse(
        JSON.parse(bodyBytes.toString("utf8")),
      );
    expect(body.firewalls.github?.name).toBe("github");
    expect(body.firewalls["model-provider:openai-api-key"]?.name).toBe(
      "model-provider:openai-api-key",
    );
    expect(bodyBytes.byteLength).toBeLessThanOrEqual(
      BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
    );
  });

  it("resolves the full generated builtin firewall catalog when names are omitted", async () => {
    const response = await accept(
      client().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {},
      }),
      [200],
    );
    const body: RunnerBuiltinFirewallsResolveResponse = response.body;

    expect(body.catalogDigest).toBe(
      EXPECTED_RUNNER_FIREWALL_CATALOG.catalogDigest,
    );
    expect(body.catalogVersion).toBe(
      EXPECTED_RUNNER_FIREWALL_CATALOG.catalogVersion,
    );
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.responses[200].safeParse(
        body,
      ).success,
    ).toBeTruthy();
    expect(Object.keys(body.firewalls).sort(compareStrings)).toStrictEqual([
      ...EXPECTED_RUNNER_FIREWALL_CATALOG.names,
    ]);
    expect(body.firewalls.github?.name).toBe("github");
    expect(
      body.firewalls["model-provider:openai-api-key"]?.apis[0],
    ).toStrictEqual({
      base: "https://api.openai.com/v1/responses",
      auth: {
        headers: {
          Authorization: OPENAI_API_KEY_AUTH_HEADER,
        },
      },
      permissions: [],
    });
  });
});
