import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { array, literal, object, string, unknown as zUnknown } from "zod";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  setupAppWithRoutes,
  setupRawAppRequestWithRoutes,
} from "../../../__tests__/test-app";
import { env } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactOgRoutes } from "../artifact-og";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { hostRoutes } from "../host";
import { slackEventsRoutes } from "../slack-events";
import { slackInteractiveRoutes } from "../slack-interactive";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const host = createHostBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function app(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return setupAppWithRoutes({
    context,
    routes: [
      ...artifactAccessRoutes,
      ...artifactReferenceRoutes,
      ...artifactOgRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...hostRoutes,
    ],
  });
}

function profile(user: ApiTestUser) {
  return {
    id: user.userId,
    firstName: "Channel",
    lastName: "Member",
    banned: false,
    primaryEmailAddressId: `email_${user.userId}`,
    emailAddresses: [
      {
        id: `email_${user.userId}`,
        emailAddress: user.email,
        verification: { status: "verified" },
      },
    ],
  };
}

function directory(users: readonly ApiTestUser[]) {
  mockClerkUsers(context, users.map(profile));
  context.mocks.clerk.organizations.getOrganization.mockImplementation(
    (input) => {
      const params = object({ organizationId: string() }).parse(input);
      return Promise.resolve({
        id: params.organizationId,
        name: "Artifact workspace",
      });
    },
  );
  context.mocks.clerk.users.getUserList.mockImplementation((input) => {
    const params = object({ userId: array(string()) }).parse(input);
    return Promise.resolve({
      data: users.map(profile).filter((user) => {
        return params.userId.includes(user.id);
      }),
    });
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()).optional(),
        emailAddress: array(string()).optional(),
      }).parse(input);
      return Promise.resolve({
        data: users
          .filter((user) => {
            return (
              user.orgId === params.organizationId &&
              (!params.userId || params.userId.includes(user.userId)) &&
              (!params.emailAddress || params.emailAddress.includes(user.email))
            );
          })
          .map((user) => {
            return {
              organization: {
                id: params.organizationId,
                name: "Artifact workspace",
              },
              publicUserData: { userId: user.userId },
              role: user.orgRole,
            };
          }),
      });
    },
  );
}

async function fixture(
  options: {
    readonly audience?: "private" | "organization" | "public";
    readonly kind?: "file" | "site";
    readonly siteReference?: boolean;
    readonly image?: boolean;
  } = {},
) {
  integrations.configureSlackAppMocks();
  const owner = createBddApi(context).user({ orgRole: "org:admin" });
  if (!owner.orgId) {
    throw new Error("Expected an owner workspace");
  }
  const sender = `U_OWNER_${randomUUID().slice(0, 8)}`;
  const { teamId } = await integrations.installSlackWorkspace(owner, {
    installerSlackUserId: sender,
  });
  await flushWaitUntilForTest();
  await updateFeatureSwitchesForUser(
    context,
    { ...owner, orgId: owner.orgId },
    {
      [FeatureSwitchKey.ArtifactUserSharing]: true,
    },
  );
  const directoryUsers: ApiTestUser[] = [owner];
  directory(directoryUsers);
  const capture = host.captureHostedSitesS3();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((operation, ...rest) => {
    if (
      operation instanceof HeadObjectCommand &&
      operation.input.Key?.startsWith("private-artifacts/")
    ) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: options.image ? "image/png" : "application/pdf",
        Metadata: { "artifact-id": operation.input.Key.split("/")[1] },
      });
    }
    if (
      operation instanceof GetObjectCommand &&
      operation.input.Key?.startsWith("artifact-shares/") &&
      !capture.objects.has(operation.input.Key)
    ) {
      return Promise.reject(
        Object.assign(new Error("Missing publication policy"), {
          name: "NoSuchKey",
        }),
      );
    }
    if (
      operation instanceof GetObjectCommand &&
      operation.input.Key?.startsWith("private-artifacts/") &&
      !capture.objects.has(operation.input.Key)
    ) {
      return Promise.resolve({
        Body: Readable.from([Buffer.from("report bytes!")]),
        ContentLength: 13,
      });
    }
    return storage(operation, ...rest);
  });
  let resource: {
    readonly kind: "file" | "site";
    readonly id: string;
    readonly url: string;
  };
  if (options.kind === "site") {
    const prepared = await host.prepareHostedSite(owner, {
      site: `channel-${randomUUID().slice(0, 8)}`,
      title: "Channel artifact",
      artifactKind: "hosted-site",
      spaFallback: false,
      visibility: options.audience ?? "private",
      files: [
        hostedTextFile(
          "/index.html",
          "<html><head><title>Private report</title></head><body>Report</body></html>",
        ),
      ],
    });
    const completed = await host.completeHostedSite(
      owner,
      prepared.deploymentId,
    );
    resource = {
      kind: "site",
      id: prepared.siteId,
      url: options.siteReference
        ? new URL(completed.artifactUrl ?? completed.url, env("APP_URL")).href
        : `https://${prepared.publicSlug}.okou.app/`,
    };
  } else {
    const prepared = await accept(
      app(owner)(uploadsContract).prepare({
        headers,
        body: {
          filename: options.image ? "report.png" : "report.pdf",
          contentType: options.image ? "image/png" : "application/pdf",
          size: 13,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      app(owner)(uploadsContract).complete({
        headers,
        body: { id: prepared.body.id },
      }),
      [200],
    );
    resource = {
      kind: "file",
      id: prepared.body.id,
      url: new URL(completed.body.url, env("APP_URL")).href,
    };
    if (options.audience && options.audience !== "private") {
      await accept(
        app(owner)(artifactAccessContract).updateVisibility({
          headers,
          params: { artifactId: resource.id },
          body: { visibility: options.audience },
        }),
        [200],
      );
    }
  }
  const channel = `C_${randomUUID().slice(0, 8)}`;
  const members = [sender];
  context.mocks.slack.conversations.members.mockResolvedValue({
    ok: true,
    members,
    response_metadata: { next_cursor: "" },
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1795586400.000002",
  });
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
  const callbacks: { readonly text: string }[] = [];
  const responseUrl = `https://hooks.slack.com/actions/${teamId}/${randomUUID()}`;
  server.use(
    http.post(responseUrl, async ({ request }) => {
      callbacks.push(object({ text: string() }).parse(await request.json()));
      return HttpResponse.text("ok");
    }),
  );
  context.mocks.slack.chat.postEphemeral.mockClear();
  context.mocks.resend.send.mockClear();
  return {
    owner,
    sender,
    teamId,
    channel,
    members,
    directoryUsers,
    resource,
    callbacks,
    responseUrl,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function addMember(f: Fixture, email?: string) {
  const id = `U_MEMBER_${randomUUID().slice(0, 8)}`;
  f.members.push(id);
  context.mocks.slack.users.identities.set(id, {
    id,
    team_id: f.teamId,
    real_name: "Channel member",
    profile: { display_name: "Channel member", ...(email ? { email } : {}) },
  });
  return id;
}

function addWorkspaceMember(f: Fixture) {
  const user = createBddApi(context).user({
    orgId: f.owner.orgId ?? undefined,
  });
  f.directoryUsers.push(user);
  directory(f.directoryUsers);
  const slackUserId = addMember(f, user.email);
  return { user, slackUserId };
}

async function connectedMember(f: Fixture, sameWorkspace = false) {
  const user = createBddApi(context).user(
    sameWorkspace ? { orgId: f.owner.orgId ?? undefined } : {},
  );
  const slackUserId = addMember(f, user.email);
  await integrations.connectSlackUser(user, {
    workspaceId: f.teamId,
    slackUserId,
    channelId: f.channel,
    threadTs: "1795586400.000001",
  });
  await flushWaitUntilForTest();
  f.directoryUsers.push(user);
  directory(f.directoryUsers);
  context.mocks.slack.chat.postEphemeral.mockClear();
  return { user, slackUserId };
}

async function postLink(
  f: Fixture,
  overrides: Record<string, unknown> = {},
  retry = false,
) {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: f.teamId,
    event_id: `Ev_${randomUUID()}`,
    event: {
      type: "link_shared",
      channel: f.channel,
      user: f.sender,
      is_bot_user_member: true,
      source: "conversations_history",
      message_ts: "1795586400.000001",
      links: [{ url: f.resource.url }],
      ...overrides,
    },
  });
  const response = await setupRawAppRequestWithRoutes({
    context,
    routes: slackEventsRoutes,
  })("/api/webhooks/slack/events", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...integrations.signedSlackIngressHeaders(body),
      ...(retry ? { "x-slack-retry-num": "1" } : {}),
    },
  });
  expect(response.status).toBe(200);
  await flushWaitUntilForTest();
}

function promptActions() {
  const call = context.mocks.slack.chat.postEphemeral.mock.calls.at(-1)?.[0];
  const prompt = object({
    channel: string(),
    user: string(),
    blocks: array(zUnknown()),
  }).parse(call);
  const actions = prompt.blocks.flatMap((block) => {
    const parsed = object({
      type: literal("actions"),
      elements: array(object({ action_id: string(), value: string() })),
    }).safeParse(block);
    return parsed.success ? parsed.data.elements : [];
  });
  return { ...prompt, actions };
}

async function click(
  f: Fixture,
  actionId = "artifact_share_channel",
  overrides: Record<string, unknown> = {},
) {
  const action = promptActions().actions.find((entry) => {
    return entry.action_id === actionId;
  });
  if (!action) {
    throw new Error(`Expected ${actionId} button`);
  }
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      team: { id: f.teamId },
      user: { id: f.sender },
      channel: { id: f.channel },
      response_url: f.responseUrl,
      actions: [action],
      ...overrides,
    }),
  }).toString();
  const response = await setupRawAppRequestWithRoutes({
    context,
    routes: slackInteractiveRoutes,
  })("/api/webhooks/slack/interactive", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...integrations.signedSlackIngressHeaders(body),
    },
  });
  expect(response.status).toBe(200);
  await flushWaitUntilForTest();
  return response;
}

async function shares(f: Fixture) {
  return (
    await accept(
      app(f.owner)(artifactAccessContract).listShares({
        headers,
        params: { artifactId: f.resource.id },
      }),
      [200],
    )
  ).body.shares;
}

async function visibility(f: Fixture) {
  return (
    await accept(
      app(f.owner)(artifactAccessContract).getVisibility({
        headers,
        params: { artifactId: f.resource.id },
      }),
      [200],
    )
  ).body.visibility;
}

test.each(["file", "site"] as const)(
  "privately prompts the %s owner and shares only with the members present at click time",
  async (kind) => {
    const f = await fixture({ kind });
    const viewer = await connectedMember(f);
    const departed = addWorkspaceMember(f);
    await postLink(f);
    const prompt = promptActions();
    expect(prompt.user).toBe(f.sender);
    expect(prompt.channel).toBe(f.channel);
    expect(
      prompt.actions.map((action) => {
        return action.action_id;
      }),
    ).toStrictEqual([
      "artifact_share_channel",
      "artifact_share_organization",
      "artifact_share_public",
    ]);
    await expect(shares(f)).resolves.toStrictEqual([]);
    f.members.splice(f.members.indexOf(departed.slackUserId), 1);
    const joined = addWorkspaceMember(f);
    await click(f);
    expect(
      (await shares(f))
        .map((share) => {
          return share.email;
        })
        .sort(),
    ).toStrictEqual([viewer.user.email, joined.user.email].sort());
    if (kind === "file") {
      const preview = await accept(
        app(viewer.user)(artifactReferencesContract).resolve({
          headers,
          params: {
            reference: new URL(f.resource.url).pathname.slice(
              "/artifacts/".length,
            ),
          },
        }),
        [200],
      );
      expect(preview.body.target).toStrictEqual({
        kind: "file",
        id: f.resource.id,
      });
    }
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    expect(f.callbacks.at(-1)?.text).toContain("2 current channel members");
    expect(f.callbacks.at(-1)?.text).not.toContain(departed.user.email);
  },
);

test("omits workspace visibility when already workspace-visible and reports external email-only members as unresolved", async () => {
  const f = await fixture({ audience: "organization" });
  await connectedMember(f, true);
  const externalId = addMember(f, `external-${randomUUID()}@example.com`);
  await postLink(f);
  expect(
    promptActions().actions.map((action) => {
      return action.action_id;
    }),
  ).toStrictEqual(["artifact_share_channel", "artifact_share_public"]);
  await click(f);
  await expect(shares(f)).resolves.toStrictEqual([]);
  expect(f.callbacks.at(-1)?.text).toContain(`<@${externalId}>`);
  await expect(visibility(f)).resolves.toBe("organization");
});

test("does not prompt when all channel members already have workspace access", async () => {
  const f = await fixture({ audience: "organization" });
  await connectedMember(f, true);
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: f.channel,
      ts: "1795586400.000001",
      unfurls: expect.objectContaining({
        [f.resource.url]: expect.any(Object),
      }),
    }),
  );
});

test("recognizes existing workspace access by verified email without requiring a Slack account binding", async () => {
  const f = await fixture({ audience: "organization" });
  addWorkspaceMember(f);
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  await expect(shares(f)).resolves.toStrictEqual([]);
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(1);
});

test("does not prompt or inspect members for public artifacts", async () => {
  const f = await fixture({ audience: "public", kind: "site" });
  addMember(f, `external-${randomUUID()}@example.com`);
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  expect(context.mocks.slack.conversations.members).not.toHaveBeenCalled();
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledWith(
    expect.objectContaining({ channel: f.channel }),
  );
});

test("does not let a connected non-owner manage another person's artifact", async () => {
  const f = await fixture();
  const viewer = await connectedMember(f);
  await postLink(f, { user: viewer.slackUserId });
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  await expect(shares(f)).resolves.toStrictEqual([]);
});

test("paginates channel membership, including an empty page with a continuation", async () => {
  const f = await fixture();
  const member = addWorkspaceMember(f);
  context.mocks.slack.conversations.members.mockImplementation((input) => {
    const page = object({ cursor: string().optional() }).parse(input);
    return Promise.resolve(
      page.cursor
        ? {
            ok: true,
            members: [f.sender, member.slackUserId],
            response_metadata: { next_cursor: "" },
          }
        : {
            ok: true,
            members: [],
            response_metadata: { next_cursor: "page-two" },
          },
    );
  });
  await postLink(f);
  await click(f);
  expect(
    (await shares(f)).map((share) => {
      return share.email;
    }),
  ).toStrictEqual([member.user.email]);
});

test("reports missing email separately while sharing with identifiable members", async () => {
  const f = await fixture();
  const unresolved = addMember(f);
  addWorkspaceMember(f);
  await postLink(f);
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(1);
  expect(f.callbacks.at(-1)?.text).toContain(`<@${unresolved}>`);
  expect(f.callbacks.at(-1)?.text).toContain("Could not finish sharing");
});

test("does not equate an unavailable member list with an empty channel", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f);
  context.mocks.slack.conversations.members.mockRejectedValue(
    new Error("Channel is unavailable"),
  );
  await click(f);
  await expect(shares(f)).resolves.toStrictEqual([]);
  expect(f.callbacks.at(-1)?.text).toContain("could not be verified");
});

test.each(["user", "team", "channel", "token", "expired"])(
  "rejects a stale or mismatched %s action",
  async (changed) => {
    const f = await fixture();
    addWorkspaceMember(f);
    await postLink(f);
    const overrides: Record<string, unknown> =
      changed === "token"
        ? { actions: [{ ...promptActions().actions[0], value: "tampered" }] }
        : changed === "expired"
          ? {}
          : { [changed]: { id: `WRONG_${randomUUID()}` } };
    if (changed === "expired") {
      mockNow(now() + 16 * 60_000);
    }
    const response = await click(f, "artifact_share_channel", overrides);
    expect(response.body).toMatchObject({
      response_type: "ephemeral",
      text: expect.stringContaining("expired"),
    });
    await expect(shares(f)).resolves.toStrictEqual([]);
    expect(f.callbacks).toStrictEqual([]);
  },
);

test("does not duplicate invitations when the same button is clicked again", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f);
  await click(f);
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(1);
  expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
  expect(f.callbacks.at(-1)?.text).toContain(
    "already have access or an invitation",
  );
});

test("shares with more than ten channel members in one action", async () => {
  const f = await fixture();
  for (let index = 0; index < 12; index++) {
    addWorkspaceMember(f);
  }
  await postLink(f);
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(12);
  expect(f.callbacks.at(-1)?.text).not.toContain("limit was reached");
});

test("keeps confirmed invitations when the existing hourly recipient limit is reached", async () => {
  const f = await fixture();
  for (let index = 0; index < 61; index++) {
    addWorkspaceMember(f);
  }
  await postLink(f);
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(60);
  expect(f.callbacks.at(-1)?.text).toContain("sharing limit was reached");
  expect(f.callbacks.at(-1)?.text).toContain("1 remaining");
  mockNow(now() + 3_600_001);
  await postLink(f);
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(61);
  expect(context.mocks.resend.send).toHaveBeenCalledTimes(61);
});

test.each(["file", "site"] as const)(
  "can make a %s workspace-visible from the private owner prompt",
  async (kind) => {
    const f = await fixture({ kind });
    addMember(f, `invited-${randomUUID()}@example.com`);
    await postLink(f);
    await click(f, "artifact_share_organization");
    await expect(visibility(f)).resolves.toBe("organization");
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  },
);

test("can make a hosted site public and refresh the original Slack preview", async () => {
  const f = await fixture({ kind: "site" });
  addMember(f, `invited-${randomUUID()}@example.com`);
  await postLink(f);
  await click(f, "artifact_share_public");
  await expect(visibility(f)).resolves.toBe("public");
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: f.channel,
      ts: "1795586400.000001",
      unfurls: expect.objectContaining({
        [f.resource.url]: expect.any(Object),
      }),
    }),
  );
});

test("does not repeat private prompts for retries, refreshes, or composer events", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f, {}, true);
  await postLink(f, { is_unfurl_refresh: true });
  await postLink(f, { source: "composer" });
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
});

test("shares a website through its App artifact reference", async () => {
  const f = await fixture({ kind: "site", siteReference: true });
  const member = addWorkspaceMember(f);
  await postLink(f);
  await click(f);
  expect(
    (await shares(f)).map((share) => {
      return share.email;
    }),
  ).toStrictEqual([member.user.email]);
});

test("ignores already-granted members, bots, and deleted members", async () => {
  const f = await fixture();
  const member = addWorkspaceMember(f);
  await accept(
    app(f.owner)(artifactAccessContract).addShare({
      headers,
      params: { artifactId: f.resource.id },
      body: { userId: member.user.userId },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  for (const state of ["bot", "deleted"]) {
    addMember(f, `${state}-${randomUUID()}@example.com`);
  }
  const identities = context.mocks.slack.users.identities;
  context.mocks.slack.users.info.mockImplementation((input) => {
    const { user } = object({ user: string() }).parse(input);
    const identity = identities.get(user);
    return Promise.resolve({
      ok: true,
      user: {
        ...identity,
        is_bot: identity?.profile.email?.startsWith("bot-"),
        deleted: identity?.profile.email?.startsWith("deleted-"),
      },
    });
  });
  context.mocks.slack.chat.postEphemeral.mockClear();
  const before = context.mocks.resend.send.mock.calls.length;
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  expect(context.mocks.resend.send).toHaveBeenCalledTimes(before);
});

test.each(["membership", "banned", "left-channel"])(
  "rechecks %s before applying an old sharing button",
  async (change) => {
    const f = await fixture();
    addWorkspaceMember(f);
    await postLink(f);
    if (change === "membership") {
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
    } else if (change === "banned") {
      mockClerkUsers(context, [{ ...profile(f.owner), banned: true }]);
    } else {
      f.members.splice(f.members.indexOf(f.sender), 1);
    }
    await click(f);
    expect(f.callbacks.at(-1)?.text).toMatch(
      /no longer available|could not be verified/u,
    );
    directory(f.directoryUsers);
    await expect(shares(f)).resolves.toStrictEqual([]);
  },
);

test("rejects a forged callback destination", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f);
  const response = await click(f, "artifact_share_channel", {
    response_url: "https://example.com/actions/steal",
  });
  expect(response.body).toMatchObject({ response_type: "ephemeral" });
  await expect(shares(f)).resolves.toStrictEqual([]);
});

test("can make a file public and refresh its original preview", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f);
  await click(f, "artifact_share_public");
  await expect(visibility(f)).resolves.toBe("public");
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: f.channel,
      unfurls: expect.objectContaining({
        [f.resource.url]: expect.any(Object),
      }),
    }),
  );
});

test("an owner can change general visibility when channel membership cannot be read", async () => {
  const f = await fixture();
  addWorkspaceMember(f);
  await postLink(f);
  context.mocks.slack.conversations.members.mockRejectedValue(
    new Error("Channel membership is unavailable"),
  );
  await click(f, "artifact_share_public");
  await expect(visibility(f)).resolves.toBe("public");
});

test.each(["file", "site"] as const)(
  "adds a restricted %s preview after granting access to every connected member",
  async (kind) => {
    const f = await fixture({ kind, image: kind === "file" });
    const viewer = await connectedMember(f);
    await postLink(f);
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    await click(f);
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(1);
    const unfurl = object({
      channel: string(),
      ts: string(),
      unfurls: object({}).catchall(object({ blocks: array(zUnknown()) })),
    }).parse(context.mocks.slack.chat.unfurl.mock.calls[0]?.[0]);
    expect(unfurl.channel).toBe(f.channel);
    expect(unfurl.ts).toBe("1795586400.000001");
    expect(unfurl.unfurls[f.resource.url]?.blocks).toContainEqual(
      expect.objectContaining({ type: "image" }),
    );
    if (kind === "file") {
      const anonymous = await accept(
        app(f.owner)(artifactOgContract).metadata({
          query: {
            kind: "reference",
            id: new URL(f.resource.url).pathname.slice("/artifacts/".length),
          },
        }),
        [200],
      );
      expect(anonymous.body.available).toBeFalsy();
    }
    await expect(visibility(f)).resolves.toBe("private");
    expect(
      (await shares(f)).map((share) => {
        return share.email;
      }),
    ).toStrictEqual([viewer.user.email]);
    context.mocks.slack.chat.unfurl.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    await postLink(f);
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(1);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  },
);

test("refreshes the preview after making a file workspace-visible when every member belongs to that workspace", async () => {
  const f = await fixture();
  await connectedMember(f, true);
  await postLink(f);
  await click(f, "artifact_share_organization");
  expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(1);
  await expect(shares(f)).resolves.toStrictEqual([]);
});

test("retains a private file without a preview while an external email-only member remains unresolved", async () => {
  const f = await fixture({ image: true });
  addMember(f, `pending-${randomUUID()}@example.com`);
  await postLink(f);
  await click(f);
  await expect(shares(f)).resolves.toStrictEqual([]);
  expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  context.mocks.slack.chat.postEphemeral.mockClear();
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledTimes(1);
  expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
});

test("checks newly joined members again before publishing a post-share preview", async () => {
  const f = await fixture();
  await connectedMember(f);
  await postLink(f);
  const before = [...f.members];
  addMember(f, `joined-${randomUUID()}@example.com`);
  context.mocks.slack.conversations.members
    .mockResolvedValueOnce({ ok: true, members: before })
    .mockResolvedValueOnce({ ok: true, members: [...f.members] });
  await click(f);
  await expect(shares(f)).resolves.toHaveLength(1);
  expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
});

test("does not publish a workspace preview when a member's identity cannot be confirmed", async () => {
  const f = await fixture({ audience: "organization", image: true });
  await connectedMember(f, true);
  context.mocks.slack.users.info.mockRejectedValue(
    new Error("Slack profile unavailable"),
  );
  await postLink(f);
  expect(context.mocks.slack.chat.postEphemeral).toHaveBeenCalledTimes(1);
  expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
});
