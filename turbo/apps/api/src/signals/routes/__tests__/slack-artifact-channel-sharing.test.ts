import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
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
import { artifactAccessRoutes } from "../artifact-access";
import { artifactReferenceRoutes } from "../artifact-references";
import { hostRoutes } from "../host";
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

const integrationApi = createBddIntegrationApi(context);
const appClient = setupApp({
  context,
  routes: [
    ...artifactAccessRoutes,
    ...artifactReferenceRoutes,
    ...hostRoutes,
    ...hostedSiteAccessRoutes,
    ...uploadsPrepareRoutes,
    ...uploadsCompleteRoutes,
  ],
});

function client(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return appClient;
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
  readonly reference: string | null;
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
      client(owner)(artifactAccessContract).updateVisibility({
        headers,
        params: { artifactId: prepared.body.id },
        body: { visibility: audience },
      }),
      [200],
    );
  }
  const url = new URL(completed.body.url, env("APP_URL"));
  return {
    kind: "file",
    id: prepared.body.id,
    url: url.href,
    reference: url.pathname.split("/").at(-1) ?? null,
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
  const prepared = await accept(
    client(owner)(hostContract).prepare({
      headers,
      body: {
        site: `share-${randomUUID().slice(0, 8)}`,
        title: "Channel report",
        artifactKind: "hosted-site",
        spaFallback: false,
        visibility,
        files: [hostedTextFile("/index.html", html)],
      },
    }),
    [200],
  );
  for (const key of stored.objects.keys()) {
    if (key.endsWith("/index.html")) {
      stored.objects.set(key, html);
    }
  }
  const completed = await accept(
    client(owner)(hostContract).complete({
      headers,
      params: { deploymentId: prepared.body.deploymentId },
      body: {},
    }),
    [200],
  );
  const url =
    link === "artifact"
      ? new URL(
          completed.body.artifactUrl ?? completed.body.url,
          env("APP_URL"),
        ).href
      : completed.body.url;
  return { kind: "site", id: prepared.body.siteId, url, reference: null };
}

/**
 * A Slack workspace installed and connected by its Okou admin, with artifact
 * email sharing enabled and the owner alone in the channel.
 */
async function workspace() {
  const slack = createPublicSlackOrgApi(context);
  const installed = await slack.installOrg({ withConnection: true });
  const owner: Owner = { ...installed.actor, orgId: installed.orgId };
  await Promise.all([
    store.set(
      seedOrgMembership$,
      { orgId: owner.orgId, userId: owner.userId, role: "admin" },
      context.signal,
    ),
    updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.ArtifactUserSharing]: true,
    }),
  ]);
  const accounts: ApiTestUser[] = [owner];
  directory(accounts);
  const stored = privateArtifactStorage();
  const members: string[] = [];
  /** Slack reports the channel membership at the time of each read. */
  function syncMembers() {
    context.mocks.slack.conversations.members.mockResolvedValue({
      ok: true,
      members: [...members],
      response_metadata: { next_cursor: "" },
    });
  }
  function join(id: string) {
    members.push(id);
    syncMembers();
  }
  function leave(id: string) {
    const index = members.indexOf(id);
    if (index !== -1) {
      members.splice(index, 1);
    }
    syncMembers();
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

  /** A member of the owner's workspace with a verified email and no Slack binding. */
  async function unboundColleague() {
    const user = createBddApi(context).user({
      orgId: owner.orgId,
      orgRole: "org:member",
    });
    await store.set(
      seedOrgMembership$,
      {
        orgId: owner.orgId,
        userId: user.userId,
        emailAddresses: [user.email],
      },
      context.signal,
    );
    accounts.push(user);
    directory(accounts);
    return user;
  }

  /** A Slack member whose email matches an unbound member of the owner's workspace. */
  async function workspaceEmailMember() {
    const colleague = await unboundColleague();
    return emailMember(colleague.email);
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
    const [, { slackUserId }] = await Promise.all([
      store.set(
        seedOrgMembership$,
        { orgId: userOrgId, userId: user.userId },
        context.signal,
      ),
      slack.connectMember({
        orgId: userOrgId,
        userId: user.userId,
        slackWorkspaceId: installed.slackWorkspaceId,
      }),
    ]);
    accounts.push(user);
    directory(accounts);
    join(slackUserId);
    return { ...user, slackUserId };
  }

  async function postLink(url: string, user = installed.slackUserId) {
    await integrationApi.postSlackEvent(installed.slackWorkspaceId, {
      type: "link_shared",
      channel: CHANNEL,
      message_ts: MESSAGE_TS,
      user,
      links: [{ url, domain: new URL(url).hostname }],
    });
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

  function promptRecipients(): string[] {
    return context.mocks.slack.chat.postEphemeral.mock.calls.map((call) => {
      return object({ user: string() }).parse(call[0]).user;
    });
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
    const body = await integrationApi.postSlackInteractive({
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
      client(owner)(artifactAccessContract).listShares({
        headers,
        params: { artifactId: artifact.id },
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
      client(owner)(artifactAccessContract).getVisibility({
        headers,
        params: { artifactId: artifact.id },
      }),
      [200],
    );
    return response.body.visibility;
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
    leave,
    emailMember,
    workspaceEmailMember,
    profileMember,
    unboundColleague,
    connectedMember,
    postLink,
    promptActions,
    promptRecipients,
    promptText,
    click,
    shareEmails,
    fileAudience,
    unfurledUrls,
  };
}

const ALL_ACTIONS = Object.freeze([
  "artifact_share_channel",
  "artifact_share_organization",
  "artifact_share_public",
]);

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

  it("slack-artifact-channel-sharing-005 recognizes existing workspace access by verified email without requiring a Slack account binding", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "organization");
    const colleague = await w.unboundColleague();
    w.emailMember(colleague.email);
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
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

  it("slack-artifact-channel-sharing-003 omits workspace visibility for a workspace-visible file and reports external email-only members as unresolved", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "organization");
    await w.connectedMember(w.owner.orgId);
    const external = w.emailMember();
    await w.postLink(file.url);
    expect(w.promptActions().actionIds).toStrictEqual([
      "artifact_share_channel",
      "artifact_share_public",
    ]);
    await w.click("artifact_share_channel");
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
    await expect(w.fileAudience(file)).resolves.toBe("organization");
    expect(w.callbacks.at(-1)).toContain(`<@${external.id}>`);
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
    await w.workspaceEmailMember();
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
    await w.workspaceEmailMember();
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
      client(w.owner)(artifactAccessContract).getVisibility({
        headers,
        params: { artifactId: site.id },
      }),
      [200],
    );
    expect(visibility.body.visibility).toBe("public");
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${site.url}`);
  });

  it("slack-artifact-channel-sharing-024 shares a website through its App artifact reference", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private", "artifact");
    const member = await w.workspaceEmailMember();
    await w.postLink(site.url);
    await w.click("artifact_share_channel");
    await expect(w.shareEmails(site)).resolves.toStrictEqual([member.email]);
  });

  it("slack-artifact-channel-sharing-025 skips already-granted workspace members and ignores bots and deleted members", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const invited = await w.workspaceEmailMember();
    w.profileMember("bot");
    w.profileMember("deleted");
    await accept(
      client(w.owner)(artifactAccessContract).addShare({
        headers,
        params: { artifactId: file.id },
        body: { email: invited.email },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    context.mocks.resend.send.mockClear();
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
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

  it("slack-artifact-channel-sharing-001 (1/3) privately prompts the file owner before any shares exist", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    await w.connectedMember();
    w.emailMember();

    await w.postLink(file.url);

    expect(w.promptRecipients()).toStrictEqual([w.slackUserId]);
    expect(w.promptActions()).toMatchObject({
      channel: CHANNEL,
      user: w.slackUserId,
      actionIds: [...ALL_ACTIONS],
    });
    await expect(w.shareEmails(file)).resolves.toStrictEqual([]);
  });

  it("slack-artifact-channel-sharing-001 (2/3) shares the file only with members present at click time", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const viewer = await w.connectedMember();
    const departed = await w.workspaceEmailMember();
    await w.postLink(file.url);

    w.leave(departed.id);
    const joined = await w.workspaceEmailMember();
    await w.click("artifact_share_channel");

    await expect(w.shareEmails(file)).resolves.toStrictEqual(
      [viewer.email, joined.email].sort(),
    );
    const resolved = await accept(
      client(viewer)(artifactReferencesContract).resolve({
        headers,
        params: { reference: file.reference ?? "" },
        query: {},
      }),
      [200],
    );
    expect(resolved.body.target).toStrictEqual({ kind: "file", id: file.id });
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    const summary = w.callbacks.at(-1) ?? "";
    expect(summary).toContain("2 current channel members");
    expect(summary).not.toContain(departed.email);
  });

  it("slack-artifact-channel-sharing-001 (3/3) does not unfurl or re-prompt missing access when reposting the shared file", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    await w.connectedMember();
    const departed = w.emailMember();
    await w.postLink(file.url);
    w.leave(departed.id);
    w.emailMember();
    await w.click("artifact_share_channel");

    // Since #50984 the joined member's unclaimed invitation keeps the
    // owner prompt open as unconfirmed access instead of staying silent.
    context.mocks.slack.chat.unfurl.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    expect(w.promptText()).toContain(
      "Access could not be confirmed for 1 member.",
    );
    expect(w.promptText()).not.toContain("need access");
  });

  it("slack-artifact-channel-sharing-002 (1/3) privately prompts the site owner before any shares exist", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private");
    await w.connectedMember();
    w.emailMember();

    await w.postLink(site.url);

    expect(w.promptRecipients()).toStrictEqual([w.slackUserId]);
    expect(w.promptActions()).toMatchObject({
      channel: CHANNEL,
      user: w.slackUserId,
      actionIds: [...ALL_ACTIONS],
    });
    await expect(w.shareEmails(site)).resolves.toStrictEqual([]);
  });

  it("slack-artifact-channel-sharing-002 (2/3) shares the site only with members present at click time", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private");
    const viewer = await w.connectedMember();
    const departed = await w.workspaceEmailMember();
    await w.postLink(site.url);

    w.leave(departed.id);
    const joined = await w.workspaceEmailMember();
    await w.click("artifact_share_channel");

    await expect(w.shareEmails(site)).resolves.toStrictEqual(
      [viewer.email, joined.email].sort(),
    );
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(2);
    const summary = w.callbacks.at(-1) ?? "";
    expect(summary).toContain("2 current channel members");
    expect(summary).not.toContain(departed.email);
  });

  it("slack-artifact-channel-sharing-002 (3/3) does not unfurl or re-prompt missing access when reposting the shared site", async () => {
    const w = await workspace();
    const site = await publishSite(w.owner, w.stored, "private");
    await w.connectedMember();
    const departed = w.emailMember();
    await w.postLink(site.url);
    w.leave(departed.id);
    w.emailMember();
    await w.click("artifact_share_channel");

    // Since #50984 the joined member's unclaimed invitation keeps the
    // owner prompt open as unconfirmed access instead of staying silent.
    context.mocks.slack.chat.unfurl.mockClear();
    context.mocks.slack.chat.postEphemeral.mockClear();
    await w.postLink(site.url);
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    expect(w.promptText()).toContain(
      "Access could not be confirmed for 1 member.",
    );
    expect(w.promptText()).not.toContain("need access");
  });

  it("pf-128 adds a restricted file preview after granting access to every connected member", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    const viewer = await w.connectedMember();
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();

    await w.click("artifact_share_channel");

    await expect(w.shareEmails(file)).resolves.toStrictEqual([viewer.email]);
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${file.url}`);
  });

  it("pf-130 refreshes the preview after making a file workspace-visible when every member belongs to that workspace", async () => {
    const w = await workspace();
    const file = await uploadFile(w.owner, "private");
    await w.connectedMember(w.owner.orgId);
    await w.postLink(file.url);
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();

    await w.click("artifact_share_organization");

    await expect(w.fileAudience(file)).resolves.toBe("organization");
    expect(w.unfurledUrls()).toContain(`${CHANNEL}/${MESSAGE_TS}/${file.url}`);
  });
});
