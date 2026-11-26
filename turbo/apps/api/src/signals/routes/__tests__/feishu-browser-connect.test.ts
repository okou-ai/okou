import { randomBytes, randomUUID } from "node:crypto";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

describe("Feishu browser connection", () => {
  it("feishu-browser-connect-001 rejects a link with an invalid signature for connection and status", async () => {
    const member = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    await memberships.set(
      seedOrgMembership$,
      { ...member, role: "member" },
      context.signal,
    );
    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      "org:member",
    );
    const link = {
      installationId: randomUUID(),
      openId: `ou_${randomUUID().replace(/-/g, "")}`,
      chatId: `oc_${randomUUID().replace(/-/g, "")}`,
      ts: Math.floor(now() / 1000),
      sig: randomBytes(32).toString("hex"),
    };
    const client = setupApp({ context, routes: feishuBrowserConnectRoutes })(
      feishuBrowserConnectContract,
    );
    const invalidLink = {
      error: {
        code: "FEISHU_CONNECT_LINK_INVALID",
        message: "Invalid or expired bot connect link",
      },
    };

    const connect = await accept(
      client.connectFromApp({ headers: SESSION, body: link }),
      [400],
    );
    expect(connect.body).toStrictEqual(invalidLink);

    const status = await accept(
      client.getStatus({ headers: SESSION, query: link }),
      [400],
    );
    expect(status.body).toStrictEqual(invalidLink);
  });
});
