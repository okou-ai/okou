import { randomUUID } from "node:crypto";

import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { browserRoutes } from "../browser";
import { chatThreadComputerUseHostRoutes } from "../chat-threads-computer-use-host";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBrowserFixtures } from "./helpers/browser-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly orgId: string;
  readonly userId: string;
}

async function member(ids: Partial<Member> = {}): Promise<Member> {
  const actor = {
    orgId: ids.orgId ?? `org_${randomUUID()}`,
    userId: ids.userId ?? `user_${randomUUID()}`,
  };
  await createStore().set(
    seedOrgMembership$,
    { ...actor, role: "member" },
    context.signal,
  );
  if (ids.orgId === undefined) {
    await deliverOrganizationCreated(actor);
  }
  return actor;
}

async function deliverOrganizationCreated(actor: Member) {
  const data = {
    id: actor.orgId,
    createdBy: actor.userId,
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
  };
  context.mocks.clerk.verifyWebhook.mockResolvedValue({
    type: "organization.created",
    data,
  });
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body: JSON.stringify({ type: "organization.created", data }),
      extraHeaders: {
        "svix-id": `msg_${randomUUID()}`,
        "svix-timestamp": String(Math.floor(now() / 1000)),
        "svix-signature": "v1,signed-by-clerk",
      },
    }),
    [200],
  );
}

function signIn(actor: Member) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
}

function browser() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function installProvider() {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "browser-context-test-key");
  const provider = createBrowserFixtures(context).profileProvider();
  server.use(...provider.handlers);
  return provider;
}

async function noRunThread(cloudBrowserEnabled: boolean) {
  const created = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: {} }),
    [201],
  );
  // A new chat inherits the member's default cloud Browser authorization.
  if (!cloudBrowserEnabled) {
    await accept(
      setupApp({ context, routes: chatThreadComputerUseHostRoutes })(
        chatThreadComputerUseHostContract,
      ).update({
        headers,
        params: { id: created.body.id },
        body: { computerUseHostId: null, cloudBrowserEnabled: false },
      }),
      [204],
    );
  }
  return created.body.id;
}

describe("chat-owned Browser context", () => {
  it("browser-context-002 a no-Run chat without cloud Browser authorization cannot open a Browser", async () => {
    const provider = installProvider();
    signIn(await member());
    const threadId = await noRunThread(false);

    const response = await accept(
      browser().open({ headers, params: { threadId }, body: {} }),
      [403],
    );

    expect(response.body.error.code).toBe("BROWSER_AUTHORIZATION_REQUIRED");
    expect(provider.createdIds).toStrictEqual([]);
    expect(provider.sessionRequests).toStrictEqual([]);
  });

  async function ownerWithOpenedBrowser() {
    const provider = installProvider();
    const owner = await member();
    signIn(owner);
    const threadId = await noRunThread(true);
    await accept(
      browser().open({ headers, params: { threadId }, body: {} }),
      [200],
    );
    expect(provider.sessionRequests).toHaveLength(1);
    return { provider, owner, threadId };
  }

  async function expectEveryThreadRequestMissing(threadId: string) {
    const params = { threadId };
    const responses = [
      await accept(browser().get({ headers, params }), [404]),
      await accept(browser().open({ headers, params, body: {} }), [404]),
      await accept(
        browser().get({ headers, params, query: { viewer: "native" } }),
        [404],
      ),
      await accept(
        browser().leaseByThread({ headers, params, body: {} }),
        [404],
      ),
      await accept(
        browser().resizeByThread({ headers, params, body: { aspectRatio: 2 } }),
        [404],
      ),
      await accept(browser().close({ headers, params, body: {} }), [404]),
    ];
    for (const response of responses) {
      expect(response.body.error.code).toBe("BROWSER_NOT_FOUND");
    }
  }

  it("browser-context-003 (1/2) another member of the workspace cannot use the owner's no-Run chat Browser", async () => {
    const { provider, owner, threadId } = await ownerWithOpenedBrowser();

    signIn(await member({ orgId: owner.orgId }));
    await expectEveryThreadRequestMissing(threadId);

    expect(provider.sessionRequests).toHaveLength(1);
  });

  it("browser-context-003 (2/2) the owner signed into another workspace cannot use the no-Run chat Browser", async () => {
    const { provider, owner, threadId } = await ownerWithOpenedBrowser();

    signIn(await member({ userId: owner.userId }));
    await expectEveryThreadRequestMissing(threadId);

    expect(provider.sessionRequests).toHaveLength(1);
  });
});
