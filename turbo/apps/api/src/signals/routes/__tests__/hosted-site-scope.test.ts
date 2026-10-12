import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";
import { hostContract } from "@okouai/api-contracts/contracts/host";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { hostRoutes } from "../host";
import { expectApiError } from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);
const host = createHostMapsBddApi(context);

function hostedSiteBody(site: string, content: string) {
  return {
    site,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${content}</main>`)],
  };
}

async function prepareCaseSite(site: string) {
  const actor = fixture.bdd.user();
  fixture.routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  host.captureHostedSitesS3();
  const app = await setupApp({ context, routes: hostRoutes, isolatePg: true });
  const response = await accept(
    app(hostContract).prepare({
      headers: { authorization: "Bearer clerk-session" },
      body: hostedSiteBody(site, "organization"),
    }),
    [200],
  );
  const entitled = await fixture.entitledNativeChatActor(actor);
  host.captureHostedSitesS3();
  return { first: response.body, entitled };
}

/** Claim a real chat Run and own cancellation before a claim can fail. */
async function claimedChatRun(
  entitled: Awaited<ReturnType<typeof fixture.entitledNativeChatActor>>,
  prompt: string,
) {
  const run = await fixture.sendChatRun(entitled.actor, {
    agentId: entitled.agentId,
    prompt,
  });
  let active = true;
  onTestFinished(async () => {
    if (active) {
      await fixture.api.requestCancelRun(entitled.actor, run.runId, [200]);
    }
  });
  const { claim, sandboxHeaders } = await fixture.claimChatRun(
    entitled.runnerGroup,
    run.runId,
  );
  return {
    ...run,
    bearer: `Bearer ${okouTokenFromClaim(claim)}`,
    async complete() {
      await fixture.completeChatRunOk(run.runId, sandboxHeaders);
      active = false;
    },
  };
}

describe("thread-independent hosted publication through host APIs", () => {
  it("redeploys one organization site across chats", async () => {
    const site = `host-${randomUUID().slice(0, 8)}`;
    const { first, entitled } = await prepareCaseSite(site);
    const firstRun = await claimedChatRun(
      entitled,
      "publish the first chat version",
    );
    const second = await fixture.chat.prepareHostedSiteWithBearer(
      firstRun.bearer,
      hostedSiteBody(site, "first chat"),
    );
    await firstRun.complete();

    const otherRun = await claimedChatRun(entitled, "publish in another chat");
    expect(otherRun.threadId).not.toBe(firstRun.threadId);
    const third = await fixture.chat.prepareHostedSiteWithBearer(
      otherRun.bearer,
      hostedSiteBody(site, "another chat"),
    );
    for (const [index, deployment] of [first, second, third].entries()) {
      expect(deployment).toMatchObject({
        siteId: first.siteId,
        publicSlug: first.publicSlug,
        url: first.url,
        deploymentVersion: index + 1,
      });
    }
    await otherRun.complete();
  });

  it("serializes concurrent cross-chat redeploys and rejects other owners", async () => {
    const site = `host-${randomUUID().slice(0, 8)}`;
    const { first, entitled } = await prepareCaseSite(site);
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      runs.push(
        await claimedChatRun(entitled, `publish concurrently ${index}`),
      );
    }
    expect(
      new Set(
        runs.map((run) => {
          return run.threadId;
        }),
      ).size,
    ).toBe(3);
    const created = await Promise.all(
      runs.map(async (run, index) => {
        return await fixture.chat.prepareHostedSiteWithBearer(
          run.bearer,
          hostedSiteBody(site, `concurrent ${index}`),
        );
      }),
    );
    for (const deployment of created) {
      expect(deployment.siteId).toBe(first.siteId);
      expect(deployment.publicSlug).toBe(first.publicSlug);
    }
    expect(
      new Set(
        created.map((result) => {
          return result.deploymentVersion;
        }),
      ),
    ).toStrictEqual(new Set([2, 3, 4]));
    for (const run of runs) {
      await run.complete();
    }

    const member = fixture.bdd.user({ orgId: entitled.actor.orgId });
    const conflict = await host.requestPrepareHostedSite(
      member,
      hostedSiteBody(site, "member"),
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.message).toBe(
      `Hosted site "${site}" belongs to another owner. Choose a different --site value and rerun the same okou host command.`,
    );
  });
});
