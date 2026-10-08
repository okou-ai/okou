import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { expectApiError } from "../../routes/__tests__/helpers/api-bdd";
import { hostedTextFile } from "../../routes/__tests__/helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "../../routes/__tests__/helpers/api-bdd-host-maps";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "../../routes/__tests__/helpers/chat-events-fixture";

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

/** Launch and claim a chat run; its claimed Okou token publishes as the chat. */
async function claimedChatRun(
  entitled: Awaited<ReturnType<typeof fixture.entitledNativeChatActor>>,
  prompt: string,
  threadId?: string,
) {
  const run = await fixture.sendChatRun(entitled.actor, {
    agentId: entitled.agentId,
    prompt,
    ...(threadId === undefined ? {} : { threadId }),
  });
  const { claim, sandboxHeaders } = await fixture.claimChatRun(
    entitled.runnerGroup,
    run.runId,
  );
  return {
    ...run,
    sandboxHeaders,
    bearer: `Bearer ${okouTokenFromClaim(claim)}`,
  };
}

describe("hosted publication scope through host APIs", () => {
  it("redeploys one site per scope within and across chat and organization scopes", async () => {
    const entitled = await fixture.entitledNativeChatActor();
    host.captureHostedSitesS3();
    const site = `scope-${randomUUID().slice(0, 8)}`;

    const firstRun = await claimedChatRun(entitled, "publish the first site");
    const first = await fixture.chat.prepareHostedSiteWithBearer(
      firstRun.bearer,
      hostedSiteBody(site, "first"),
    );
    await fixture.completeChatRunOk(firstRun.runId, firstRun.sandboxHeaders);

    // The same preferred name in one chat redeploys its site; another chat
    // owns a separate site under a suffixed name.
    const sameChatRun = await claimedChatRun(
      entitled,
      "publish the site again",
      firstRun.threadId,
    );
    const second = await fixture.chat.prepareHostedSiteWithBearer(
      sameChatRun.bearer,
      hostedSiteBody(site, "second"),
    );
    const otherRun = await claimedChatRun(entitled, "publish in another chat");
    const other = await fixture.chat.prepareHostedSiteWithBearer(
      otherRun.bearer,
      hostedSiteBody(site, "other"),
    );
    expect(second.siteId).toBe(first.siteId);
    expect(second.deploymentVersion).toBe(2);
    expect(other.siteId).not.toBe(first.siteId);
    expect(other.publicSlug).not.toBe(first.publicSlug);

    // A chat cannot take over a name the organization already owns.
    const organizationSite = `scope-org-${randomUUID().slice(0, 8)}`;
    await host.prepareHostedSite(
      entitled.actor,
      hostedSiteBody(organizationSite, "organization"),
    );
    const takeover = await fixture.chat.requestPrepareHostedSiteWithBearer(
      sameChatRun.bearer,
      hostedSiteBody(organizationSite, "takeover"),
      [409],
    );
    expectApiError(takeover.body);
    expect(takeover.body.error.message).toBe(
      `Hosted site slug "${organizationSite}" is owned outside this chat. Choose a different --site value and rerun the same okou host command.`,
    );
  });

  it("serializes concurrent redeploys of one site and rejects other owners", async () => {
    const entitled = await fixture.entitledNativeChatActor();
    host.captureHostedSitesS3();
    const site = `scope-${randomUUID().slice(0, 8)}`;
    const run = await claimedChatRun(entitled, "publish concurrently");
    const created = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        return await fixture.chat.prepareHostedSiteWithBearer(
          run.bearer,
          hostedSiteBody(site, `concurrent ${index}`),
        );
      }),
    );
    expect(
      new Set(
        created.map((result) => {
          return result.siteId;
        }),
      ).size,
    ).toBe(1);
    // Each concurrent publication still owns a distinct version.
    expect(
      new Set(
        created.map((result) => {
          return result.deploymentVersion;
        }),
      ),
    ).toStrictEqual(new Set([1, 2, 3]));

    // Redeploying replaces what the site serves, so organization membership
    // does not authorize it.
    const organizationSite = `scope-owner-${randomUUID().slice(0, 8)}`;
    await host.prepareHostedSite(
      entitled.actor,
      hostedSiteBody(organizationSite, "owner"),
    );
    const member = fixture.bdd.user({ orgId: entitled.actor.orgId });
    const conflict = await host.requestPrepareHostedSite(
      member,
      hostedSiteBody(organizationSite, "member"),
      [409],
    );
    expectApiError(conflict.body);
    expect(conflict.body.error.message).toBe(
      `Hosted site "${organizationSite}" belongs to another owner. Choose a different --site value and rerun the same okou host command.`,
    );
  });
});
