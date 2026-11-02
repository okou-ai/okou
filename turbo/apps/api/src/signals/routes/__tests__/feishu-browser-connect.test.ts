import { randomUUID } from "node:crypto";

import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

describe("Feishu browser connection", () => {
  it("returns a finite invalid-link error for rejected connection and status requests", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context, routes: feishuBrowserConnectRoutes })(
      feishuBrowserConnectContract,
    );
    const token = {
      installationId: randomUUID(),
      openId: "ou_member",
      chatId: "oc_chat",
      ts: Math.floor(now() / 1000),
      sig: "invalid-signature",
    };
    const headers = { authorization: "Bearer clerk-session" };
    const connected = await accept(
      client.connectFromApp({ headers, body: token }),
      [400],
    );
    const status = await accept(
      client.getStatus({ headers, query: token }),
      [400],
    );

    for (const response of [connected, status]) {
      expect(response.body).toStrictEqual({
        error: {
          code: "FEISHU_CONNECT_LINK_INVALID",
          message: "Invalid or expired bot connect link",
        },
      });
    }
  });
});
