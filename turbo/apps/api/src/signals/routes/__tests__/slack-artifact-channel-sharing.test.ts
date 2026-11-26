import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactShareRoutes } from "../artifact-shares";
import { artifactSharingRoutes } from "../artifact-sharing";
import { hostedSiteAccessRoutes } from "../hosted-site-access";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import {
  createBddIntegrationApi,
  mockSlackIdentityLookup,
} from "./helpers/api-bdd-integrations";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicSlackOrgApi,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";

const context = testContext();
const store = createStore();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const CHANNEL = "C_ARTIFACT_SHARE";
const MESSAGE_TS = "1796112000.000101";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0/1/artifact-share";

type Owner = ApiTestUser & { readonly orgId: string };

function client(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({
    context,
    routes: [
      ...artifactSharingRoutes,
      ...artifactShareRoutes,
      ...hostedSiteAccessRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

/** Clerk profiles with verified emails for every Okou account in the case. */
function directory(users: readonly ApiTestUser[]) {
  mockClerkUsers(
    context,
    users.map((user) => {
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
    }),
  );
}

/** Serves stored private artifact bytes for uploads made by the case. */
function privateArtifactStorage() {
  const stored = createHostBddApi(context).captureHostedSitesS3();
  const storage = context.mocks.s3.send.getMockImplementation();
  if (!storage) {
    throw new Error("Expected captured hosted-site storage");
  }
  context.mocks.s3.send.mockImplementation((operation, ...rest) => {
    const key =
      operation instanceof HeadObjectCommand ||
      operation instanceof GetObjectCommand
        ? operation.input.Key
        : undefined;
    if (
      operation instanceof HeadObjectCommand &&
      key?.startsWith("private-artifacts/")
    ) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: "application/pdf",
        Metadata: { "artifact-id": key.split("/")[1] },
      });
    }
    if (
      operation instanceof GetObjectCommand &&
      key?.startsWith("artifact-shares/") &&
      !stored.objects.has(key)
    ) {
      return Promise.reject(
        Object.assign(new Error("Missing publication policy"), {
          name: "NoSuchKey",
        }),
      );
    }
    if (
      operation instanceof GetObjectCommand &&
      key?.startsWith("private-artifacts/") &&
      !stored.objects.has(key)
    ) {
      return Promise.resolve({
        Body: Readable.from([Buffer.from("report bytes!")]),
        ContentLength: 13,
      });
    }
    return storage(operation, ...rest);
  });
  return stored;
}

interface Artifact {
  readonly kind: "file" | "site";
  readonly id: string;
  readonly url: string;
}

async function uploadFile(
  owner: Owner,
  audience: "private" | "organization",
): Promise<Artifact> {
  const prepared = await accept(
    client(owner)(uploadsContract).prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  const completed = await accept(
    client(owner)(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  if (audience !== "private") {
    await accept(
      client(owner)(artifactSharesContract).update({
        headers,
        body: { target: { kind: "file", id: prepared.body.id }, audience },
      }),
      [200],
    );
  }
  return {
    kind: "file",
    id: prepared.body.id,
    url: new URL(completed.body.url, env("APP_URL")).href,
  };
}

async function publishSite(
  owner: Owner,
  stored: ReturnType<typeof privateArtifactStorage>,
  visibility: "private" | "public",
  link: "site" | "artifact" = "site",
): Promise<Artifact> {
  const html =
    "<html><head><title>Channel report</title></head><body>Report</body></html>";
  const host = createHostBddApi(context);
  const deployment = await host.prepareHostedSite(owner, {
    site: `share-${randomUUID().slice(0, 8)}`,
    title: "Channel report",
    artifactKind: "hosted-site",
    spaFallback: false,
    visibility,
    files: [hostedTextFile("/index.html", html)],
  });
  for (const key of stored.objects.keys()) {
    if (key.endsWith("/index.html")) {
      stored.objects.set(key, html);
    }
  }
  const completed = await host.completeHostedSite(
    owner,
    deployment.deploymentId,
  );
  const url =
    link === "artifact"
      ? new URL(completed.artifactUrl ?? completed.url, env("APP_URL")).href
      : completed.url;
  return { kind: "site", id: deployment.siteId, url };
}

/**
 * A Slack workspace installed and connected by its Okou admin, with artifact
 * email sharing enabled and the owner alone in the channel.
 */
async function workspace() {
  const slack = createPublicSlackOrgApi(context);
  const installed = await slack.installOrg({ withConnection: true });
  const owner: Owner = { ...installed.actor, orgId: installed.orgId };
  await store.set(
    seedOrgMembership$,
    { orgId: owner.orgId, userId: owner.userId, role: "admin" },
    context.signal,
  );
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.HostedSiteEmailSharing]: true,
  });
  const accounts: ApiTestUser[] = [owner];
  directory(accounts);
  const stored = privateArtifactStorage();
  const members: string[] = [];
  /** Slack reports the channel membership at the time of each read. */
  function join(id: string) {
    members.push(id);
    context.mocks.slack.conversations.members.mockResolvedValue({
      ok: true,
      members: [...members],
      response_metadata: { next_cursor: "" },
    });
  }
  join(installed.slackUserId);
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1796112000.000102",
  });
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
  const callbacks: string[] = [];
  server.use(
    http.post(RESPONSE_URL, async ({ request }) => {
      const body = object({ text: string() }).parse(await request.json());
      callbacks.push(body.text);
      return new HttpResponse("ok");
    }),
  );
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postEphemeral.mockClear();
  context.mocks.slack.chat.unfurl.mockClear();
  context.mocks.slack.conversations.members.mockClear();
  context.mocks.resend.send.mockClear();

  /** A Slack member with an email and no Okou connection. */
  function emailMember(email = `${randomUUID()}@external.test`) {
    const id = uniqueSlackUserId();
    mockSlackIdentityLookup(context, {
      id,
      team_id: installed.slackWorkspaceId,
      real_name: "Channel Guest",
      profile: { email, display_name: "Channel Guest" },
    });
    join(id);
    return { id, email };
  }

  /** A Slack member whose profile has no email, or a bot or deleted user. */
  function profileMember(kind: "no-email" | "bot" | "deleted") {
    const id = uniqueSlackUserId();
    const identity = {
      id,
      team_id: installed.slackWorkspaceId,
      real_name: "Channel Member",
      profile: { display_name: "Channel Member" },
      ...(kind === "bot" ? { is_bot: true } : {}),
      ...(kind === "deleted" ? { deleted: true } : {}),
    };
    mockSlackIdentityLookup(context, identity);
    join(id);
    return { id };
  }

  /** An Okou account connected to this Slack workspace. */
  async function connectedMember(orgId?: string) {
    const user = createBddApi(context).user(
      orgId === undefined ? {} : { orgId, orgRole: "org:member" },
    );
    const userOrgId = user.orgId;
    if (!userOrgId) {
      throw new Error("Expected the member to belong to a workspace");
    }
    await store.set(
      seedOrgMembership$,
      { orgId: userOrgId, userId: user.userId },
      context.signal,
    );
    const { slackUserId } = await slack.connectMember({
      orgId: userOrgId,
      userId: user.userId,
      slackWorkspaceId: installed.slackWorkspaceId,
    });
    accounts.push(user);
    directory(accounts);
    join(slackUserId);
    return { ...user, slackUserId };
  }

  async function postLink(url: string, user = installed.slackUserId) {
    await createBddIntegrationApi(context).postSlackEvent(
      installed.slackWorkspaceId,
      {
        type: "link_shared",
        channel: CHANNEL,
        message_ts: MESSAGE_TS,
        user,
        links: [{ url, domain: new URL(url).hostname }],
      },
    );
    await flushWaitUntilForTest();
  }

  function promptActions(index = -1) {
    const call = context.mocks.slack.chat.postEphemeral.mock.calls.at(index);
    const prompt = object({
      channel: string(),
      user: string(),
      blocks: array(
        object({
          type: string(),
          elements: array(
            object({
              action_id: string().optional(),
              value: string().optional(),
            }),
          ).optional(),
        }),
      ),
    }).parse(call?.[0]);
    const actions = prompt.blocks.flatMap((block) => {
      return block.elements ?? [];
    });
    return {
      channel: prompt.channel,
      user: prompt.user,
      actionIds: actions.flatMap((action) => {
        return action.action_id ? [action.action_id] : [];
      }),
      token: actions.find((action) => {
        return action.value !== undefined;
      })?.value,
    };
  }

  function promptText(): string {
    const call = context.mocks.slack.chat.postEphemeral.mock.calls.at(-1);
    const prompt = object({
      blocks: array(object({ text: object({ text: string() }).optional() })),
    }).parse(call?.[0]);
    return prompt.blocks
      .map((block) => {
        return block.text?.text ?? "";
      })
      .join("\n");
  }

  async function click(action: string, token = promptActions().token) {
    if (!token) {
      throw new Error("Expected a sharing prompt token");
    }
    const body = await createBddIntegrationApi(context).postSlackInteractive({
      type: "block_actions",
      team: { id: installed.slackWorkspaceId },
      user: { id: installed.slackUserId },
      channel: { id: CHANNEL },
      response_url: RESPONSE_URL,
      actions: [{ action_id: action, value: token }],
    });
    await flushWaitUntilForTest();
    return body;
  }

  async function shareEmails(artifact: Artifact) {
    const response = await accept(
      client(owner)(artifactSharingContract).list({
        headers,
        params: { kind: artifact.kind, id: artifact.id },
      }),
      [200],
    );
    return response.body.shares
      .map((share) => {
        return share.email;
      })
      .sort();
  }

  async function fileAudience(artifact: Artifact) {
    const response = await accept(
      client(owner)(artifactSharesContract).status({
        headers,
        body: { kind: "file", id: artifact.id },
      }),
      [200],
    );
    return response.body.audience;
  }

  function unfurledUrls(): string[] {
    return context.mocks.slack.chat.unfurl.mock.calls.flatMap((call) => {
      const request = object({
        channel: string(),
        ts: string(),
        unfurls: object({}).catchall(object({}).passthrough()),
      }).parse(call[0]);
      return Object.keys(request.unfurls).map((url) => {
        return `${request.channel}/${request.ts}/${url}`;
      });
    });
  }

  return {
    ...installed,
    owner,
    stored,
    callbacks,
    emailMember,
    profileMember,
    connectedMember,
    postLink,
    promptActions,
    promptText,
    click,
    shareEmails,
    fileAudience,
    unfurledUrls,
  };
}

describe("Slack artifact channel sharing", () => {
  it("slack-artifact-channel-sharing-016 rejects a sharing button after it expires", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    await w.postLink(file.url);
    mockNow(now() + 16 * 60_000);
    const response = object({ response_type: string(), text: string() }).parse(
      await w.click("artifact_share_channel"),
    );
    expect(response.response_type).toBe("ephemeral");
    expect(response.text).toContain("expired");
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
    expect(w.callbacks).toStrictEqual([]);
  });

  it("slack-artifact-channel-sharing-004 does not prompt when every channel member already has workspace access", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "organization");
    await w.connectedMember(w.owner.orgId);
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("slack-artifact-channel-sharing-023 does not repeat private prompts for retries, refreshes, or composer events", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    const slackEvents = createBddIntegrationApi(context);
    const linkShared = {
      type: "link_shared",
      channel: CHANNEL,
      message_ts: MESSAGE_TS,
      user: w.slackUserId,
      links: [{ url: file.url, domain: new URL(file.url).hostname }],
    };
    await slackEvents.postSlackEvent(w.slackWorkspaceId, linkShared, {
      "x-slack-retry-num": "1",
    });
    await slackEvents.postSlackEvent(w.slackWorkspaceId, {
      ...linkShared,
      is_unfurl_refresh: true,
    });
    await slackEvents.postSlackEvent(w.slackWorkspaceId, {
      ...linkShared,
      source: "composer",
    });
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("slack-artifact-channel-sharing-003 omits workspace visibility for a workspace-visible file but still offers grants to external members", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "organization");
    await w.connectedMember(w.owner.orgId);
    w.emailMember();
    await w.postLink(file.url);
    expect(w.promptActions().actionIds).toStrictEqual([
      "artifact_share_channel",
      "artifact_share_public",
    ]);
    await w.click("artifact_share_channel");
    await expect(w.shareEmails(file)).resolves.toHaveLength(1);
    await expect(w.fileAudience(file)).resolves.toBe("organization");
  });

  it("slack-artifact-channel-sharing-006 does not prompt or read members for a public site and unfurls it", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "public");
    w.emailMember();
    await w.postLink(site.url);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    expect(context.mocks.slack.conversations.members).not.toHaveBeenCalled();
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${site.url}`);
  });

  it("slack-artifact-channel-sharing-008 does not let a connected non-owner manage another person's file", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const other = await w.connectedMember();
    await w.postLink(file.url, other.slackUserId);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
  });

  it("slack-artifact-channel-sharing-010 reports a member without email separately while sharing with identifiable members", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const anonymous = w.profileMember("no-email");
    w.emailMember();
    await w.postLink(file.url);
    await w.click("artifact_share_channel");
    await expect(w.shareEmails(file)).resolves.toHaveLength(1);
    const summary = w.callbacks.at(-1) ?? "";
    expect(summary).toContain(`<@${anonymous.id}>`);
    expect(summary).toContain("Could not finish sharing");
  });

  it("slack-artifact-channel-sharing-017 does not duplicate invitations when the same button is clicked again", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    await w.postLink(file.url);
    const { token } = w.promptActions();
    await w.click("artifact_share_channel", token);
    await w.click("artifact_share_channel", token);
    await expect(w.shareEmails(file)).resolves.toHaveLength(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(w.callbacks.at(-1)).toContain(
      "already have access or an invitation",
    );
  });

  it("slack-artifact-channel-sharing-020 can make a file workspace-visible from the owner prompt", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    await w.postLink(file.url);
    await w.click("artifact_share_organization");
    await expect(w.fileAudience(file)).resolves.toBe("organization");
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });

  it("slack-artifact-channel-sharing-022 can make a hosted site public and refresh the original Slack preview", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private");
    w.emailMember();
    await w.postLink(site.url);
    await w.click("artifact_share_public");
    const visibility = await accept(
      client(w.owner)(hostContract).siteVisibility({
        headers,
        params: { siteId: site.id },
      }),
      [200],
    );
    expect(visibility.body.visibility).toBe("public");
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${site.url}`);
  });

  it("slack-artifact-channel-sharing-024 shares a website through its App artifact reference", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private", "artifact");
    const member = w.emailMember();
    await w.postLink(site.url);
    await w.click("artifact_share_channel");
    await expect(w.shareEmails(site)).resolves.toStrictEqual([member.email]);
  });

  it("slack-artifact-channel-sharing-025 skips existing email invitations and ignores bots and deleted members", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const invited = w.emailMember();
    w.profileMember("bot");
    w.profileMember("deleted");
    await accept(
      client(w.owner)(artifactSharingContract).share({
        headers,
        params: { kind: "file", id: file.id },
        body: { email: invited.email },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    context.mocks.resend.send.mockClear();
    await w.postLink(file.url);
    // Since #50984 an unclaimed email invitation is reported as unconfirmed
    // access, so the owner still gets a prompt; bots and deleted users count
    // neither as missing nor as unconfirmed.
    expect(w.promptText()).toContain(
      "Access could not be confirmed for 1 member.",
    );
    expect(w.promptText()).not.toContain("need access");
    expect(context.mocks.resend.send).not.toHaveBeenCalled();
  });

  it("slack-artifact-channel-sharing-027 rechecks workspace membership before applying an old sharing button", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    await w.postLink(file.url);
    await store.set(
      deleteOrgMembership$,
      { orgId: w.owner.orgId, userId: w.owner.userId },
      context.signal,
    );
    await w.click("artifact_share_channel");
    expect(w.callbacks.at(-1)).toMatch(
      /no longer available|could not be verified/u,
    );
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
  });

  it("slack-artifact-channel-sharing-031 can make a file public and refresh its original preview", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    w.emailMember();
    await w.postLink(file.url);
    await w.click("artifact_share_public");
    await expect(w.fileAudience(file)).resolves.toBe("public");
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${file.url}`);
  });
});
