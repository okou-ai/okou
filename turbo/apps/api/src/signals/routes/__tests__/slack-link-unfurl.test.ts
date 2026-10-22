import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  setupAppWithRoutes,
  setupRawAppRequestWithRoutes,
} from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
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
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const host = createHostMapsBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const messageTs = "1791618140.315329";
const authorSlackUserId = "U_LINK_SHARER";
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

function compactBrandImageUrl() {
  const brandUrl = new URL(ARTIFACT_OG_BRAND.imageUrl);
  return `${brandUrl.origin}/cdn-cgi/image/height=112,fit=scale-down,format=auto,quality=85,metadata=none${brandUrl.pathname}`;
}

function signedImageUrl(source: string) {
  return expect.stringContaining(
    `${env("OKOU_PUBLIC_ARTIFACTS_BASE_URL")}/cdn-cgi/image/width=320,height=112,fit=scale-down,format=auto,quality=85,metadata=none/${env("OKOU_API_BACKEND_URL")}/api/artifact-og/slack.png?${new URLSearchParams({ url: source })}&signature=`,
  );
}

async function fixture(
  options: {
    readonly scopes?: string;
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
    installerSlackUserId: authorSlackUserId,
  });
  await flushWaitUntilForTest();
  context.mocks.slack.chat.postMessage.mockClear();
  context.mocks.slack.chat.unfurl.mockResolvedValue({ ok: true });
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
  const pageRequests: Request[] = [];
  const publicPage = ({ request }: { readonly request: Request }) => {
    pageRequests.push(request);
    return HttpResponse.html(
      "<html><head></head><body>Public page</body></html>",
    );
  };
  server.use(
    http.get(`${new URL(env("APP_URL")).origin}/*`, publicPage),
    http.get(/^https:\/\/[^/]+\.okou\.app\//u, publicPage),
  );
  return { actor, teamId, prepared, completed, pageRequests };
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
      user: authorSlackUserId,
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

function sharing(actor: { readonly userId: string; readonly orgId: string }) {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: {
            id: actor.orgId,
            name: "Preview test workspace",
          },
          publicUserData: { userId: actor.userId },
          role: "org:admin",
        },
      ],
    },
  );
  return setupAppWithRoutes({ context, routes: artifactShareRoutes })(
    artifactSharesContract,
  );
}

describe("Slack link previews", () => {
  it("adds a divider, linked title and compact image without requiring membership or an Okou user connection", async () => {
    const f = await fixture();
    const immutable = `https://dpl-${f.prepared.deploymentId}.okou.app/?source=slack&view=cover#cover|v1`;
    const alias = `https://${f.prepared.publicSlug}.okou.app/index.html`;
    await accept(
      postLinks(f.teamId, [immutable, alias, immutable], {
        event: { user: "U_NOT_CONNECTED_TO_OKOU" },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    const cover = {
      type: "image",
      image_url: expect.stringMatching(
        new RegExp(
          `/cdn-cgi/image/width=320,height=112,[^/]+/https?://[^/]+/api/artifact-og/image\\?kind=host&id=${f.prepared.deploymentId}&version=`,
          "u",
        ),
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
    expect(f.pageRequests).toHaveLength(0);
    expect(context.mocks.slack.createClient).toHaveBeenCalledWith(
      `xoxb-bdd-${f.teamId}`,
      expect.any(Object),
    );
  });

  it("uses Open Graph for workspace members, unconnected sharers and events without an author", async () => {
    const f = await fixture();
    const pageUrl = new URL("/works", env("APP_URL")).href;
    const requests: string[] = [];
    server.use(
      http.get(pageUrl, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.html(
          '<head><meta property="og:title" content="Published title"><meta property="og:image" content="https://images.example.com/cover.png"></head>',
        );
      }),
    );
    const peer = createBddApi(context).user({
      orgId: f.actor.orgId,
      orgRole: "org:member",
    });
    const peerSlackUserId = "U_LINK_PEER";
    await integrations.connectSlackUser(peer, {
      workspaceId: f.teamId,
      slackUserId: peerSlackUserId,
    });
    const users = [
      peerSlackUserId,
      "U_NOT_CONNECTED_TO_OKOU",
      undefined,
      authorSlackUserId,
    ];
    for (const [index, user] of users.entries()) {
      context.mocks.slack.chat.unfurl.mockClear();
      await accept(postLinks(f.teamId, [pageUrl], { event: { user } }), [200]);
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
        channel: "C_PREVIEW",
        ts: messageTs,
        unfurls: {
          [pageUrl]: {
            blocks: [
              { type: "divider" },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*<${pageUrl}|Published title>*`,
                  verbatim: true,
                },
              },
              {
                type: "image",
                image_url: signedImageUrl(
                  "https://images.example.com/cover.png",
                ),
                alt_text: "Published title",
              },
            ],
          },
        },
      });
      expect(requests).toHaveLength(index + 1);
    }
  });

  it("uses compact branding when anonymous App pages provide no Open Graph metadata", async () => {
    const f = await fixture();
    await flushWaitUntilForTest();
    context.mocks.s3.send.mockClear();
    const origin = new URL(env("APP_URL")).origin;
    const chatUrl = `${origin}/chats/${randomUUID()}`;
    const pages = [
      { url: `${origin}/`, href: `${origin}/` },
      { url: `${origin}/works`, href: `${origin}/works` },
      { url: `${origin}/settings`, href: `${origin}/settings` },
      {
        url: `${chatUrl}?source=slack&view=cover#cover|v1`,
        href: `${chatUrl}?source=slack&amp;view=cover#cover%7Cv1`,
      },
    ];
    await accept(
      postLinks(
        f.teamId,
        pages.map(({ url }) => {
          return url;
        }),
      ),
      [200],
    );
    await flushWaitUntilForTest();

    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: Object.fromEntries(
        pages.map(({ url, href }) => {
          return [
            url,
            {
              blocks: [
                { type: "divider" },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*<${href}|${ARTIFACT_OG_BRAND.title}>*`,
                    verbatim: true,
                  },
                },
                {
                  type: "image",
                  image_url: compactBrandImageUrl(),
                  alt_text: ARTIFACT_OG_BRAND.title,
                },
              ],
            },
          ];
        }),
      ),
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(f.pageRequests).toHaveLength(pages.length);
    for (const request of f.pageRequests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
    }
  });

  it("reads Open Graph for non-artifact App, shared-thread and hosted subpages", async () => {
    const f = await fixture();
    const origin = new URL(env("APP_URL")).origin;
    const appUrl = `${origin}/works?source=slack&view=cover#cover|v1`;
    const hostedUrl = `https://${f.prepared.publicSlug}.okou.app/guides/launch.html`;
    const otherUrls = [
      `${origin}/share/threads/${randomUUID()}/`,
      `${origin}/future-feature/public-page`,
      `https://og-${randomUUID()}.okou.app/guides/launch.html`,
    ];
    const page =
      '<html><head><base href="/assets/"><meta property="og:title" content="Launch &amp; &lt;!channel&gt; 计划"><meta property="og:description" content="Public &amp; reviewed &lt;!channel&gt;"><meta property="og:image" content="cover.png?x=1&amp;y=2"></head><body>Page</body></html>';
    server.use(
      http.get(`${origin}/works`, () => {
        return HttpResponse.html(page);
      }),
      http.get(hostedUrl, () => {
        return HttpResponse.html(page);
      }),
      ...otherUrls.map((url) => {
        return http.get(url, () => {
          return HttpResponse.html(page);
        });
      }),
    );
    await flushWaitUntilForTest();
    context.mocks.s3.send.mockClear();
    await accept(postLinks(f.teamId, [appUrl, hostedUrl, ...otherUrls]), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: Object.fromEntries(
        [
          {
            url: appUrl,
            href: `${origin}/works?source=slack&amp;view=cover#cover%7Cv1`,
          },
          { url: hostedUrl, href: hostedUrl },
          ...otherUrls.map((url) => {
            return { url, href: url };
          }),
        ].map(({ url, href }) => {
          return [
            url,
            {
              blocks: [
                { type: "divider" },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*<${href}|Launch &amp; &lt;!channel&gt; 计划>*`,
                    verbatim: true,
                  },
                },
                {
                  type: "section",
                  text: {
                    type: "plain_text",
                    text: "Public & reviewed <!channel>",
                    emoji: false,
                  },
                },
                {
                  type: "image",
                  image_url: signedImageUrl(
                    new URL("/assets/cover.png?x=1&y=2", url).href,
                  ),
                  alt_text: "Launch & <!channel> 计划",
                },
              ],
            },
          ];
        }),
      ),
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("uses partial Open Graph metadata for non-artifact pages", async () => {
    const f = await fixture();
    const origin = `https://og-${randomUUID()}.okou.app`;
    const artifactImageUrl = `${env("OKOU_API_BACKEND_URL")}/api/artifact-og/image?kind=host&id=${f.prepared.deploymentId}&version=v1`;
    const fields = [
      {
        property: "og:title",
        value: "Public title",
        image: ARTIFACT_OG_BRAND.imageUrl,
      },
      {
        property: "og:description",
        value: "Public description",
        image: ARTIFACT_OG_BRAND.imageUrl,
      },
      {
        property: "og:image",
        value: "https://images.example.com/cover.png",
        image: "https://images.example.com/cover.png",
      },
      {
        property: "og:image",
        value: artifactImageUrl,
        image: artifactImageUrl,
      },
    ];
    for (const [index, field] of fields.entries()) {
      server.use(
        http.get(`${origin}/pages/${index}`, () => {
          return HttpResponse.html(
            `<head><meta property="${field.property}" content="${field.value}"></head>`,
          );
        }),
      );
    }
    await accept(
      postLinks(
        f.teamId,
        fields.map((_, index) => {
          return `${origin}/pages/${index}`;
        }),
      ),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: Object.fromEntries(
        fields.map((field, index) => {
          const url = `${origin}/pages/${index}`;
          const title = field.property === "og:title" ? field.value : "Okou";
          return [
            url,
            {
              blocks: [
                { type: "divider" },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*<${url}|${title}>*`,
                    verbatim: true,
                  },
                },
                ...(field.property === "og:description"
                  ? [
                      {
                        type: "section",
                        text: {
                          type: "plain_text",
                          text: field.value,
                          emoji: false,
                        },
                      },
                    ]
                  : []),
                {
                  type: "image",
                  image_url: signedImageUrl(field.image),
                  alt_text: title,
                },
              ],
            },
          ];
        }),
      ),
    });
  });

  it("skips failed, non-HTML, redirected and oversized pages without losing valid sibling previews", async () => {
    const f = await fixture();
    const origin = new URL(env("APP_URL")).origin;
    const redirectedRequests: string[] = [];
    server.use(
      http.get("http://127.0.0.1/private", ({ request }) => {
        redirectedRequests.push(request.url);
        return HttpResponse.html(
          '<head><meta property="og:title" content="Internal page"></head>',
        );
      }),
      http.get(`${origin}/missing`, () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.get(`${origin}/share/threads/:id`, () => {
        return HttpResponse.html(
          '<head><meta property="og:title" content="Revoked share"></head>',
          { status: 404 },
        );
      }),
      http.get(`${origin}/private`, () => {
        return new HttpResponse(null, { status: 403 });
      }),
      http.get(`${origin}/offline`, () => {
        return HttpResponse.error();
      }),
      http.get(`${origin}/file`, () => {
        return HttpResponse.json({ title: "Not page metadata" });
      }),
      http.get(`${origin}/redirect`, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      }),
      http.get(`${origin}/large`, () => {
        return HttpResponse.html("x".repeat(4 * 1024 * 1024 + 1));
      }),
    );
    const valid = `${origin}/works`;
    await accept(
      postLinks(
        f.teamId,
        [
          "missing",
          `share/threads/${randomUUID()}`,
          "private",
          "offline",
          "file",
          "redirect",
          "large",
          "works",
        ].map((path) => {
          return `${origin}/${path}`;
        }),
      ),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: { [valid]: expect.any(Object) },
    });
    expect(redirectedRequests).toStrictEqual([]);
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

  it("skips unsupported or unavailable links without losing artifact and App previews", async () => {
    const f = await fixture();
    const url = `https://dpl-${f.prepared.deploymentId}.okou.app/`;
    const appUrl = new URL("/works", env("APP_URL")).href;
    const missingArtifactUrl = new URL(
      `/artifacts/${"0".repeat(32)}.png`,
      env("APP_URL"),
    ).href;
    const lookalike = new URL("/works", env("APP_URL"));
    lookalike.hostname += ".evil.test";
    const credentialed = new URL("/chats/private", env("APP_URL"));
    credentialed.username = "user";
    credentialed.password = "password";
    const otherPort = new URL("/works", env("APP_URL"));
    otherPort.port = otherPort.port === "8080" ? "8081" : "8080";
    await accept(
      postLinks(f.teamId, [
        "not a URL",
        "https://okou.app.evil.test/",
        "https://localhost/",
        "https://nested.alias.okou.app/",
        "https://dpl-invalid.okou.app/",
        "https://user:password@alias.okou.app/",
        "https://alias.okou.app:8080/",
        lookalike.href,
        credentialed.href,
        otherPort.href,
        `${url}social-card.png`,
        `https://dpl-${randomUUID()}.okou.app/`,
        missingArtifactUrl,
        url,
        appUrl,
      ]),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
      channel: "C_PREVIEW",
      ts: messageTs,
      unfurls: {
        [url]: expect.any(Object),
        [appUrl]: {
          blocks: expect.arrayContaining([
            {
              type: "image",
              image_url: compactBrandImageUrl(),
              alt_text: ARTIFACT_OG_BRAND.title,
            },
          ]),
        },
      },
    });
  });

  it("leaves normal connections intact with old installation scopes", async () => {
    const f = await fixture({ scopes: previousBotScopes });
    await accept(
      postLinks(f.teamId, [
        `https://dpl-${f.prepared.deploymentId}.okou.app/`,
        new URL("/works", env("APP_URL")).href,
      ]),
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
      scopeMismatch: true,
    });
    expect(status.body.reinstallUrl).toStrictEqual(expect.any(String));
  });

  it.each([
    {
      pageMetadata: "none",
      filename: "report.png",
      contentType: "image/png",
    },
    {
      pageMetadata: "brand",
      filename: "report.png",
      contentType: "image/png",
    },
    {
      pageMetadata: "artifact",
      filename: "report.png",
      contentType: "image/png",
    },
    {
      pageMetadata: "brand",
      filename: "report.pdf",
      contentType: "application/pdf",
    },
    {
      pageMetadata: "artifact",
      filename: "report.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      pageMetadata: "brand",
      filename: "report.html",
      contentType: "text/html",
    },
  ])(
    "preserves sharing for $filename with $pageMetadata page metadata",
    async ({ pageMetadata, filename, contentType }) => {
      const f = await fixture();
      const pageTitle =
        pageMetadata === "brand" ? "Okou branding" : "Published image title";
      const pageImage =
        pageMetadata === "brand"
          ? ARTIFACT_OG_BRAND.imageUrl
          : "https://images.example.com/published-image.png";
      if (pageMetadata !== "none") {
        server.use(
          http.get(
            `${new URL(env("APP_URL")).origin}/artifacts/:reference`,
            ({ request }) => {
              f.pageRequests.push(request);
              // A shell or cached OG response alone does not establish public access.
              return HttpResponse.html(
                `<head><meta property="og:title" content="${pageTitle}"><meta property="og:image" content="${pageImage}"></head>`,
              );
            },
          ),
        );
      }
      const shares = sharing(f.actor);
      const uploads = setupAppWithRoutes({
        context,
        routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
      })(uploadsContract);
      const storage = context.mocks.s3.send.getMockImplementation()!;
      context.mocks.s3.send.mockImplementation((command, ...rest) => {
        if (command instanceof HeadObjectCommand) {
          return Promise.resolve({
            ContentLength: 13,
            ContentType: contentType,
            Metadata: { "artifact-id": command.input.Key?.split("/")[1] },
          });
        }
        return storage(command, ...rest);
      });
      const prepared = await accept(
        uploads.preparePrivate({
          headers,
          body: {
            filename,
            contentType,
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
      const missingUrl = new URL(
        artifactReferencePath(randomUUID(), filename),
        env("APP_URL"),
      ).href;
      const urls = [
        privateUrl,
        `${privateUrl}?source=slack#preview`,
        new URL(
          artifactReferencePath(completed.body.id, filename),
          env("APP_URL"),
        ).href,
      ];
      await accept(postLinks(f.teamId, [...urls, missingUrl]), [200]);
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
      expect(f.pageRequests).toHaveLength(0);

      const organization = await accept(
        shares.update({ headers, body: { target, audience: "organization" } }),
        [200],
      );
      if (!organization.body.shortUrl) {
        throw new Error("Expected an organization share");
      }
      await accept(
        postLinks(f.teamId, [...urls, organization.body.shortUrl]),
        [200],
      );
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
      expect(f.pageRequests).toHaveLength(0);

      const published = await accept(
        shares.update({ headers, body: { target, audience: "public" } }),
        [200],
      );
      if (!published.body.url) {
        throw new Error("Expected a public sharing URL");
      }
      const publicUrls = [...new Set([...urls, organization.body.shortUrl])];
      await accept(postLinks(f.teamId, [...publicUrls, missingUrl]), [200]);
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.unfurl).toHaveBeenCalledExactlyOnceWith({
        channel: "C_PREVIEW",
        ts: messageTs,
        unfurls: Object.fromEntries(
          publicUrls.map((url) => {
            return [
              url,
              {
                blocks: expect.arrayContaining([
                  expect.objectContaining({
                    type: "image",
                    image_url: expect.stringContaining(
                      "/api/artifact-og/image?kind=reference&id=",
                    ),
                    alt_text: filename,
                  }),
                ]),
              },
            ];
          }),
        ),
      });
      expect(f.pageRequests).toHaveLength(0);

      await accept(
        shares.update({ headers, body: { target, audience: "private" } }),
        [200],
      );
      context.mocks.slack.chat.unfurl.mockClear();
      await accept(postLinks(f.teamId, publicUrls, { retry: true }), [200]);
      await flushWaitUntilForTest();
      expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
      expect(f.pageRequests).toHaveLength(0);
    },
  );

  it("keeps public hosted artifact metadata instead of page Open Graph", async () => {
    const f = await fixture();
    const urls = [
      `https://dpl-${f.prepared.deploymentId}.okou.app/`,
      `https://${f.prepared.publicSlug}.okou.app/`,
      `https://${f.prepared.publicSlug}.okou.app/index.html`,
    ];
    server.use(
      http.get(/^https:\/\/[^/]+\.okou\.app\//u, ({ request }) => {
        f.pageRequests.push(request);
        return HttpResponse.html(
          '<head><meta property="og:title" content="Different page title"><meta property="og:image" content="https://images.example.com/page.png"></head>',
        );
      }),
    );
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
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*<${url}|Report &amp; &lt;!channel&gt;\u00a0"标题">*`,
                    verbatim: true,
                  },
                },
                {
                  type: "image",
                  image_url: expect.stringMatching(
                    new RegExp(
                      `/cdn-cgi/image/width=320,height=112,[^/]+/https?://[^/]+/api/artifact-og/image\\?kind=host&id=${f.prepared.deploymentId}&version=`,
                      "u",
                    ),
                  ),
                  alt_text: 'Report & <!channel>\u00a0"标题"',
                },
              ]),
            },
          ];
        }),
      ),
    });
    expect(f.pageRequests).toHaveLength(0);
  });

  it("does not preview a deleted site", async () => {
    const f = await fixture();
    const urls = [
      `https://dpl-${f.prepared.deploymentId}.okou.app/`,
      `https://${f.prepared.publicSlug}.okou.app/`,
    ];
    await host.deleteHostedSite(f.actor, f.prepared.publicSlug);
    await accept(postLinks(f.teamId, urls), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
    expect(f.pageRequests).toHaveLength(0);
  });

  it("verifies the webhook signature and link payload before acknowledging", async () => {
    integrations.configureSlackSigningSecret();
    await accept(postLinks("T_UNKNOWN", [], { invalidSignature: true }), [401]);
    await accept(postLinks("T_UNKNOWN", ["https://alias.okou.app/"]), [200]);
    await flushWaitUntilForTest();
    expect(context.mocks.slack.chat.unfurl).not.toHaveBeenCalled();
  });
});
