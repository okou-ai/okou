import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  CONNECTOR_CONTRACT_HEADER,
  CONNECTOR_CONTRACT_BUILTIN_MCP_V1,
} from "@okouai/api-contracts/contracts/client-headers";
import { expect, test, vi } from "vitest";

import { createAuthedContractClient } from "../api-client-base";
import { testContext } from "./test-helpers";

const context = testContext();

test("negotiates builtin MCP within the older API's cross-origin header allowlist", async () => {
  // #34913: keep the serving/rollback API allowlist until those APIs drain.
  const legacyAllowedHeaders = new Set([
    "accept",
    "accept-language",
    "accept-version",
    "authorization",
    "content-length",
    "content-md5",
    "content-language",
    "content-type",
    "date",
    "range",
    "x-api-version",
    "x-csrf-token",
    "x-requested-with",
    "x-client-version",
    "x-client-type",
    "x-client-product",
    "x-client-session-id",
    "x-client-request-id",
    "x-chat-event-schema-version",
    "x-vercel-protection-bypass",
  ]);
  context.mocks.http.get(
    "https://api.okou.ai/api/feature-switches",
    ({ request }) => {
      expect(request.headers.get("Accept-Version")).toBe("builtin-mcp-v1");
      expect(
        [...request.headers.keys()].filter((name) => {
          return !legacyAllowedHeaders.has(name.toLowerCase());
        }),
      ).toStrictEqual([]);
      return Response.json({ switches: {}, effectiveSwitches: {} });
    },
  );
  const client = createAuthedContractClient(featureSwitchesContract, {
    baseUrl: "https://api.okou.ai",
    clientVersion: "compatibility-test",
    getToken: () => {
      return Promise.resolve("clerk-session");
    },
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  await expect(client.get({ headers: {} })).resolves.toMatchObject({
    status: 200,
  });
});

test("uses a matching bootstrap response once before falling back to the network", async () => {
  const bootstrapBody = {
    switches: { bootstrap: true },
    effectiveSwitches: { bootstrap: true },
  };
  const networkBody = {
    switches: { network: true },
    effectiveSwitches: { network: true },
  };
  const script = document.createElement("script");
  script.type = "application/json";
  script.dataset.okouApiBootstrap = "";
  script.dataset.method = "GET";
  script.dataset.path = encodeURIComponent(featureSwitchesContract.get.path);
  script.dataset.contentType = "application/json";
  script.textContent = JSON.stringify(bootstrapBody);
  document.body.append(script);

  let networkRequestCount = 0;
  context.mocks.http.get("*/api/feature-switches", ({ request }) => {
    expect(request.headers.get(CONNECTOR_CONTRACT_HEADER)).toBe(
      CONNECTOR_CONTRACT_BUILTIN_MCP_V1,
    );
    networkRequestCount += 1;
    return Response.json(networkBody);
  });
  const getToken = vi.fn<(signal?: AbortSignal) => Promise<string>>(() => {
    return Promise.resolve("network-token");
  });
  const client = createAuthedContractClient(featureSwitchesContract, {
    baseUrl: "https://api.okou.ai",
    clientVersion: "bootstrap-test",
    getToken,
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  const first = await client.get({ headers: {} });
  expect(first).toMatchObject({ status: 200, body: bootstrapBody });
  expect(script.isConnected).toBeFalsy();
  expect(getToken).not.toHaveBeenCalled();
  expect(networkRequestCount).toBe(0);

  const second = await client.get({ headers: {} });
  expect(second).toMatchObject({ status: 200, body: networkBody });
  expect(getToken).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(networkRequestCount).toBe(1);

  const third = await client.get({
    headers: {},
    fetchOptions: { signal: context.signal },
  });
  expect(third).toMatchObject({ status: 200, body: networkBody });
  expect(getToken).toHaveBeenNthCalledWith(2, context.signal);
  expect(networkRequestCount).toBe(2);
});
