import { createBddApi } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { createRouteMocks } from "./helpers/route-test";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { channelsPublishedTo } from "./helpers/realtime-publications";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("run-model-invalidation-001 notifies only the owner about personal account changes without account details", async () => {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json({});
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
  const admin = bdd.user();
  const orgId = admin.orgId ?? "";
  createRouteMocks(context).clerk.session(admin.userId, orgId, admin.orgRole);
  const secret = `sk-ant-oat01-${randomUUID()}`;
  await accept(
    setupApp({ context, routes: meModelProvidersUpsertRoutes })(
      personalModelProvidersMainContract,
    ).upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  expect(channelsPublishedTo(context.mocks, "runModelsChanged")).toStrictEqual([
    `user:${admin.userId}`,
  ]);
  expect(
    context.mocks.ably.publish.mock.calls.filter((call) => {
      return call[0] === "runModelsChanged";
    }),
  ).toStrictEqual([["runModelsChanged", null]]);
  expect(
    context.mocks.ably.channelGet.mock.calls.some((call) => {
      return String(call[0]).includes(orgId);
    }),
  ).toBeFalsy();

  context.mocks.ably.publish.mockRejectedValue(
    new Error("realtime provider unavailable"),
  );
  const disconnect = setupApp({
    context,
    routes: meModelProvidersDeleteRoutes,
  })(personalModelProvidersByTypeContract);
  await accept(
    disconnect.delete({
      headers,
      params: { type: "claude-code-oauth-token" },
    }),
    [204],
  );
  await flushWaitUntilForTest();
  await accept(
    disconnect.delete({
      headers,
      params: { type: "claude-code-oauth-token" },
    }),
    [404],
  );
});
