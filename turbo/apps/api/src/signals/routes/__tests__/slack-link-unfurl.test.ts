import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { describe, expect, it } from "vitest";
import {
  setupAppWithRoutes,
  setupRawAppRequestWithRoutes,
} from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactShareRoutes } from "../artifact-shares";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackEventsRoutes } from "../slack-events";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const host = createHostMapsBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const messageTs = "1791618140.315329";
const html =
  '<html><head><title>Report &amp; &lt;!channel&gt;&nbsp;&quot;标题&quot;</title><meta name="description" content="A public report"></head><body>Report</body></html>';
const previousBotScopes = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
].join(",");

async function fixture(
  options: {
    readonly scopes?: string;
    readonly enabled?: boolean;
    readonly privateArtifacts?: boolean;
  } = {},
) {
  integrations.configureSlackAppMocks();
  const user = createBddApi(context).user({ orgRole: "org:admin" });
  if (!user.orgId) {
    throw new Error("Expected an organization");
  }
  const actor = { ...user, orgId: user.orgId };
  const { teamId } = await integrations.installSlackWorkspace(actor, {
    botScopes: options.scopes ?? `${previousBotScopes},links:read,links:write`,
  });
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postMessage.mockClear();
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
  await updateFeatureSwitchesForUser(context, actor, {
    artifactPreviews: true,
    privateArtifacts: options.privateArtifacts ?? false,
    slackLinkUnfurls: options.enabled ?? true,
  });
  const capture = host.captureHostedSitesS3();
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((command, ...rest) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.startsWith("artifact-shares/") &&
      !capture.objects.has(command.input.Key)
    ) {
      return Promise.reject(
        Object.assign(new Error("No such object"), {
          name: "NoSuchKey",
        }),
      );
    }
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.endsWith("/index.html")
    ) {
      return Promise.resolve({
        Body: Readable.from([Buffer.from(html)]),
        ContentLength: Buffer.byteLength(html),
      });
    }
    return storage(command, ...rest);
  });
  const prepared = await host.prepareHostedSite(actor, {
    site: `slack-report-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", html)],
  });
  const completed = await host.completeHostedSite(actor, prepared.deploymentId);
  return { actor, teamId, prepared, completed };
}

function postLinks(
  teamId: string,
  urls: readonly string[],
  options: {
    readonly retry?: boolean;
    readonly event?: Record<string, unknown>;
    readonly invalidSignature?: boolean;
  } = {},
) {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event_id: "Ev_link_preview",
    event: {
      type: "link_shared",
      channel: "C_PREVIEW",
      user: "U_NOT_CONNECTED_TO_OKOU",
      is_bot_user_member: false,
      message_ts: messageTs,
      thread_ts: "1791618000.000001",
      links: urls.map((url) => {
        return { domain: "okou.app", url };
      }),
      ...options.event,
    },
  });
  return setupRawAppRequestWithRoutes({ context, routes: slackEventsRoutes })(
    "/api/webhooks/slack/events",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        ...integrations.signedSlackIngressHeaders(body),
        ...(options.retry ? { "x-slack-retry-num": "1" } : {}),
        ...(options.invalidSignature
          ? { "x-slack-signature": "v0=invalid" }
          : {}),
      },
    },
  );
}

describe("Slack artifact link previews", () => {
  it("adds only a divider, linked title and large image without requiring membership or an Okou user connection", async () => {
    const f = await fixture();
    const immutable = `https://dpl-${f.prepared.deploymentId}.okou.app/?source=slack&view=cover#cover|v1`;
    const alias = `https://${f.prepared.publicSlug}.okou.app/index.html`;
    await accept(postLinks(f.teamId, [immutable, alias, immutable]), [200]);
    await flushWaitUntilForTest();

    const cover = {
      type: "image",
      image_url: expect.stringContaining(
        `/api/artifact-og/image?kind=host&id=${f.prepared.deploymentId}&version=`,
      ),
      alt_text: 'Report & <!channel>\u00a0"标题"',
    };
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: {
        [immutable]: {
          blocks: [
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*<https://dpl-${f.prepared.deploymentId}.okou.app/?source=slack&amp;view=cover#cover%7Cv1|Report &amp; &lt;!channel&gt;\u00a0"标题">*`,
                verbatim: true,
              },
            },
            cover,
          ],
        },
        [alias]: {
          blocks: [
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*<${alias}|Report &amp; &lt;!channel&gt;\u00a0"标题">*`,
                verbatim: true,
              },
            },
            cover,
          ],
        },
      },
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(context.mocks.slack.createClient).toHaveBeenCalledWith(
      `xoxb-bdd-${f.teamId}`,
      expect.any(Object),
    );
  });

  it("processes redelivery against the same message and supports composer targets", async () => {
    const f = await fixture();
    const url = `https://dpl-${f.prepared.deploymentId}.okou.app/`;
    await accept(postLinks(f.teamId, [url]), [200]);
    await flushWaitUntilForTest();
    await accept(postLinks(f.teamId, [url], { retry: true }), [200]);
    await flushWaitUntilForTest();
    const [first, second] = context.mocks.slack.chat.unfurl.mock.calls;
    expect(first).toStrictEqual(second);
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledTimes(2);
    await accept(
      postLinks(f.teamId, [url], {
        event: {
          channel: "UNFURL",
          message_ts: "composer-target",
          source: "composer",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenLastCalledWith({
      channel: "UNFURL",
      ts: "composer-target",
      unfurls: { [url]: expect.any(Object) },
    });
  });

  it("ignores unsupported URLs without preventing a valid sibling preview", async () => {
    const f = await fixture();
    const url = `https://dpl-${f.prepared.deploymentId}.okou.app/`;
    await accept(
      postLinks(f.teamId, [
        "not a URL",
        "https://okou.app.evil.test/",
        "https://localhost/",
        "https://nested.alias.okou.app/",
        "https://dpl-invalid.okou.app/",
        "https://user:password@alias.okou.app/",
        "https://alias.okou.app:8080/",
        `${url}social-card.png`,
        `https://dpl-${randomUUID()}.okou.app/`,
        url,
      ]),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: { [url]: expect.any(Object) },
    });
  });

  it.each([
    { name: "old installation scopes", scopes: previousBotScopes },
    { name: "disabled workspace rollout", enabled: false },
  ])("leaves normal connections intact with $name", async (options) => {
    const f = await fixture(options);
    await accept(
      postLinks(f.teamId, [`https://dpl-${f.prepared.deploymentId}.okou.app/`]),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    createRouteMocks(context).clerk.session(
      f.actor.userId,
      f.actor.orgId,
      "org:admin",
    );
    const status = await accept(
      setupAppWithRoutes({ context, routes: integrationsSlackRoutes })(
        integrationsSlackContract,
      ).getStatus({ headers }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      scopeMismatch: options.name === "old installation scopes",
    });
    if (options.name === "old installation scopes") {
      expect(status.body.reinstallUrl).toStrictEqual(expect.any(String));
    }
  });

  it("requires public sharing for artifact references and honors revocation", async () => {
    const f = await fixture({ privateArtifacts: true });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            organization: { id: f.actor.orgId, name: "Preview test workspace" },
            publicUserData: { userId: f.actor.userId },
            role: "org:admin",
          },
        ],
      },
    );
    const shares = setupAppWithRoutes({ context, routes: artifactShareRoutes })(
      artifactSharesContract,
    );
    const uploads = setupAppWithRoutes({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
    const storage = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((command, ...rest) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: 13,
          ContentType: "image/png",
          Metadata: { "artifact-id": command.input.Key?.split("/")[1] },
        });
      }
      return storage(command, ...rest);
    });
    const prepared = await accept(
      uploads.preparePrivate({
        headers,
        body: {
          filename: "report.png",
          contentType: "image/png",
          size: 13,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      uploads.complete({ headers, body: { id: prepared.body.id } }),
      [200],
    );
    const target = { kind: "file" as const, id: completed.body.id };
    const privateUrl = new URL(completed.body.url, env("APP_URL")).href;
    await accept(postLinks(f.teamId, [privateUrl]), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();

    const organization = await accept(
      shares.update({ headers, body: { target, audience: "organization" } }),
      [200],
    );
    if (!organization.body.shortUrl) {
      throw new Error("Expected an organization share");
    }
    await accept(postLinks(f.teamId, [organization.body.shortUrl]), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();

    const published = await accept(
      shares.update({ headers, body: { target, audience: "public" } }),
      [200],
    );
    if (!published.body.url) {
      throw new Error("Expected a public sharing URL");
    }
    const urls = [privateUrl];
    await accept(postLinks(f.teamId, urls), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: Object.fromEntries(
        urls.map((url) => {
          return [
            url,
            {
              blocks: expect.arrayContaining([
                expect.objectContaining({ type: "image" }),
              ]),
            },
          ];
        }),
      ),
    });

    await accept(
      shares.update({ headers, body: { target, audience: "private" } }),
      [200],
    );
    context.mocks.slack.chat.unfurl.mockClear();
    await accept(postLinks(f.teamId, urls, { retry: true }), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });

  it("does not preview a deleted site or a cover whose owner disabled previews", async () => {
    const f = await fixture();
    const urls = [
      `https://dpl-${f.prepared.deploymentId}.okou.app/`,
      `https://${f.prepared.publicSlug}.okou.app/`,
    ];
    await updateFeatureSwitchesForUser(context, f.actor, {
      artifactPreviews: false,
    });
    await accept(postLinks(f.teamId, urls), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    await updateFeatureSwitchesForUser(context, f.actor, {
      artifactPreviews: true,
    });
    await host.deleteHostedSite(f.actor, f.prepared.publicSlug);
    await accept(postLinks(f.teamId, urls), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });

  it("verifies the webhook signature and link payload before acknowledging", async () => {
    integrations.configureSlackSigningSecret();
    await accept(postLinks("T_UNKNOWN", [], { invalidSignature: true }), [401]);
    await accept(
      postLinks("T_UNKNOWN", [], { event: { message_ts: null } }),
      [400],
    );
    await accept(postLinks("T_UNKNOWN", ["https://alias.okou.app/"]), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });
});
