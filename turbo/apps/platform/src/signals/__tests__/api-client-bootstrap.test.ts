import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { expect, test, vi } from "vitest";

import { createAuthedContractClient } from "../api-client-base";
import { testContext } from "./test-helpers";

const context = testContext();

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
  context.mocks.http.get("*/api/feature-switches", () => {
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
