import { randomUUID } from "node:crypto";
import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { paidToolsRoutes } from "../paid-tools";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };
const paidTools = setupApp({ context, routes: paidToolsRoutes })(
  paidToolsContract,
);

interface Identity {
  readonly userId: string;
  readonly orgId: string;
}

function member(orgId = `org_${randomUUID()}`): Identity {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(identity: Identity) {
  createRouteMocks(context).clerk.session(
    identity.userId,
    identity.orgId,
    "org:member",
  );
}

async function list(identity: Identity) {
  signIn(identity);
  return (await accept(paidTools.get({ headers }), [200])).body.disabledTools;
}

async function setDisabled(
  identity: Identity,
  toolId: PaidToolId,
  disabled: boolean,
) {
  signIn(identity);
  return (
    await accept(
      paidTools.update({ headers, params: { toolId }, body: { disabled } }),
      [200],
    )
  ).body;
}

describe("paid tool preferences", () => {
  it("paid-tools-001 lets an ordinary member disable and re-enable a tool idempotently", async () => {
    const identity = member();

    const initial = await list(identity);
    const updates = [
      await setDisabled(identity, "web-search", false),
      await setDisabled(identity, "web-search", true),
      await setDisabled(identity, "web-search", true),
    ];
    await setDisabled(identity, "social", true);
    const afterSocial = await list(identity);
    const reEnables = [
      await setDisabled(identity, "web-search", false),
      await setDisabled(identity, "web-search", false),
    ];
    const final = await list(identity);

    expect(initial).toStrictEqual([]);
    expect(updates).toStrictEqual([
      { toolId: "web-search", disabled: false },
      { toolId: "web-search", disabled: true },
      { toolId: "web-search", disabled: true },
    ]);
    expect(afterSocial).toStrictEqual(["social", "web-search"]);
    expect(reEnables).toStrictEqual([
      { toolId: "web-search", disabled: false },
      { toolId: "web-search", disabled: false },
    ]);
    expect(final).toStrictEqual(["social"]);
  });

  it("paid-tools-002 saves and re-enables the data-search preference", async () => {
    const identity = member();
    await setDisabled(identity, "web-search", true);

    const disabled = await setDisabled(identity, "data-search", true);
    const afterDisable = await list(identity);
    const enabled = await setDisabled(identity, "data-search", false);
    const afterEnable = await list(identity);

    expect(disabled).toStrictEqual({ toolId: "data-search", disabled: true });
    expect(afterDisable).toStrictEqual(["data-search", "web-search"]);
    expect(enabled).toStrictEqual({ toolId: "data-search", disabled: false });
    expect(afterEnable).toStrictEqual(["web-search"]);
  });

  it("paid-tools-008 isolates preferences across members and workspaces", async () => {
    const owner = member();
    const peer = member(owner.orgId);
    const elsewhere: Identity = {
      userId: owner.userId,
      orgId: `org_${randomUUID()}`,
    };
    await setDisabled(owner, "web-search", true);

    const peerInitial = await list(peer);
    await setDisabled(peer, "finance", true);
    const elsewhereInitial = await list(elsewhere);
    await setDisabled(elsewhere, "scrape", true);

    expect(peerInitial).toStrictEqual([]);
    expect(elsewhereInitial).toStrictEqual([]);
    await expect(list(owner)).resolves.toStrictEqual(["web-search"]);
    await expect(list(peer)).resolves.toStrictEqual(["finance"]);
    await expect(list(elsewhere)).resolves.toStrictEqual(["scrape"]);
  });

  it("paid-tools-010 rejects caller-selected owners", async () => {
    const identity = member();
    signIn(identity);
    const request = setupRawAppRequest({ context, routes: paidToolsRoutes });

    const statuses: number[] = [];
    for (const owner of [
      { userId: "another-user" },
      { orgId: "another-org" },
    ]) {
      const response = await request("/api/paid-tools/web-search", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ disabled: true, ...owner }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([400, 400]);
    await expect(list(identity)).resolves.toStrictEqual([]);
  });

  it("paid-tools-012 membership deletion clears exactly its paid tool preferences", async () => {
    const departed = member();
    const peer = member(departed.orgId);
    const elsewhere: Identity = {
      userId: departed.userId,
      orgId: `org_${randomUUID()}`,
    };
    for (const identity of [departed, peer, elsewhere]) {
      await setDisabled(identity, "web-search", true);
    }
    const data = {
      organization: { id: departed.orgId },
      public_user_data: { user_id: departed.userId },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data,
    });

    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify({ type: "organizationMembership.deleted", data }),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    await expect(list(departed)).resolves.toStrictEqual([]);
    await expect(list(peer)).resolves.toStrictEqual(["web-search"]);
    await expect(list(elsewhere)).resolves.toStrictEqual(["web-search"]);
  });
});
