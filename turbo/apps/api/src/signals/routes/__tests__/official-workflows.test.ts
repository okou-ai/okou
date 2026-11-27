import { randomUUID } from "node:crypto";

import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feedRoutes } from "../feed";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { workflowsRoutes } from "../workflows";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly orgId: string;
  readonly userId: string;
}

async function workspaceMember(): Promise<Member> {
  const member = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  await createStore().set(
    seedOrgMembership$,
    { ...member, role: "member" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
  return member;
}

async function deliverOrganizationCreated(member: Member) {
  const data = {
    id: member.orgId,
    createdBy: member.userId,
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

function proactive() {
  return setupApp({ context, routes: proactiveSuggestionsRoutes })(
    proactiveSuggestionsContract,
  );
}

function feed() {
  return setupApp({ context, routes: feedRoutes })(feedContract);
}

function morningBrief() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

async function readHourly() {
  return (await accept(proactive().get({ headers }), [200])).body;
}

async function readSources() {
  return (await accept(feed().sources({ headers }), [200])).body;
}

describe("Morning Brief preference", () => {
  it("official-workflows-004 enabling without a time zone keeps the intent and installs no workflow", async () => {
    await workspaceMember();

    const initial = await accept(morningBrief().get({ headers }), [200]);
    expect(initial.body).toStrictEqual({
      status: "paused",
      enabled: false,
      unavailableReason: null,
    });

    const updated = await accept(
      morningBrief().update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(updated.body).toStrictEqual({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });

    const workflows = await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).list({ headers, query: {} }),
      [200],
    );
    expect(
      workflows.body.filter((workflow) => {
        return workflow.official?.definitionName === "morning-brief";
      }),
    ).toStrictEqual([]);
  });
});

describe("My Okou proactive settings", () => {
  async function memberWithOffersOff() {
    const member = await workspaceMember();
    await deliverOrganizationCreated(member);
    await accept(
      feed().updateSources({ headers, body: { offers: false } }),
      [200],
    );
  }

  async function setTogether(enabled: boolean) {
    await accept(
      proactive().updateWithFeed({ headers, body: { enabled } }),
      [200],
    );
    await expect(readHourly()).resolves.toMatchObject({ enabled });
    await expect(readSources()).resolves.toStrictEqual({
      suggestions: enabled,
      offers: false,
      whatsNew: true,
      systemUpdates: true,
    });
  }

  it("official-workflows-001 (1/2) turning hourly checks off also stops new suggestion delivery", async () => {
    const member = await workspaceMember();
    await deliverOrganizationCreated(member);
    await expect(readHourly()).resolves.toMatchObject({ enabled: false });
    await accept(
      feed().updateSources({ headers, body: { offers: false } }),
      [200],
    );
    await expect(readSources()).resolves.toMatchObject({ suggestions: true });

    await setTogether(false);
  });

  it("official-workflows-001 (2/2) turning both on again survives a legacy hourly update", async () => {
    await memberWithOffersOff();
    await accept(
      proactive().updateWithFeed({ headers, body: { enabled: false } }),
      [200],
    );

    await setTogether(true);

    await accept(
      proactive().update({ headers, body: { enabled: false } }),
      [200],
    );
    await expect(readSources()).resolves.toMatchObject({ suggestions: true });
  });

  it("pf-103 keeps the Suggestions choice while the member has no timezone", async () => {
    await workspaceMember();

    const updated = await accept(
      proactive().update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(updated.body).toStrictEqual({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });

    await expect(readHourly()).resolves.toStrictEqual({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });
  });

  it("pf-102 clears the departed member's proactive opt-in on membership deletion", async () => {
    const member = await workspaceMember();
    await Promise.all([
      accept(proactive().update({ headers, body: { enabled: true } }), [200]),
      accept(
        morningBrief().update({ headers, body: { enabled: true } }),
        [200],
      ),
    ]);

    const deletion = {
      organization: { id: member.orgId },
      public_user_data: { user_id: member.userId },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data: deletion,
    });
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify({
          type: "organizationMembership.deleted",
          data: deletion,
        }),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    await createStore().set(
      seedOrgMembership$,
      { ...member, role: "member" },
      context.signal,
    );
    const [hourly, brief] = await Promise.all([
      readHourly(),
      accept(morningBrief().get({ headers }), [200]),
    ]);
    expect(hourly).toMatchObject({ enabled: false, status: "paused" });
    expect(brief.body).toMatchObject({ enabled: false, status: "paused" });
  });

  it("pf-109 clears missing-timezone when onboarding supplies a timezone after opt-in", async () => {
    await workspaceMember();
    await accept(
      morningBrief().update({ headers, body: { enabled: true } }),
      [200],
    );
    await accept(
      proactive().update({ headers, body: { enabled: true } }),
      [200],
    );

    await accept(
      setupApp({ context, routes: onboardingCompleteRoutes })(
        onboardingCompleteContract,
      ).complete({
        headers,
        body: { timezone: "Asia/Shanghai" },
      }),
      [200],
    );

    const [brief, suggestions] = await Promise.all([
      accept(morningBrief().get({ headers }), [200]),
      readHourly(),
    ]);
    expect(brief.body).toMatchObject({
      enabled: true,
      unavailableReason: null,
    });
    expect(suggestions).toMatchObject({
      enabled: true,
      unavailableReason: null,
    });
  });
});
